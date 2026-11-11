// native-stage-plan.test.mjs - planNativeStage: one captured plan per pending stage, and a refusal (never a reset) when what was captured changed.
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { NATIVE_CAPTURE_FILE, planNativeStage } from '../skills/security-audit/audit-stage.mjs'
import { newInit, stage, stageDirs } from './stage-fixtures.mjs'

const read = f => JSON.parse(readFileSync(f, 'utf8'))
const refusal = (fn, pattern) => assert.throws(fn, e => e.constructor.name === 'Refusal' && pattern.test(e.message), String(pattern))

console.log('== native stage plan: capture once, refuse changes')
await test('the first call plans the stage and writes a capture marker with digests; a second call returns that stage and does not plan again', () => {
  const { runDir } = newInit()
  const first = planNativeStage(runDir)
  assert.equal(first.captured, false)
  assert.equal(first.step, 'recon')
  assert.equal(first.part, 'facts')
  const marker = read(join(first.stage.dir, NATIVE_CAPTURE_FILE))
  assert.equal(marker.stage, first.stage.name)
  for (const k of ['input_sha256', 'script_sha256', 'workflow_sha256', 'invocation_id']) assert.match(marker[k], /^[0-9a-f]{64}$/, k)
  const inputBefore = readFileSync(join(first.stage.dir, 'input.json'), 'utf8')
  // Evidence the planner reads changes: a plain planStage would now plan the synthesize part (or refuse the file).
  writeFileSync(join(runDir, 'recon-facts.json'), '{}')
  const second = planNativeStage(runDir)
  assert.equal(second.captured, true)
  assert.equal(second.part, 'facts')
  assert.equal(second.stage.name, first.stage.name)
  assert.equal(second.script, first.script)
  assert.equal(readFileSync(join(second.stage.dir, 'input.json'), 'utf8'), inputBefore)
  assert.deepEqual(stageDirs(runDir), [first.stage.name])
  assert.equal(read(join(first.stage.dir, NATIVE_CAPTURE_FILE)).invocation_id, marker.invocation_id)
})

await test('a changed input.json, run.js or workflow digest refuses and leaves the stage as it is', () => {
  for (const [what, change, pattern] of [
    ['input', (dir) => writeFileSync(join(dir, 'input.json'), '{"stage":"recon","tampered":true}'), /input\.json changed/],
    ['script', (dir) => writeFileSync(join(dir, 'run.js'), '// tampered\n'), /run\.js changed/],
    ['workflow', (dir) => { const f = join(dir, NATIVE_CAPTURE_FILE); writeFileSync(f, JSON.stringify({ ...read(f), workflow_sha256: '0'.repeat(64) })) }, /workflow source changed/],
    ['marker', (dir) => writeFileSync(join(dir, NATIVE_CAPTURE_FILE), '{"version":1}'), /not what planNativeStage wrote/],
    ['marker not json', (dir) => writeFileSync(join(dir, NATIVE_CAPTURE_FILE), 'nope'), /not what planNativeStage wrote/],
  ]) {
    const { runDir } = newInit()
    const first = planNativeStage(runDir)
    change(first.stage.dir)
    refusal(() => planNativeStage(runDir), pattern)
    assert.deepEqual(stageDirs(runDir), [first.stage.name], `${what}: no stage was created or reset`)
  }
})

await test('a pending stage with no capture marker (a legacy plan) is refused, not adopted and not replanned', () => {
  const { runDir } = newInit()
  const legacy = stage(['plan', runDir])
  assert.equal(legacy.status, 0, legacy.stdout)
  const before = stageDirs(runDir)
  refusal(() => planNativeStage(runDir), /no native capture marker/)
  assert.deepEqual(stageDirs(runDir), before)
})

await test('a marker whose step is not the next step refuses', () => {
  const { runDir } = newInit()
  const first = planNativeStage(runDir)
  const f = join(first.stage.dir, NATIVE_CAPTURE_FILE)
  writeFileSync(f, JSON.stringify({ ...read(f), step: 'hunt' }))
  refusal(() => planNativeStage(runDir), /captured for hunt, and the next step is recon/)
})

await test('captured invocation and part/byte metadata cannot be silently changed on resume', () => {
  for (const patch of [{ invocation_id: '0'.repeat(64) }, { part: 'synthesize' }, { bytes: 1 }, { input_sha256: ['a'.repeat(64)] }, { extra: true }]) {
    const { runDir } = newInit(), first = planNativeStage(runDir), file = join(first.stage.dir, NATIVE_CAPTURE_FILE)
    assert.match(first.invocationId, /^[a-f0-9]{64}$/)
    assert.equal(planNativeStage(runDir).invocationId, first.invocationId)
    writeFileSync(file, JSON.stringify({ ...read(file), ...patch }))
    refusal(() => planNativeStage(runDir), /capture bindings changed|not what planNativeStage wrote/)
    assert.deepEqual(stageDirs(runDir), [first.stage.name])
  }
})
