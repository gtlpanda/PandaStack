import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test } from '../../../scripts/workflow-harness.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value
const digest = value => sha(JSON.stringify(sorted(value)))
const error = code => e => e.code === code && e.message === `Audit reader: ${code}`
const request = { path: 'a.bin', offset: 0, limit: 7 }

async function fixture(check) {
  const { createSourceReader } = await import('../skills/security-audit/source-reader.mjs')
  const base = fs.mkdtempSync(join(tmpdir(), 'sr01-implementation-'))
  const sourceRoot = join(base, 'source'), contextRoot = join(base, 'context')
  const directories = [sourceRoot, join(sourceRoot, 'nested'), contextRoot]
  directories.forEach(path => fs.mkdirSync(path))
  const bodies = { 'a.bin': Buffer.from([0, 255, 195, 169, 10, 0]), 'nested/text': Buffer.from('aaaa .* 雪🙂 end'), 'zero': Buffer.alloc(0) }
  for (const [path, body] of Object.entries(bodies)) fs.writeFileSync(join(sourceRoot, path), body, { mode: 0o444 })
  fs.writeFileSync(join(contextRoot, 'a.bin'), 'issued context bytes', { mode: 0o444 })
  directories.forEach(path => fs.chmodSync(path, 0o555))
  const entry = (path, bytes) => ({ path, sha256: sha(bytes), bytes: bytes.length })
  const manifest = { version: 1, sourceRef: { commit: 'a'.repeat(64), tree: 'b'.repeat(64) },
    files: Object.entries(bodies).map(([path, body]) => entry(path, body)),
    contexts: [{ manifestId: 'issued', artifacts: [{ artifactId: 'context', ...entry('a.bin', Buffer.from('issued context bytes')) }] }] }
  const create = (m = manifest, options = {}) => createSourceReader({ sourceRoot, contextRoot, manifest: m, expectedManifestHash: digest(m), ...options })
  try { await check({ base, sourceRoot, contextRoot, bodies, manifest, create, createSourceReader, reader: create() }) }
  finally {
    directories.forEach(path => fs.chmodSync(path, 0o755))
    fs.rmSync(base, { recursive: true, force: true })
  }
}

function intercept(overrides, check) {
  const originals = Object.fromEntries(Object.keys(overrides).map(key => [key, fs[key]]))
  for (const [key, value] of Object.entries(overrides)) fs[key] = (...args) => value(originals[key], ...args)
  syncBuiltinESMExports()
  try { return check() } finally { Object.assign(fs, originals); syncBuiltinESMExports() }
}

await test('SR01 binary and empty pages preserve exact bytes, EOF and context separation', () => fixture(({ reader, bodies }) => {
  const chunks = []; let offset = 0
  do {
    const page = reader.readSource({ ...request, offset, limit: 1 })
    chunks.push(Buffer.from(page.dataBase64, 'base64')); offset = page.nextOffset
    assert.equal(page.bytes, bodies['a.bin'].length)
  } while (offset !== null)
  assert.deepEqual(Buffer.concat(chunks), bodies['a.bin'])
  for (const [path, at] of [['a.bin', 6], ['zero', 0]]) {
    const page = reader.readSource({ path, offset: at, limit: 1 })
    assert.equal(page.dataBase64, ''); assert.equal(page.nextOffset, null)
  }
  const page = reader.readContext({ manifestId: 'issued', artifactId: 'context', offset: 0, limit: 65536 })
  assert.equal(Buffer.from(page.dataBase64, 'base64').toString(), 'issued context bytes')
  assert.deepEqual(Object.keys(page).sort(), ['artifactId', 'bytes', 'dataBase64', 'manifestHash', 'manifestId', 'nextOffset', 'offset', 'sha256'].sort())
}))

