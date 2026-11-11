import assert from 'node:assert/strict'
import { test } from '../scripts/workflow-harness.mjs'
import { createRun, sanitizeSettings, validateRun, validateEvent } from '../core/skills/run-records/records.mjs'

const base = () => ({ schemaVersion: 1, id: 'run-1', repo: '/tmp/project', revision: null,
  runnerRoot: '/tmp/runner', runnerRevision: 'a'.repeat(64), workflow: 'autobuild',
  backend: 'codex', parentRunId: null, startedAt: '2024-02-29T12:00:00.123Z', settings: {} })
const event = () => ({ schemaVersion: 1, id: 'event-1', runId: 'run-1', type: 'started', at: base().startedAt, exitCode: null })
const rejects = value => assert.throws(() => createRun(value), { code: 'INVALID_RECORD' })

await test('run records default only version and parent, clone settings, and require every other field', () => {
  const input = base()
  delete input.schemaVersion; delete input.parentRunId
  input.settings = { model: null, sources: { model: 'unknown' }, prompt: 'SECRET' }
  const before = structuredClone(input)
  const result = createRun(input)
  assert.deepEqual(validateRun(result), [])
  assert.equal(result.schemaVersion, 1); assert.equal(result.parentRunId, null)
  assert.deepEqual(input, before)
  result.settings.sources.model = 'cli'
  assert.equal(input.settings.sources.model, 'unknown')
  for (const key of Object.keys(base())) {
    const missing = base(); delete missing[key]
    assert.ok(validateRun(missing).length, key)
    if (!['schemaVersion', 'parentRunId'].includes(key)) rejects(missing)
  }
})

await test('settings preserve all safe roles and sources without retaining unknown payloads', () => {
  const input = { maxConcurrentSubagents: 8, subagentModelForce: false, sources: {}, env: { token: 'SECRET' } }
  for (const prefix of ['', 'subagent', 'advisor', 'probe']) {
    const model = prefix ? `${prefix}Model` : 'model'
    const effort = prefix ? `${prefix}Effort` : 'effort'
    input[model] = 'provider/model:1.2-beta'; input[effort] = null
    input.sources[model] = 'runtime'
  }
  input.sources.token = 'SECRET'
  const safe = sanitizeSettings(input)
  assert.ok(!JSON.stringify(safe).includes('SECRET'))
  assert.equal(safe.probeModel, input.probeModel)
  assert.deepEqual(validateRun({ ...base(), settings: safe }), [])
  assert.ok(validateRun({ ...base(), settings: input }).length)
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none', null]) {
    assert.deepEqual(sanitizeSettings({ effort }), { effort })
  }
})

await test('known settings reject invalid types, secrets, and invalid provenance', () => {
  for (const input of [null, [], 0, 'settings', { model: '' }, { model: 'name token' },
    { model: 'https://host?token=SECRET' }, { effort: 'auto' }, { subagentModelForce: 1 },
    { maxConcurrentSubagents: Number.MAX_SAFE_INTEGER + 1 }, { sources: [] },
    { sources: { model: 'SECRET' } }, { model: undefined },
    ...[0, -1, 1.2, '8', NaN, Infinity, null].map(maxConcurrentSubagents => ({ maxConcurrentSubagents }))]) {
    assert.throws(() => sanitizeSettings(input), { code: 'INVALID_RECORD' })
    assert.ok(validateRun({ ...base(), settings: input }).length)
  }
})

await test('validators reject malformed records, unsafe IDs, unknown fields and invalid dates without throwing', () => {
  for (const value of [null, undefined, [], 0, true, 'record', new Date(), Object.create({ id: 'inherited' })]) {
    assert.ok(validateRun(value).length); assert.ok(validateEvent(value).length); rejects(value)
  }
  for (const patch of [{ id: '../escape' }, { id: 'a/b' }, { id: 'a\n' }, { id: 'x'.repeat(81) },
    { repo: 'relative' }, { runnerRoot: 'x' }, { revision: undefined }, { revision: 'a'.repeat(41) },
    { parentRunId: 'run-1' }, { backend: 'other' }, { workflow: 'other' }, { schemaVersion: '1' },
    { extra: 'SECRET' }, { startedAt: '2023-02-29T12:00:00Z' }, { startedAt: '2024-04-31T12:00:00Z' },
    { startedAt: '2024-02-29T24:00:00Z' }, { startedAt: '2024-02-29T12:00:00+00:00' }]) {
    const run = { ...base(), ...patch }; assert.ok(validateRun(run).length); rejects(run)
  }
  const hostile = { get id() { throw Error('SECRET') } }
  assert.ok(validateRun(hostile).length); assert.ok(validateEvent(hostile).length)
  assert.ok(!validateRun(hostile).join().includes('SECRET'))
  assert.deepEqual(validateRun({ ...base(), id: 'a'.repeat(80), revision: 'F'.repeat(40) }), [])
})

await test('event lifecycle requires exact exit code combinations and complete immutable shapes', () => {
  for (const type of ['started', 'finished', 'failed', 'cancelled']) {
    for (const exitCode of [null, 0, 1, 130, 255, -1, 256, 1.5, '0', undefined]) {
      const validCode = Number.isInteger(exitCode) && exitCode > 0 && exitCode <= 255
      const valid = type === 'started' ? exitCode === null : type === 'finished' ? exitCode === 0
        : type === 'failed' ? validCode : exitCode === null || validCode
      assert.equal(validateEvent({ ...event(), type, exitCode }).length === 0, valid, `${type}: ${exitCode}`)
    }
  }
  for (const key of Object.keys(event())) {
    const missing = event(); delete missing[key]; assert.ok(validateEvent(missing).length)
  }
  for (const patch of [{ runId: '../escape' }, { id: '' }, { type: 'unknown' }, { output: 'SECRET' }, { at: 'yesterday' }]) {
    assert.ok(validateEvent({ ...event(), ...patch }).length)
  }
})
