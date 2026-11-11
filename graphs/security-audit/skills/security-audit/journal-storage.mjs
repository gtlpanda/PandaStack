// Linux/WSL private leaf, retained directory descriptors and a nonrecoverable
// exclusive lease. Same-user hostile replacement and crash takeover are outside
// this primitive. Never chmod or adopt an unsafe existing entry.
import { constants, openSync, closeSync, mkdirSync, lstatSync, fstatSync, fsyncSync,
  readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fail, need, guarded } from './journal-data.mjs'
import { CONTROL_SCHEMA } from './journal-control.mjs'

const FILE = 'journal.sqlite', LOCK = 'owner.lock', APP_ID = 0x53414a31
const SCHEMA = [
  'CREATE TABLE header (singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL, invocation_limit INTEGER NOT NULL) STRICT',
  'CREATE TABLE attempts (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, input TEXT NOT NULL, state TEXT NOT NULL, result TEXT) STRICT',
]
const anchor = fd => `/proc/self/fd/${fd}`
const same = (a, b) => a.dev === b.dev && a.ino === b.ino
const privateMode = (s, mode) => s.uid === process.getuid() && (s.mode & 0o7777) === mode
const stat = path => { try { return lstatSync(path) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }

export function openStorage(runDir, write, initialize) {
  return guarded(() => {
    const fds = []
    let db, leaseFd, leaseIdentity, nonce, dirFd, databaseIdentity, closed = false, leaseReady = false
    const retain = path => {
      need(stat(path)?.isDirectory())
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      fds.push(fd); return fd
    }
    function release() {
      if (closed) return
      let failure
      try { db?.close() } catch (e) { failure = e }
      if (leaseFd !== undefined) {
        try {
          const path = `${anchor(dirFd)}/${LOCK}`, current = stat(path)
          need(current?.isFile() && same(current, leaseIdentity) && same(fstatSync(leaseFd), leaseIdentity))
          if (leaseReady) need(current.size === nonce.length && readFileSync(path, 'utf8') === nonce)
          unlinkSync(path); fsyncSync(dirFd)
        } catch (e) { failure ??= e }
        try { closeSync(leaseFd) } catch (e) { failure ??= e }
      }
      for (const fd of fds.reverse()) { try { closeSync(fd) } catch (e) { failure ??= e } }
      closed = true
      if (failure) throw failure
    }
    try {
      need(process.platform === 'linux' && typeof process.getuid === 'function', 'IO_ERROR')
      let parent = retain('/')
      for (const part of resolve(runDir).split('/').filter(Boolean)) parent = retain(`${anchor(parent)}/${part}`)
      const directory = `${anchor(parent)}/native-dispatch`
      if (!stat(directory)) {
        if (!write) fail('NOT_FOUND')
        mkdirSync(directory, { mode: 0o700 }); fsyncSync(parent)
      }
      dirFd = retain(directory)
      need(privateMode(fstatSync(dirFd), 0o700))
      const path = `${anchor(dirFd)}/${FILE}`, lockPath = `${anchor(dirFd)}/${LOCK}`
      function checkFiles(allowMissing = false) {
        need(privateMode(fstatSync(dirFd), 0o700))
        const allowed = [FILE, `${FILE}-journal`, `${FILE}-wal`, `${FILE}-shm`, LOCK]
        need(readdirSync(anchor(dirFd)).every(name => allowed.includes(name)))
        for (const name of allowed) {
          const s = stat(`${anchor(dirFd)}/${name}`)
          if (!s) { if (name === FILE && !allowMissing) fail('CORRUPT'); continue }
          need(s.isFile() && privateMode(s, 0o600) && s.nlink === 1)
          if (name === FILE && databaseIdentity) need(same(s, databaseIdentity))
        }
      }
      checkFiles(true)
      if (write) {
        try { leaseFd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
        catch (e) { if (e.code === 'EEXIST') fail('OWNER_BUSY'); throw e }
        leaseIdentity = fstatSync(leaseFd)
        nonce = randomUUID()
        writeFileSync(leaseFd, nonce); leaseReady = true
        fsyncSync(leaseFd); fsyncSync(dirFd)
      }
      let created = false
      if (!stat(path)) {
        if (!write) fail('NOT_FOUND')
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { fsyncSync(fd) } finally { closeSync(fd) }
        fsyncSync(dirFd); created = true
      }
      checkFiles(); databaseIdentity = lstatSync(path)
      db = new DatabaseSync(path, { readOnly: !write, enableDoubleQuotedStringLiterals: false, allowExtension: false })
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000')
      if (write) db.exec('PRAGMA synchronous=EXTRA')
      need(db.prepare('PRAGMA journal_mode').get().journal_mode === 'delete')
      const schema = () => {
        need(db.prepare('PRAGMA application_id').get().application_id === APP_ID)
        const version = db.prepare('PRAGMA user_version').get().user_version
        need(version === 1 || version === 2)
        const rows = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
        const expected = version === 1 ? [SCHEMA[1], SCHEMA[0]] : [SCHEMA[1], ...CONTROL_SCHEMA, SCHEMA[0]]
        need(rows.length === expected.length && rows.every((r, i) => r.sql === expected[i]))
      }
      function transaction(mutating, work, initial = false) {
        return guarded(() => {
          need(!closed, 'CLOSED'); checkFiles()
          if (mutating) {
            need(write, 'IO_ERROR')
            const s = stat(lockPath)
            need(s?.isFile() && same(s, leaseIdentity) && s.size === nonce.length && readFileSync(lockPath, 'utf8') === nonce)
          }
          db.exec(mutating ? 'BEGIN IMMEDIATE' : 'BEGIN')
          try {
            if (!initial) schema()
            const result = work(db)
            checkFiles(); db.exec('COMMIT')
            if (mutating) fsyncSync(dirFd)
            return result
          } catch (e) {
            try { db.exec('ROLLBACK') } catch { /* The original failure controls the result. */ }
            throw e
          }
        })
      }
      if (created) transaction(true, () => {
        db.exec(SCHEMA.join(';'))
        db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=1`)
        initialize(db)
      }, true)
      schema()
      return { transaction, close: () => guarded(release) }
    } catch (e) {
      try { release() } catch { /* Preserve the original safe failure. */ }
      throw e
    }
  })
}
