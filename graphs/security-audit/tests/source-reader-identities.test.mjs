import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test } from '../../../scripts/workflow-harness.mjs'
import { canonical } from '../skills/security-audit/journal-data.mjs'
import { createSourceReader } from '../skills/security-audit/source-reader.mjs'

const error = code => e => e.code === code && e.message === `Audit reader: ${code}`
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const large = 2n ** 60n

function fixture(check) {
  const base = fs.mkdtempSync(join(tmpdir(), 'sr01a-implementation-'))
  const sourceParent = join(base, 'source-parent'), contextParent = join(base, 'context-parent')
  const sourceRoot = join(sourceParent, 'source'), contextRoot = join(contextParent, 'context')
  const directories = [sourceParent, sourceRoot, contextParent, contextRoot]
  try {
    directories.forEach(path => fs.mkdirSync(path))
    for (const root of [sourceRoot, contextRoot]) fs.chmodSync(root, 0o555)
    const manifest = { version: 1, sourceRef: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, files: [], contexts: [] }
    const create = () => createSourceReader({ sourceRoot, contextRoot, manifest,
      expectedManifestHash: sha(canonical(manifest, 4194304, 'INVALID', 'LIMIT')) })
    check({ base, sourceParent, sourceRoot, contextParent, contextRoot, create })
  } finally {
    for (const path of directories) if (fs.existsSync(path)) fs.chmodSync(path, 0o755)
    fs.rmSync(base, { recursive: true, force: true })
  }
}

// Synchronous directory metadata observation only, restored before the next case.
function identities(changes, check, observe = () => {}) {
  const original = fs.lstatSync
  fs.lstatSync = function (path, options) {
    const stat = original.call(fs, path, options)
    observe(path, options)
    const identity = changes.get(path)
    if (!identity) return stat
    assert.ok(stat.isDirectory())
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, identity)
  }
  syncBuiltinESMExports()
  try { check() } finally { fs.lstatSync = original; syncBuiltinESMExports() }
}

await test('SR01a keeps distinct bigint inode values beyond Number precision separate', () => fixture(x => {
  identities(new Map([
    [x.sourceRoot, { dev: 0n, ino: large }],
    [x.contextRoot, { dev: 0n, ino: large + 1n }],
  ]), () => x.create().close())
}))

await test('SR01a identity equality requires both exact device and inode', () => fixture(x => {
  for (const contextDev of [large + 1n, large]) {
    identities(new Map([
      [x.sourceRoot, { dev: large, ino: 1n }],
      [x.contextRoot, { dev: contextDev, ino: 1n }],
    ]), () => {
      if (contextDev === large) assert.throws(x.create, error('INVALID_READER_INPUT'))
      else x.create().close()
    })
  }
}))

await test('SR01a detects either root in the opposite interior ancestor chain', () => fixture(x => {
  for (const [root, ancestor] of [[x.sourceRoot, x.contextParent], [x.contextRoot, x.sourceParent]]) {
    identities(new Map([
      [root, { dev: large, ino: large }],
      [ancestor, { dev: large, ino: large }],
    ]), () => assert.throws(x.create, error('INVALID_READER_INPUT')))
  }
}))

await test('SR01a rejects unusable identity fields at roots and ordinary shared or private ancestors', () => fixture(x => {
  const invalid = [
    { dev: -1n }, { dev: 0 }, { dev: undefined }, { dev: null }, { dev: '0' },
    { ino: 0n }, { ino: -1n }, { ino: 1 }, { ino: undefined }, { ino: null }, { ino: '1' },
  ]
  for (const path of [x.sourceRoot, x.contextRoot, x.base, x.sourceParent, x.contextParent]) {
    for (const value of invalid) identities(new Map([[path, value]]), () => assert.throws(x.create, error('UNSAFE_PATH')))
  }
}))

await test('SR01a observes bigint metadata for both complete chains and allows shared parents', () => fixture(x => {
  const observed = new Set()
  identities(new Map(), () => x.create().close(), (path, options) => {
    assert.equal(options?.bigint, true)
    observed.add(path)
  })
  for (const path of [x.base, x.sourceParent, x.contextParent, x.sourceRoot, x.contextRoot]) assert.ok(observed.has(path))
}))