await test('SR01 inventory is frozen, detached, UTF8 ordered and paginated without filesystem reads', () => fixture(({ manifest, create }) => {
  manifest.files = ['z', '\uE000', '🙂'].map(path => ({ path, sha256: sha(''), bytes: 0 }))
  const reader = create()
  manifest.sourceRef.commit = 'c'.repeat(64); manifest.files.length = 0
  intercept({ lstatSync: () => assert.fail('inventory must not stat'), readdirSync: () => assert.fail('must not scan') }, () => {
    const first = reader.listSource({ after: null, limit: 2 })
    assert.deepEqual(first.entries.map(e => e.path), ['z', '\uE000'])
    assert.equal(first.nextAfter, '\uE000'); assert.equal(first.sourceRef.commit, 'a'.repeat(64))
    assert.ok(Object.isFrozen(first.entries)); assert.ok(Object.isFrozen(first.entries[0]))
    assert.deepEqual(reader.listSource({ after: first.nextAfter, limit: 2 }).entries.map(e => e.path), ['🙂'])
    assert.deepEqual(reader.listSource({ after: '🙂', limit: 1 }).entries, [])
    assert.throws(() => reader.listSource({ after: 'unknown', limit: 1 }), error('NOT_FOUND'))
  })
}))

await test('SR01 literal byte search resumes nonoverlapping matches and crosses window boundaries', () => fixture(({ reader, bodies }) => {
  const search = options => reader.searchSource({ path: 'nested/text', literal: 'aa', offset: 0, scanBytes: 1048576, limit: 1, ...options })
  assert.deepEqual(search().matches, [0]); assert.equal(search().nextOffset, 2)
  const second = search({ offset: 2 }); assert.deepEqual(second.matches, [2]); assert.equal(second.nextOffset, 4)
  const tail = search({ offset: second.nextOffset }); assert.deepEqual(tail.matches, []); assert.equal(tail.nextOffset, null)
  assert.deepEqual(search({ literal: '.*', offset: 5, scanBytes: 1 }).matches, [5])
  assert.equal(search({ literal: '.*', offset: 5, scanBytes: 1 }).nextOffset, 6)
  assert.deepEqual(search({ literal: '雪🙂', offset: 8, scanBytes: 1 }).matches, [8])
  assert.equal(search({ offset: bodies['nested/text'].length }).nextOffset, null)
}))

await test('SR01 every page and search hashes the whole file in bounded chunks, including the unseen tail', () => fixture(({ sourceRoot, manifest, create }) => {
  const body = Buffer.alloc(180000, 120), path = join(sourceRoot, 'a.bin')
  fs.chmodSync(path, 0o644); fs.writeFileSync(path, body); fs.chmodSync(path, 0o444)
  manifest.files[0] = { path: 'a.bin', sha256: sha(body), bytes: body.length }
  const reader = create(); let total = 0, calls = 0
  intercept({ readSync: (original, fd, buffer, offset, length, position) => {
    assert.ok(buffer.length <= 65536); assert.ok(length <= 65536)
    const n = original(fd, buffer, offset, length, position); total += n; calls++; return n
  } }, () => {
    reader.readSource({ ...request, limit: 1 })
    reader.searchSource({ path: 'a.bin', literal: 'x', offset: 0, scanBytes: 1, limit: 1 })
  })
  assert.equal(total, body.length * 2); assert.ok(calls >= 6)
  body[body.length - 1] = 121
  fs.chmodSync(path, 0o644); fs.writeFileSync(path, body); fs.chmodSync(path, 0o444)
  assert.throws(() => reader.readSource({ ...request, limit: 1 }), error('SOURCE_MISMATCH'))
  assert.throws(() => reader.searchSource({ path: 'a.bin', literal: 'x', offset: 0, scanBytes: 1, limit: 1 }), error('SOURCE_MISMATCH'))
}))

await test('SR01 rejects size drift and writable root, intermediate directory and context artifacts', () => fixture(({ reader, sourceRoot, contextRoot }) => {
  for (const path of [sourceRoot, join(sourceRoot, 'nested')]) {
    fs.chmodSync(path, 0o755)
    assert.throws(() => reader.readSource({ path: 'nested/text', offset: 0, limit: 1 }), error('UNSAFE_PATH'))
    fs.chmodSync(path, 0o555)
  }
  const context = join(contextRoot, 'a.bin'); fs.chmodSync(context, 0o644)
  assert.throws(() => reader.readContext({ manifestId: 'issued', artifactId: 'context', offset: 0, limit: 1 }), error('UNSAFE_PATH'))
  fs.chmodSync(context, 0o444)
  const path = join(sourceRoot, 'a.bin'); fs.chmodSync(path, 0o644); fs.writeFileSync(path, 'short'); fs.chmodSync(path, 0o444)
  assert.throws(() => reader.readSource(request), error('SOURCE_MISMATCH'))
}))

