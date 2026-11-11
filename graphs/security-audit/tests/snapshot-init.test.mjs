import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, sep } from 'node:path'
import { test } from '../../../scripts/workflow-harness.mjs'
import { init, parseInitArgs } from '../skills/security-audit/audit-run.mjs'
import { inspectSnapshotProtection } from '../skills/security-audit/snapshot-protection.mjs'
import { fresh, mkRepo, meta } from './audit-fixtures.mjs'

await test('init rejects observed writable export before publication/prior discovery and removes only its owned run', () => {
  const repo = mkRepo({ 'inert.txt': 'committed inert bytes\n' })
  const parent = fresh('snapshot-init')
  const out = join(parent, 'run')
  const tree = join(out, 'tree')
  const sentinel = join(parent, 'keep')
  fs.writeFileSync(sentinel, 'unchanged')
  const chmod = fs.chmodSync, readdir = fs.readdirSync, write = fs.writeFileSync
  let observed = false
  // Model a filesystem that acknowledges seal chmod but retains write bits.
  // No races, processes, target execution or public injected stat authority.
  fs.chmodSync = (path, mode) => {
    if ((path === tree || path.startsWith(tree + sep)) && !(mode & 0o222)) return
    return chmod(path, mode)
  }
  fs.readdirSync = (path, ...args) => {
    assert.notEqual(path, parent, 'prior discovery ran before snapshot refusal')
    if (path === tree && args.length === 0) {
      observed = true
      assert.equal(fs.readFileSync(join(tree, 'inert.txt'), 'utf8'), 'committed inert bytes\n')
      assert.ok(fs.lstatSync(tree).mode & 0o222)
    }
    return readdir(path, ...args)
  }
  fs.writeFileSync = (path, ...args) => {
    assert.ok(!['run-metadata.json.tmp', 'stage-state.json.tmp', 'events.jsonl'].some(name => path === join(out, name)), 'published before refusal')
    return write(path, ...args)
  }
  syncBuiltinESMExports()
  try {
    assert.throws(() => init(parseInitArgs([repo, '--full', '--out', out])), {
      message: 'snapshot permission inspection failed: audit initialization refused',
    })
  } finally {
    fs.chmodSync = chmod; fs.readdirSync = readdir; fs.writeFileSync = write
    syncBuiltinESMExports()
  }
  assert.ok(observed, 'the exact exported tree was inspected')
  assert.equal(fs.existsSync(out), false)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged')
})

await test('insufficient init budget records incomplete without exporting or inspecting a tree', () => {
  const repo = mkRepo({ 'inert.txt': 'inert' })
  const out = join(fresh('snapshot-budget'), 'run')
  const tree = join(out, 'tree')
  const lstat = fs.lstatSync
  fs.lstatSync = (path, ...args) => {
    assert.notEqual(path, tree, 'snapshot inspection must not run on budget refusal')
    return lstat(path, ...args)
  }
  syncBuiltinESMExports()
  try {
    const result = init(parseInitArgs([repo, '--full', '--out', out, '--budget', '0']))
    assert.equal(result.gate.ok, false)
    assert.equal(meta(out).run_status, 'incomplete')
    assert.equal(meta(out).snapshot, null)
    assert.equal(meta(out).agents_spent, 0)
    assert.equal(fs.existsSync(tree), false)
  } finally { fs.lstatSync = lstat; syncBuiltinESMExports() }
})

await test('successful init publishes the exact sealed committed snapshot', () => {
  const bytes = 'ordinary committed source\n'
  const repo = mkRepo({ 'inert.txt': bytes })
  const out = join(fresh('snapshot-success'), 'run')
  const result = init(parseInitArgs([repo, '--full', '--out', out]))
  assert.equal(result.gate.ok, true)
  assert.deepEqual(inspectSnapshotProtection(join(out, 'tree')), { ok: true, problems: [] })
  assert.equal(fs.readFileSync(join(out, 'tree', 'inert.txt'), 'utf8'), bytes)
  assert.equal(meta(out).run_status, 'in_progress')
  assert.equal(meta(out).snapshot.files, 1)
  assert.equal(meta(out).snapshot.bytes, Buffer.byteLength(bytes))
})
