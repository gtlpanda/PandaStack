import { constants, openSync, closeSync, mkdirSync, fstatSync, lstatSync, fsyncSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { validId } from './records.mjs'

export const queueError = code => Object.assign(new Error(`Decision queue: ${code}`), { code })
const codes = new Set(['INVALID_DECISION', 'CONFLICT', 'NOT_FOUND', 'WRONG_RECIPIENT', 'STALE',
  'EXPIRED', 'CANCELLED', 'NOT_READY', 'CORRUPT', 'IO_ERROR', 'MANUAL_HANDOFF'])
export function guarded(work) {
  try { return work() } catch (error) {
    const code = codes.has(error?.code) ? error.code : [11, 26].includes(error?.errcode & 255) ? 'CORRUPT' : 'IO_ERROR'
    throw queueError(code)
  }
}
const requireStorage = condition => { if (!condition) throw queueError('CORRUPT') }
const anchor = fd => `/proc/self/fd/${fd}`
const privateMode = (info, mode) => info.uid === process.getuid() && (info.mode & 0o7777) === mode
const FILE = 'decisions.sqlite'
const APP_ID = 0x50445131
const SCHEMA = [
  'CREATE TABLE queue_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, namespace TEXT NOT NULL) STRICT',
  'CREATE TABLE decisions (id TEXT PRIMARY KEY NOT NULL, snapshot TEXT NOT NULL) STRICT',
]

// Linux/WSL local POSIX filesystems only. Traverse without symlinks and retain
// descriptors until close. Shared parents are allowed; the 0700 leaf and same
// OS user are the trust boundary. SQLite may canonicalize its filename internally;
// this does not promise protection from hostile replacement by that trusted user.
function retainDirectory(directory, descriptors) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' ||
      typeof directory !== 'string' || !directory.length || directory.includes('\0')) throw queueError('IO_ERROR')
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  const retain = path => {
    const fd = openSync(path, flags); descriptors.push(fd)
    requireStorage(fstatSync(fd).isDirectory())
    return fd
  }
  let fd = retain('/')
  const probe = retain(`${anchor(fd)}/.`)
  const a = fstatSync(fd), b = fstatSync(probe)
  requireStorage(a.ino === b.ino && a.dev === b.dev)
  const parts = resolve(directory).split('/').filter(Boolean)
  for (const part of parts) {
    const path = `${anchor(fd)}/${part}`
    let next
    try { next = retain(path) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      try { mkdirSync(path, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      next = retain(path)
    }
    // Also sync existing parents after a concurrent/interrupted creator.
    fsyncSync(fd)
    fd = next
  }
  requireStorage(privateMode(fstatSync(fd), 0o700))
  return fd
}

export function openQueueStorage(directory) {
  return guarded(() => {
    const descriptors = []
    let db, closed = false, dbIdentity
    function cleanup() {
      if (closed) return
      closed = true
      let failure
      try { db?.close() } catch (error) { failure = error }
      for (const fd of descriptors.reverse()) {
        try { closeSync(fd) } catch (error) { failure ??= error }
      }
      if (failure) throw failure
    }
    try {
      const directoryFd = retainDirectory(directory, descriptors)
      const path = `${anchor(directoryFd)}/${FILE}`
      function checkFiles(allowMissingDatabase = false) {
        requireStorage(privateMode(fstatSync(directoryFd), 0o700))
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          let info
          try { info = lstatSync(path + suffix) } catch (error) {
            if (error.code === 'ENOENT' && (suffix || allowMissingDatabase)) continue
            throw error
          }
          requireStorage(info.isFile() && privateMode(info, 0o600) && info.nlink === 1)
          if (!suffix && dbIdentity) requireStorage(info.dev === dbIdentity.dev && info.ino === dbIdentity.ino)
        }
      }
      // Exclusive creation never truncates an existing file. A zero-length file
      // is a recoverable initializer interrupted before its schema transaction.
      checkFiles(true)
      let fileFd
      try {
        fileFd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        fsyncSync(fileFd)
      } catch (error) { if (error.code !== 'EEXIST') throw error }
      finally { if (fileFd !== undefined) closeSync(fileFd) }
      checkFiles()
      dbIdentity = lstatSync(path)
      fsyncSync(directoryFd)
      db = new DatabaseSync(path, { enableDoubleQuotedStringLiterals: false, allowExtension: false })
      db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA synchronous=EXTRA')
      // Refuse unsupported recovery modes before any schema transaction.
      requireStorage(db.prepare('PRAGMA journal_mode').get().journal_mode === 'delete')
      function metadata() {
        requireStorage(db.prepare('PRAGMA user_version').get().user_version === 1)
        requireStorage(db.prepare('PRAGMA application_id').get().application_id === APP_ID)
        const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
        requireStorage(schema.length === 2 && schema[0].sql === SCHEMA[1] && schema[1].sql === SCHEMA[0])
        const rows = db.prepare('SELECT singleton, version, namespace FROM queue_metadata').all()
        requireStorage(rows.length === 1 && rows[0].singleton === 1 && rows[0].version === 1 && validId(rows[0].namespace))
        return rows[0].namespace
      }
      function transaction(write, work, initializing = false) {
        return guarded(() => {
          if (closed) throw queueError('IO_ERROR')
          checkFiles()
          db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
          try {
            if (!initializing) metadata()
            const value = work(db)
            checkFiles()
            db.exec('COMMIT')
            // EXTRA syncs rollback-journal deletion. Sync the leaf as well so
            // initial database publication has the same durable boundary.
            if (write) fsyncSync(directoryFd)
            return value
          } catch (error) {
            try { db.exec('ROLLBACK') } catch { /* Preserve original failure. */ }
            throw error
          }
        })
      }
      transaction(true, () => {
        const version = db.prepare('PRAGMA user_version').get().user_version
        const app = db.prepare('PRAGMA application_id').get().application_id
        const objects = db.prepare('SELECT name FROM sqlite_schema').all()
        if (version === 0 && app === 0 && objects.length === 0) {
          requireStorage(dbIdentity.size === 0)
          db.exec(SCHEMA.join(';'))
          db.prepare('INSERT INTO queue_metadata VALUES (1, 1, ?)').run(randomUUID())
          db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=1`)
        }
        metadata()
        requireStorage(db.prepare('PRAGMA quick_check').get().quick_check === 'ok')
      }, true)
      return { transaction, namespace: () => transaction(false, metadata), close: () => guarded(cleanup) }
    } catch (error) {
      try { cleanup() } catch { /* Opening failure remains primary. */ }
      throw error
    }
  })
}
