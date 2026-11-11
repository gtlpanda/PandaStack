import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../../../scripts/workflow-harness.mjs'
import { inspectSnapshotProtection } from '../skills/security-audit/snapshot-protection.mjs'

function fixture(check) {
  const root = fs.mkdtempSync(join(tmpdir(), 'snapshot-protection-'))
  const directories = [root]
  const directory = name => {
    const path = join(root, name)
    fs.mkdirSync(path)
    directories.push(path)
    return path
  }
  try { return check(root, directory) }
  finally {
    for (const path of directories) fs.chmodSync(path, 0o700)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// Synchronous test-only fault injection; the production API accepts only a path.
function withFs(method, replacement, check) {
  const original = fs[method]
  fs[method] = (...args) => replacement(original, ...args)
  syncBuiltinESMExports()
  try { check() }
  finally { fs[method] = original; syncBuiltinESMExports() }
}

await test('snapshot inspection rejects nonstring and relative roots without coercion', () => {
  for (const value of [undefined, null, 0, 1, true, {}, [], [' /tmp'], '', '.', 'tree', new URL('file:///tmp')]) {
    assert.deepEqual(inspectSnapshotProtection(value), { ok: false, problems: [{ path: '.', code: 'INVALID_ROOT' }] })
  }
})

await test('an empty sealed directory passes and returned diagnostics are detached', () => fixture(root => {
  fs.chmodSync(root, 0o555)
  assert.deepEqual(inspectSnapshotProtection(root), { ok: true, problems: [] })
  fs.chmodSync(root, 0o755)
  const first = inspectSnapshotProtection(root)
  first.problems[0].path = 'changed'
  first.problems.push({ path: 'extra', code: 'IO_ERROR' })
  assert.deepEqual(inspectSnapshotProtection(root), { ok: false, problems: [{ path: '.', code: 'WRITABLE' }] })
}))

await test('each write bit is rejected, preserving binary bytes and executable mode', () => fixture(root => {
  const bytes = Buffer.from([0, 255, 13, 10, 128])
  const file = join(root, 'inert')
  fs.writeFileSync(file, bytes)
  fs.chmodSync(root, 0o555)
  for (const bit of [0o200, 0o020, 0o002]) {
    fs.chmodSync(file, 0o555 | bit)
    const mode = fs.lstatSync(file).mode
    assert.deepEqual(inspectSnapshotProtection(root), { ok: false, problems: [{ path: 'inert', code: 'WRITABLE' }] })
    assert.equal(fs.lstatSync(file).mode, mode)
    assert.deepEqual(fs.readFileSync(file), bytes)
  }
  fs.chmodSync(file, 0o555)
  assert.deepEqual(inspectSnapshotProtection(root), { ok: true, problems: [] })
}))

await test('diagnostics use POSIX relative paths and Unicode codepoint order', () => fixture((root, directory) => {
  directory('z')
  for (const name of ['z/child', '\u{10000}', '\ue000', 'a']) {
    fs.writeFileSync(join(root, name), 'inert')
    fs.chmodSync(join(root, name), 0o644)
  }
  fs.chmodSync(join(root, 'z'), 0o555)
  fs.chmodSync(root, 0o555)
  assert.deepEqual(inspectSnapshotProtection(root), { ok: false, problems:
    ['a', 'z/child', '\ue000', '\u{10000}'].map(path => ({ path, code: 'WRITABLE' })) })
}))

await test('a dangling symlink including a root with trailing slash is never followed', () => fixture(root => {
  const link = join(root, 'link')
  fs.symlinkSync(join(root, 'missing'), link)
  fs.chmodSync(root, 0o555)
  assert.deepEqual(inspectSnapshotProtection(root), { ok: false, problems: [{ path: 'link', code: 'SYMLINK' }] })
  for (const path of [link, `${link}/`]) {
    assert.deepEqual(inspectSnapshotProtection(path), { ok: false, problems: [{ path: '.', code: 'SYMLINK' }] })
  }
}))

await test('I/O failures retain observed writable entries and other siblings without leaking errors', () => fixture((root, directory) => {
  const unreadable = directory('unreadable')
  const absent = join(root, 'unstatable')
  fs.writeFileSync(absent, 'inert')
  fs.chmodSync(root, 0o755)
  fs.chmodSync(unreadable, 0o755)
  withFs('readdirSync', (original, path, ...args) => {
    if (path === unreadable) throw new Error(`private error: ${root}`)
    return original(path, ...args)
  }, () => withFs('lstatSync', (original, path, ...args) => {
    if (path === absent) throw new Error('private source contents')
    return original(path, ...args)
  }, () => {
    assert.deepEqual(inspectSnapshotProtection(root), { ok: false, problems: [
      { path: '.', code: 'WRITABLE' },
      { path: 'unreadable', code: 'IO_ERROR' },
      { path: 'unreadable', code: 'WRITABLE' },
      { path: 'unstatable', code: 'IO_ERROR' },
    ] })
  }))
}))

await test('special entries are refused without enumeration or reading their contents', () => fixture(root => {
  const special = join(root, 'special')
  fs.writeFileSync(special, 'inert')
  fs.chmodSync(root, 0o555)
  withFs('lstatSync', (original, path, ...args) => {
    if (path === special) return { mode: 0o666, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false }
    return original(path, ...args)
  }, () => {
    assert.deepEqual(inspectSnapshotProtection(root), { ok: false, problems: [{ path: 'special', code: 'NOT_REGULAR' }] })
    assert.deepEqual(inspectSnapshotProtection(special), { ok: false, problems: [{ path: '.', code: 'NOT_DIRECTORY' }] })
  })
}))