await test('SR01 static root ancestors, addressed directory links and nonregular entries refuse', () => fixture(({ base, sourceRoot, contextRoot, manifest, create, reader }) => {
  const alias = join(base, 'alias'); fs.symlinkSync(base, alias)
  assert.throws(() => create(manifest, { sourceRoot: join(alias, 'source') }), error('UNSAFE_PATH'))
  fs.chmodSync(sourceRoot, 0o755)
  fs.symlinkSync(contextRoot, join(sourceRoot, 'linked'))
  fs.mkdirSync(join(sourceRoot, 'directory'))
  fs.chmodSync(sourceRoot, 0o555)
  manifest.files = [{ path: 'linked/a.bin', sha256: sha(''), bytes: 0 }]
  assert.throws(() => create().readSource({ path: 'linked/a.bin', offset: 0, limit: 1 }), error('UNSAFE_PATH'))
  manifest.files[0].path = 'directory'
  assert.throws(() => create().readSource({ path: 'directory', offset: 0, limit: 1 }), error('UNSAFE_PATH'))
  fs.chmodSync(sourceRoot, 0o755); fs.rmSync(join(sourceRoot, 'a.bin')); fs.chmodSync(sourceRoot, 0o555)
  assert.throws(() => reader.readSource(request), error('NOT_FOUND'))
}))

await test('SR01 validates roots before access and refuses overlapping or writable roots', () => fixture(({ sourceRoot, contextRoot, manifest, create }) => {
  for (const root of ['relative', sourceRoot + '/.', sourceRoot + '/../source', sourceRoot + '\0', null, 7]) {
    intercept({ lstatSync: () => assert.fail('invalid root must not stat') }, () =>
      assert.throws(() => create(manifest, { sourceRoot: root }), error('INVALID_READER_INPUT')))
  }
  for (const root of [sourceRoot, join(sourceRoot, 'nested')]) {
    assert.throws(() => create(manifest, { contextRoot: root }), error('INVALID_READER_INPUT'))
  }
  fs.chmodSync(contextRoot, 0o755)
  assert.throws(() => create(), error('UNSAFE_PATH')); fs.chmodSync(contextRoot, 0o555)
  assert.equal(create(manifest, { sourceRoot: sourceRoot + '///' }).readSource(request).bytes, 6)
}))

await test('SR01 unknown paths and context IDs never touch filesystem or try other namespaces', () => fixture(({ reader }) => {
  intercept({ lstatSync: () => assert.fail('unknown lookup must not stat'), openSync: () => assert.fail('unknown lookup must not open') }, () => {
    assert.throws(() => reader.readSource({ ...request, path: 'missing' }), error('NOT_FOUND'))
    for (const [manifestId, artifactId] of [['missing', 'context'], ['issued', 'missing']])
      assert.throws(() => reader.readContext({ manifestId, artifactId, offset: 0, limit: 1 }), error('NOT_FOUND'))
  })
}))

await test('SR01 rejects malformed manifest shapes, hashes, order, duplicates and finite bounds', () => fixture(({ manifest, create }) => {
  const changes = [
    m => { m.extra = true }, m => { m.version = 2 }, m => { m.sourceRef.extra = 1 },
    m => { m.sourceRef.tree = 'b'.repeat(40) }, m => { m.files[0].sha256 = 'A'.repeat(64) },
    m => { m.files.reverse() }, m => { m.files.push(m.files[0]) },
    m => { m.files[0].bytes = 16777217 }, m => { m.files[0].bytes = -1 }, m => { m.files[0].bytes = 0.5 },
    m => { m.files[0].path = 'x'.repeat(1025) }, m => { m.files[0].path = 'a/../b' },
    m => { m.contexts.push(m.contexts[0]) }, m => { m.contexts[0].manifestId = '-bad' },
    m => { m.contexts[0].artifacts.push({ ...m.contexts[0].artifacts[0], artifactId: 'second' }) },
    m => { m.contexts[0].artifacts[0].artifactId = 'x'.repeat(129) },
    m => { m.files = Array.from({ length: 10001 }, (_, i) => ({ path: `f${String(i).padStart(5, '0')}`, sha256: sha(''), bytes: 0 })) },
    m => { m.files = Array.from({ length: 65 }, (_, i) => ({ path: `f${String(i).padStart(2, '0')}`, sha256: sha(''), bytes: 16777216 })) },
    m => { m.files = Array.from({ length: 4000 }, (_, i) => ({ path: `${String(i).padStart(4, '0')}${'x'.repeat(1020)}`, sha256: sha(''), bytes: 0 })) },
  ]
  for (const change of changes) {
    const m = structuredClone(manifest); change(m)
    assert.throws(() => create(m), error('INVALID_READER_INPUT'))
  }
  assert.throws(() => create(manifest, { expectedManifestHash: 'f'.repeat(64) }), error('MANIFEST_MISMATCH'))
}))

