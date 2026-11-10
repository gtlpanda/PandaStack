import { constants, lstatSync, mkdirSync, openSync, closeSync, fstatSync,
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

// Inspect each component, including the supplied root's ancestors. Never accept
// an existing symlink as a directory, even when its target is inside the store.
function directory(path, create = false) {
  const root = parse(path).root
  let current = root
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part)
    let stat
    try { stat = lstatSync(current) } catch (e) {
      if (e.code !== 'ENOENT') throw e
      if (!create) return false
      try { mkdirSync(current, { mode: 0o700 }) } catch (e) {
        if (e.code !== 'EEXIST') throw e
      }
      stat = lstatSync(current)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('CORRUPT')
  }
  return true
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
    let value
    try { value = JSON.parse(readFileSync(fd, 'utf8')) } catch { throw error('CORRUPT') }
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
  directory(dir, true)
  const target = join(dir, `${value.id}.json`)
  const replay = () => {
    const existing = read(target, validate, expected)
    if (!isDeepStrictEqual(existing, value)) throw error('CONFLICT')
    return { created: false }
  }
  if (read(target, validate, expected) !== null) return replay()
  const temp = join(dir, `.tmp-${randomUUID()}`)
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(value) + '\n')
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    // link is exclusive across processes, and publishes only complete bytes.
    try { linkSync(temp, target) } catch (e) {
      if (e.code === 'EEXIST') return replay()
      throw e
    }
    const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
    return { created: true }
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
}

function records(dir, validate, expected = {}) {
  if (!directory(dir)) return []
  return readdirSync(dir).filter(name => !name.startsWith('.tmp-')).map(name => {
    if (!name.endsWith('.json') || !validId(name.slice(0, -5))) throw error('CORRUPT')
    const value = read(join(dir, name), validate, { ...expected, id: name.slice(0, -5) })
    if (value === null) throw error('CORRUPT')
    return value
  })
}

export function createRunStore(directoryPath) {
  if (typeof directoryPath !== 'string' || !directoryPath || directoryPath.includes('\0')) throw error('INVALID_RECORD')
  const root = resolve(directoryPath)
  const runs = join(root, 'runs')
  function readRun(id) {
    checkId(id)
    return guarded(() => directory(runs) ? read(join(runs, `${id}.json`), validateRun, { id }) : null)
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
