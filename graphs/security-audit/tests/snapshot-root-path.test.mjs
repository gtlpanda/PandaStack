import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../../../scripts/workflow-harness.mjs'
import { inspectSnapshotProtection } from '../skills/security-audit/snapshot-protection.mjs'

const refused = code => ({ ok: false, problems: [{ path: '.', code }] })

function fixture(check) {
  const root = fs.mkdtempSync(join(tmpdir(), 'snapshot-root-path-'))
  const real = join(root, 'real')
  const child = join(real, 'child')
  const file = join(child, 'inert')
  const alias = join(root, 'alias')
  fs.mkdirSync(real)
  fs.mkdirSync(child)
  fs.writeFileSync(file, 'fixed inert bytes\n')
  fs.symlinkSync(real, alias, 'dir')
  fs.chmodSync(file, 0o444)
  fs.chmodSync(child, 0o555)
  fs.chmodSync(real, 0o555)
  const before = [real, child, file].map(path => fs.lstatSync(path).mode)
  try {
    check({ root, real, child, file, alias })
    assert.equal(fs.readFileSync(file, 'utf8'), 'fixed inert bytes\n')
    assert.deepEqual([real, child, file].map(path => fs.lstatSync(path).mode), before)
  } finally {
    fs.chmodSync(real, 0o700)
    fs.chmodSync(child, 0o700)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// Observe synchronous calls only; restore exports before checking/cleaning fixtures.
function observe(check, failAt) {
  const originalStat = fs.lstatSync
  const originalRead = fs.readdirSync
  const stats = [], reads = []
  fs.lstatSync = (path, ...args) => {
    stats.push(path)
    if (path === failAt) throw new Error(`private filesystem detail: ${path}`)
    return originalStat(path, ...args)
  }
  fs.readdirSync = (path, ...args) => {
    reads.push(path)
    return originalRead(path, ...args)
  }
  syncBuiltinESMExports()
  try { check({ stats, reads }) }
  finally {
    fs.lstatSync = originalStat
    fs.readdirSync = originalRead
    syncBuiltinESMExports()
  }
}

await test('dot components reject before all filesystem access, including symlink spellings', () => fixture(({ root, real, child, alias }) => {
  observe(({ stats, reads }) => {
    for (const path of [alias + '/.', alias + '/./child', alias + '/../real/child',
      real + '/./child', child + '/../child', root + '/missing/../real', child + '//.//']) {
      assert.deepEqual(inspectSnapshotProtection(path), refused('INVALID_ROOT'))
    }
    assert.deepEqual(stats, [])
    assert.deepEqual(reads, [])
  })
}))

await test('static ancestor links stop inspection before any target stat or enumeration', () => fixture(({ alias }) => {
  for (const suffix of ['/child', '/child///', '/missing/deeper', '///']) {
    observe(({ stats, reads }) => {
      assert.deepEqual(inspectSnapshotProtection(alias + suffix), refused('SYMLINK'))
      assert.equal(stats.at(-1), alias)
      assert.equal(stats.some(path => path.startsWith(alias + '/')), false)
      assert.deepEqual(reads, [])
    })
  }
}))

await test('missing and nondirectory ancestors return only root-relative IO_ERROR', () => fixture(({ root, file }) => {
  for (const path of [join(root, 'missing', 'child'), file + '/child']) {
    observe(({ reads }) => {
      assert.deepEqual(inspectSnapshotProtection(path), refused('IO_ERROR'))
      assert.deepEqual(reads, [])
    })
  }
}))

await test('ancestor read errors stop early without raw errors or subtree observations', () => fixture(({ real, child }) => {
  observe(({ stats, reads }) => {
    assert.deepEqual(inspectSnapshotProtection(child), refused('IO_ERROR'))
    assert.equal(stats.at(-1), real)
    assert.deepEqual(reads, [])
  }, real)
}))

await test('canonical roots accept trailing separators and writable parents; final files keep NOT_DIRECTORY', () => fixture(({ child, file }) => {
  for (const path of [child, child + '/', child + '///']) {
    assert.deepEqual(inspectSnapshotProtection(path), { ok: true, problems: [] })
  }
  assert.deepEqual(inspectSnapshotProtection(file), refused('NOT_DIRECTORY'))
}))