await test('SR01 unsafe JavaScript inputs invoke no getters, proxies, prototypes or JSON hooks', () => fixture(({ sourceRoot, contextRoot, manifest, createSourceReader, reader }) => {
  let hooks = 0
  const proxy = new Proxy({}, { get() { hooks++; throw Error() }, ownKeys() { hooks++; throw Error() }, getPrototypeOf() { hooks++; throw Error() } })
  const accessor = Object.defineProperty({}, 'version', { enumerable: true, get() { hooks++; return 1 } })
  const cycle = {}; cycle.self = cycle
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  const unsafe = [proxy, revoked.proxy, accessor, cycle, new Date(), { toJSON() { hooks++; return manifest } }, { value: Infinity }, { value: undefined }, { value: 1n }, { value: Symbol() }, { value: [, 1] }, Object.create({ inherited: true })]
  for (const value of unsafe) {
    assert.throws(() => createSourceReader({ sourceRoot, contextRoot, manifest: value, expectedManifestHash: '0'.repeat(64) }), error('INVALID_READER_INPUT'))
  }
  assert.throws(() => createSourceReader(proxy), error('INVALID_READER_INPUT'))
  assert.throws(() => reader.readSource(proxy), error('INVALID_READER_INPUT'))
  assert.throws(() => reader.readSource(accessor), error('INVALID_READER_INPUT'))
  assert.equal(hooks, 0)
}))

await test('SR01 request grammar, scalar text and exact fields are enforced', () => fixture(({ reader }) => {
  for (const path of ['../x', '/x', 'x/./y', 'a\\b', 'a:b', 'x\0', '\ud800', 'x//y', 'x'.repeat(1025)])
    assert.throws(() => reader.readSource({ ...request, path }), error('INVALID_READER_INPUT'))
  for (const value of [null, undefined, 0, NaN, Infinity, 1.5, -1, 65537, '1'])
    assert.throws(() => reader.readSource({ ...request, limit: value }), error('INVALID_READER_INPUT'))
  for (const offset of [-1, 7, 0.5, null, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => reader.readSource({ ...request, offset }), error('INVALID_READER_INPUT'))
  for (const literal of ['', '\ud800', '🙂'.repeat(257), null, {}])
    assert.throws(() => reader.searchSource({ path: 'a.bin', literal, offset: 0, scanBytes: 1, limit: 1 }), error('INVALID_READER_INPUT'))
  assert.throws(() => reader.readSource({ ...request, extra: true }), error('INVALID_READER_INPUT'))
  assert.throws(() => reader.listSource({ limit: 1 }), error('INVALID_READER_INPUT'))
  reader.close(); reader.close()
  for (const method of ['listSource', 'readSource', 'searchSource', 'readContext'])
    assert.throws(() => reader[method](null), error('CLOSED'))
}))

await test('SR01 operational errors remain generic and opened handles close after failed reads', () => fixture(({ reader }) => {
  let closes = 0
  intercept({ readSync: () => { throw Error('private file bytes and absolute path') }, closeSync: (original, fd) => { closes++; return original(fd) } }, () => {
    assert.throws(() => reader.readSource(request), error('IO_ERROR'))
  })
  assert.equal(closes, 1)
  assert.throws(() => intercept({ lstatSync: () => { throw new Proxy({}, { get() { assert.fail('must not inspect unknown error') } }) } }, () => reader.readSource(request)), error('IO_ERROR'))
  assert.equal(reader.readSource(request).bytes, 6)
}))
