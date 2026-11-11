// Static manifest integrity and permission checks only. No Git provenance,
// concurrent replacement containment, context sanitization or tool isolation.
import { lstatSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs'
import { isAbsolute, join, parse, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { canonical, fields } from './journal-data.mjs'
import { isSafeRelativePath } from './upstream.mjs'

const INVALID = 'INVALID_READER_INPUT'
const MANIFEST_LIMIT = 4194304, FILE_LIMIT = 16777216, ENTRY_LIMIT = 10000
const ownErrors = new WeakSet()
function fail(code) {
  const error = Object.assign(new Error(`Audit reader: ${code}`), { code })
  ownErrors.add(error)
  throw error
}
const need = (ok, code = INVALID) => { if (!ok) fail(code) }
function exact(value, keys) {
  try { return fields(value, keys, INVALID) } catch { fail(INVALID) }
}
function guarded(fn) {
  try { return fn() } catch (error) {
    if (ownErrors.has(error)) throw error
    fail('IO_ERROR')
  }
}
function io(fn) {
  try { return fn() } catch (error) {
    // Do not read thrown accessors or Proxy traps, or expose raw OS diagnostics.
    const code = error && typeof error === 'object' && !types.isProxy(error)
      ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null
    fail(code === 'ENOENT' ? 'NOT_FOUND' : code === 'ENOTDIR' ? 'UNSAFE_PATH' : 'IO_ERROR')
  }
}
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
function relativePath(value) {
  need(typeof value === 'string' && Buffer.byteLength(value) <= 1024 && isSafeRelativePath(value))
  return value
}

function captureManifest(input, expected) {
  need(hash(expected))
  let text, manifest
  try {
    text = canonical(input, MANIFEST_LIMIT, INVALID, INVALID)
    manifest = JSON.parse(text)
  } catch { fail(INVALID) }
  exact(manifest, ['version', 'sourceRef', 'files', 'contexts'])
  need(manifest.version === 1)
  const { commit, tree } = exact(manifest.sourceRef, ['commit', 'tree'])
  need(typeof commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) &&
    typeof tree === 'string' && tree.length === commit.length && /^[a-f0-9]+$/.test(tree))
  need(Array.isArray(manifest.files) && Array.isArray(manifest.contexts))
  need(manifest.files.length <= ENTRY_LIMIT && manifest.contexts.length <= ENTRY_LIMIT)
  let count = 0, bytes = 0
  const artifact = (entry, keys) => {
    exact(entry, keys)
    relativePath(entry.path)
    need(hash(entry.sha256) && integer(entry.bytes, 0, FILE_LIMIT))
    count++; bytes += entry.bytes
    need(count <= ENTRY_LIMIT && bytes <= 1073741824)
    Object.freeze(entry)
  }
  const ordered = (entries, key, check) => {
    let previous = null
    for (const entry of entries) {
      check(entry)
      need(previous === null || compare(previous, entry[key]) < 0)
      previous = entry[key]
    }
  }
  ordered(manifest.files, 'path', entry => artifact(entry, ['path', 'sha256', 'bytes']))
  ordered(manifest.contexts, 'manifestId', context => {
    exact(context, ['manifestId', 'artifacts'])
    need(id(context.manifestId) && Array.isArray(context.artifacts) && context.artifacts.length <= ENTRY_LIMIT)
    const paths = new Set()
    ordered(context.artifacts, 'artifactId', entry => {
      artifact(entry, ['artifactId', 'path', 'sha256', 'bytes'])
      need(id(entry.artifactId) && !paths.has(entry.path))
      paths.add(entry.path)
    })
  })
  need(createHash('sha256').update(text).digest('hex') === expected, 'MANIFEST_MISMATCH')
  Object.freeze(manifest.sourceRef)
  Object.freeze(manifest.files)
  return manifest
}

const separator = sep === '\\' ? /[\\/]/ : '/'
function rootPath(value) {
  need(typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && isAbsolute(value) &&
    !value.split(separator).some(part => part === '.' || part === '..'))
  // Normalize separators only after rejecting dot components; lstat must never
  // receive a trailing slash that would follow a final symlink.
  return join(parse(value).root, ...value.slice(parse(value).root.length).split(separator).filter(Boolean))
}
function directory(path, protectedMode) {
  const stat = io(() => lstatSync(path))
  need(stat.isDirectory() && !stat.isSymbolicLink() && (!protectedMode || !(stat.mode & 0o222)), 'UNSAFE_PATH')
}
function inspectRoot(root) {
  let path = parse(root).root
  directory(path, path === root)
  for (const part of root.slice(path.length).split(separator).filter(Boolean)) {
    path = join(path, part)
    directory(path, path === root)
  }
}
function inspectFile(root, entry) {
  inspectRoot(root)
  const parts = entry.path.split('/')
  let path = root
  for (const part of parts.slice(0, -1)) {
    path = join(path, part)
    directory(path, true)
  }
  path = join(path, parts.at(-1))
  inspectFileStat(io(() => lstatSync(path)), entry)
  return path
}
function inspectFileStat(stat, entry) {
  need(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o222), 'UNSAFE_PATH')
  need(stat.size === entry.bytes, 'SOURCE_MISMATCH')
}

