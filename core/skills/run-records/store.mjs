import { constants, mkdirSync, openSync, closeSync, fstatSync,
  readFileSync, writeFileSync, fsyncSync, linkSync, unlinkSync, readdirSync } from 'node:fs'
import { resolve, parse, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { validateRun, validateEvent } from './records.mjs'

const error = code => Object.assign(new Error(`Run store: ${code}`), { code })
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)
function checkId(value) { if (!validId(value)) throw error('INVALID_RECORD') }
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const byId = (a, b) => compare(a.id, b.id)
function byEventTime(a, b) {
  const seconds = compare(a.at.slice(0, 19), b.at.slice(0, 19))
  // Preserve sub-millisecond precision accepted by the record contract.
  const fraction = at => at.slice(19, -1).replace(/^\./, '').replace(/0+$/, '')
  return seconds || compare(fraction(a.at), fraction(b.at)) || byId(a, b)
}
const codes = new Set(['INVALID_RECORD', 'CONFLICT', 'NOT_FOUND', 'CORRUPT', 'IO_ERROR'])
function guarded(work) {
  try { return work() } catch (e) {
    throw error(codes.has(e.code) ? e.code : 'IO_ERROR')
  }
}

// Linux/WSL procfs anchors keep every lookup relative to a retained directory.
// There is deliberately no fallback to check-then-reopen pathname operations.
function withDirectory(path, create, work) {
  const descriptors = []
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  const retain = name => {
    let fd
    try { fd = openSync(name, flags) } catch (e) {
      if (e.code === 'ELOOP' || e.code === 'ENOTDIR') throw error('CORRUPT')
      throw e
    }
    descriptors.push(fd)
    if (!fstatSync(fd).isDirectory()) throw error('CORRUPT')
    return fd
  }
  try {
    if (process.platform !== 'linux') throw error('IO_ERROR')
    const root = parse(path).root
    let fd = retain(root)
    // Verify procfs resolves our descriptor before any mutation.
    const anchor = fd => `/proc/self/fd/${fd}`
    const probe = retain(`${anchor(fd)}/.`)
    const original = fstatSync(fd), resolved = fstatSync(probe)
    if (original.dev !== resolved.dev || original.ino !== resolved.ino) throw error('IO_ERROR')
    for (const part of path.slice(root.length).split('/').filter(Boolean)) {
      const child = `${anchor(fd)}/${part}`
      let next
      try { next = retain(child) } catch (e) {
        if (e.code !== 'ENOENT') throw e
        if (!create) return work(null, null)
        try { mkdirSync(child, { mode: 0o700 }) } catch (e) {
          if (e.code !== 'EEXIST') throw e
        }
        next = retain(child)
      }
      // Sync even existing parents on writes: a prior interrupted mkdir or a
      // concurrent creator must not let this operation acknowledge an unsynced tree.
      if (create) fsyncSync(fd)
      fd = next
    }
    return work(anchor(fd), fd)
  } finally {
    let failure
    for (const fd of descriptors.reverse()) {
      try { closeSync(fd) } catch (e) { failure ??= e }
    }
    if (failure) throw failure
  }
}

function read(path, validate, expected) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    if (e.code === 'ELOOP') throw error('CORRUPT')
    throw e
  }
  try {
    if (!fstatSync(fd).isFile()) throw error('CORRUPT')
    // Operational failures belong to guarded()'s IO_ERROR normalization.
    const content = readFileSync(fd, 'utf8')
    let value
    try { value = JSON.parse(content) } catch { throw error('CORRUPT') }
    if (validate(value).length || Object.entries(expected).some(([key, v]) => value[key] !== v)) {
      throw error('CORRUPT')
    }
    return value
  } finally { closeSync(fd) }
}

function snapshot(input, validate) {
  if (validate(input).length) throw error('INVALID_RECORD')
  try {
    const value = JSON.parse(JSON.stringify(input))
    if (validate(value).length || !isDeepStrictEqual(value, input)) throw error('INVALID_RECORD')
    return value
  } catch { throw error('INVALID_RECORD') }
}

function publish(dir, value, validate, expected) {
  return withDirectory(dir, true, (dir, dirFd) => {
    const target = join(dir, `${value.id}.json`)
    const replay = () => {
      const existing = read(target, validate, expected)
      if (!isDeepStrictEqual(existing, value)) throw error('CONFLICT')
      fsyncSync(dirFd)
      return { created: false }
    }
    if (read(target, validate, expected) !== null) return replay()
    const temp = join(dir, `.tmp-${randomUUID()}`)
    let fd
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      writeFileSync(fd, JSON.stringify(value) + '\n')
      fsyncSync(fd)
      // close may release the descriptor before reporting an error; never retry it.
      const closing = fd
      fd = undefined
      closeSync(closing)
      // link is exclusive across processes, and publishes only complete bytes.
      try { linkSync(temp, target) } catch (e) {
        if (e.code === 'EEXIST') return replay()
        throw e
      }
      fsyncSync(dirFd)
      return { created: true }
    } finally {
      try {
        if (fd !== undefined) closeSync(fd)
      } finally {
        // Removal is independent of descriptor cleanup, including a failed close.
        try { unlinkSync(temp) } catch (e) { if (e.code !== 'ENOENT') throw e }
      }
    }
  })
}

function records(dir, validate, expected = {}) {
  return withDirectory(dir, false, dir => {
    if (dir === null) return []
    return readdirSync(dir).filter(name => !name.startsWith('.tmp-')).map(name => {
      if (!name.endsWith('.json') || !validId(name.slice(0, -5))) throw error('CORRUPT')
      const value = read(join(dir, name), validate, { ...expected, id: name.slice(0, -5) })
      if (value === null) throw error('CORRUPT')
      return value
    })
  })
}

export function createRunStore(directoryPath) {
  if (typeof directoryPath !== 'string' || !directoryPath || directoryPath.includes('\0')) throw error('INVALID_RECORD')
  const root = resolve(directoryPath)
  const runs = join(root, 'runs')
  function readRun(id) {
    checkId(id)
    return guarded(() => withDirectory(runs, false, dir => dir === null ? null : read(join(dir, `${id}.json`), validateRun, { id })))
  }
  function requireRun(id) { if (readRun(id) === null) throw error('NOT_FOUND') }
  return {
    putRun(input) {
      const run = snapshot(input, validateRun)
      return guarded(() => publish(runs, run, validateRun, { id: run.id }))
    },
    appendEvent(input) {
      const event = snapshot(input, validateEvent)
      return guarded(() => {
        requireRun(event.runId)
        return publish(join(root, 'events', event.runId), event, validateEvent, { id: event.id, runId: event.runId })
      })
    },
    readRun,
    readEvents(runId) {
      checkId(runId)
      return guarded(() => {
        requireRun(runId)
        return records(join(root, 'events', runId), validateEvent, { runId })
          .sort(byEventTime)
      })
    },
    listRuns(filters = {}) {
      if (!filters || typeof filters !== 'object' || Array.isArray(filters) ||
          Reflect.ownKeys(filters).some(key => !['repo', 'backend', 'parentRunId'].includes(key))) throw error('INVALID_RECORD')
      return guarded(() => records(runs, validateRun)
        .filter(run => Object.entries(filters).every(([key, value]) => run[key] === value))
        .sort(byId))
    },
  }
}
