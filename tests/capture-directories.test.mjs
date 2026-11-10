import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from '../scripts/workflow-harness.mjs'
import * as evidence from '../graphs/hunt/skills/bughunt/evidence.mjs'

// Sequential helper checks only: no capture, process, scheduling or race fixture.
function fixture(check) {
  assert.equal(typeof evidence.prepareCaptureDirectories, 'function')
  const base = fs.mkdtempSync(join(tmpdir(), 'capture-helper-'))
  try { check(base, evidence.prepareCaptureDirectories) }
  finally { fs.rmSync(base, { recursive: true, force: true }) }
}

await test('capture preparation refuses malformed state inputs without creating children', () => fixture((base, prepare) => {
  const before = fs.readdirSync(base)
  for (const value of [null, undefined, 0, {}, [], '', '.', 'relative/state', base + '\0']) {
    assert.throws(() => prepare(value))
  }
  assert.deepEqual(fs.readdirSync(base), before)
}))

await test('capture preparation refuses absent and regular-file state without mutation', () => fixture((base, prepare) => {
  const absent = join(base, 'absent')
  assert.throws(() => prepare(absent), { code: 'ENOENT' })
  assert.deepEqual(fs.readdirSync(base), [])
  const file = join(base, 'state')
  fs.writeFileSync(file, 'retained state bytes', { mode: 0o600 })
  const before = fs.lstatSync(file)
  assert.throws(() => prepare(file))
  assert.deepEqual(fs.lstatSync(file), before)
  assert.equal(fs.readFileSync(file, 'utf8'), 'retained state bytes')
  assert.deepEqual(fs.readdirSync(base), ['state'])
}))

await test('capture preparation preserves literal absolute state path and shared-parent policy', () => fixture((base, prepare) => {
  const state = join(base, 'state with \\ literal')
  fs.mkdirSync(state, { mode: 0o755 })
  fs.chmodSync(state, 0o755)
  const input = state + '/'
  const expected = { stateDir: input, evidence: join(state, 'evidence'), root: join(state, 'evidence', 'logs') }
  assert.deepEqual(prepare(input), expected)
  assert.deepEqual(prepare(input), expected)
  assert.equal(fs.lstatSync(state).mode & 0o777, 0o755)
  assert.equal(fs.lstatSync(expected.evidence).mode & 0o777, 0o700)
  assert.equal(fs.lstatSync(expected.root).mode & 0o777, 0o700)
  assert.deepEqual(fs.readdirSync(expected.root), [])
}))

await test('armCapture prepares fixed parents before the existing private invocation allocation', () => {
  const source = fs.readFileSync(new URL('../graphs/hunt/skills/bughunt/evidence.mjs', import.meta.url), 'utf8')
  const arm = source.slice(source.indexOf('function armCapture('), source.indexOf('function captureResult('))
  assert.match(arm, /const\s+\{stateDir,root\}\s*=\s*prepareCaptureDirectories\(dirname\(dirname\(workDir\)\)\)/)
  assert.ok(arm.indexOf('prepareCaptureDirectories(') < arm.indexOf('invocation(root)'))
  assert.match(arm, /invocation\(root\)/)
  assert.doesNotMatch(arm, /mkdirSync|chmodSync/)
})