// Hash the complete bounded file, retaining only the requested byte interval.
// Each operation rechecks the filesystem and bytes; there is no content cache.
function verifiedRange(root, entry, start, end) {
  const path = inspectFile(root, entry)
  const fd = io(() => openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)))
  try {
    inspectFileStat(io(() => fstatSync(fd)), entry)
    const chunk = Buffer.alloc(65536), result = Buffer.alloc(end - start), digest = createHash('sha256')
    let position = 0
    while (position < entry.bytes) {
      const size = io(() => readSync(fd, chunk, 0, Math.min(chunk.length, entry.bytes - position), position))
      need(size > 0, 'SOURCE_MISMATCH')
      digest.update(chunk.subarray(0, size))
      const from = Math.max(start, position), to = Math.min(end, position + size)
      if (from < to) chunk.copy(result, from - start, from - position, to - position)
      position += size
    }
    inspectFileStat(io(() => fstatSync(fd)), entry)
    need(digest.digest('hex') === entry.sha256, 'SOURCE_MISMATCH')
    return result
  } finally { io(() => closeSync(fd)) }
}

export function createSourceReader(options) {
  return guarded(() => {
    const input = exact(options, ['sourceRoot', 'contextRoot', 'manifest', 'expectedManifestHash'])
    const sourceRoot = rootPath(input.sourceRoot), contextRoot = rootPath(input.contextRoot)
    const within = (a, b) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
    need(!within(sourceRoot, contextRoot) && !within(contextRoot, sourceRoot))
    const manifest = captureManifest(input.manifest, input.expectedManifestHash)
    inspectRoot(sourceRoot); inspectRoot(contextRoot)
    const manifestHash = input.expectedManifestHash
    const files = new Map(manifest.files.map(entry => [entry.path, entry]))
    const contexts = new Map(manifest.contexts.map(context => [context.manifestId,
      new Map(context.artifacts.map(entry => [entry.artifactId, entry]))]))
    let closed = false
    const method = fn => value => guarded(() => { need(!closed, 'CLOSED'); return fn(value) })
    const lookup = path => {
      relativePath(path)
      const entry = files.get(path)
      need(entry, 'NOT_FOUND')
      return entry
    }
    const page = (root, entry, offset, limit) => {
      need(integer(offset, 0, entry.bytes) && integer(limit, 1, 65536))
      const end = Math.min(entry.bytes, offset + limit)
      const data = verifiedRange(root, entry, offset, end)
      return { manifestHash, sha256: entry.sha256, bytes: entry.bytes, offset,
        dataBase64: data.toString('base64'), nextOffset: end === entry.bytes ? null : end }
    }
    return Object.freeze({
      listSource: method(value => {
        const { after, limit } = exact(value, ['after', 'limit'])
        need(integer(limit, 1, 128))
        if (after !== null) lookup(after)
        const start = after === null ? 0 : manifest.files.findIndex(entry => entry.path === after) + 1
        const entries = Object.freeze(manifest.files.slice(start, start + limit))
        return Object.freeze({ manifestHash, sourceRef: manifest.sourceRef, entries,
          nextAfter: start + entries.length < manifest.files.length ? entries.at(-1).path : null })
      }),
      readSource: method(value => {
        const { path, offset, limit } = exact(value, ['path', 'offset', 'limit'])
        return page(sourceRoot, lookup(path), offset, limit)
      }),
      searchSource: method(value => {
        const { path, literal, offset, scanBytes, limit } = exact(value, ['path', 'literal', 'offset', 'scanBytes', 'limit'])
        const entry = lookup(path)
        need(typeof literal === 'string' && literal.length > 0 && literal.isWellFormed() && Buffer.byteLength(literal) <= 1024)
        need(integer(offset, 0, entry.bytes) && integer(scanBytes, 1, 1048576) && integer(limit, 1, 128))
        const needle = Buffer.from(literal), end = Math.min(entry.bytes, offset + scanBytes)
        const data = verifiedRange(sourceRoot, entry, offset, Math.min(entry.bytes, end + needle.length - 1))
        const matches = []
        let cursor = 0, next = end
        while (matches.length < limit) {
          const match = data.indexOf(needle, cursor)
          if (match < 0 || offset + match >= end) break
          matches.push(offset + match)
          cursor = match + needle.length
        }
        // Remaining eligible starts, rather than an extra match, determine the
        // resume cursor. A match crossing the scan window is already complete.
        if (matches.length === limit && offset + cursor < end) next = offset + cursor
        return { manifestHash, sha256: entry.sha256, matches, nextOffset: next === entry.bytes ? null : next }
      }),
      readContext: method(value => {
        const { manifestId, artifactId, offset, limit } = exact(value, ['manifestId', 'artifactId', 'offset', 'limit'])
        need(id(manifestId) && id(artifactId))
        const entry = contexts.get(manifestId)?.get(artifactId)
        need(entry, 'NOT_FOUND')
        return { ...page(contextRoot, entry, offset, limit), manifestId, artifactId }
      }),
      close() { closed = true },
    })
  })
}
