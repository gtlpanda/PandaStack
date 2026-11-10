import assert from 'node:assert/strict'
import { test } from '../scripts/workflow-harness.mjs'

const revision = 'a'.repeat(40)
const options = { repo: '/project', revision, invocationRunId: 'outer-1' }
const wait = { queueNamespace: 'queue-1', decisionRunId: 'logical-1', featureId: 'F-1',
  decisionId: 'choice', revision: 'b'.repeat(40), deliveryId: 'delivery-1' }
const invalid = error => error.code === 'INVALID_OBSERVATION' && error.message === 'Invalid decision observation'
const { createDecisionTrace } = await import('../core/skills/decisions/observations.mjs')

function fixture(patch = {}) {
  let mono = 10, wall = '2026-11-10T12:00:00.000Z'
  const events = []
  const trace = createDecisionTrace({ ...options, emit: e => events.push(e), now: () => wall,
    monotonicNow: () => mono, ...patch })
  return { trace, events, time: (m, w = wall) => { mono = m; wall = w } }
}

await test('trace emits exact detached v2 events and independent monotonic spans', () => {
  const { trace, events, time } = fixture()
  const input = { ...wait }, a = trace.startWait(input)
  input.decisionId = 'mutated'; a.repo = '/mutated'; events[0].deliveryId = 'mutated'
  time(20)
  const b = trace.startWait(wait)
  time(35.9, '2026-11-10T11:59:00.000Z')
  const done = trace.finishWait(a.spanId, { answerId: 'answer-1' })
  assert.deepEqual(Object.keys(done).sort(), ['schemaVersion', 'event', 'eventId', 'at', 'traceId',
    'queueNamespace', 'spanId', 'repo', 'decisionRunId', 'invocationRunId', 'featureId',
    'decisionId', 'revision', 'deliveryId', 'answerId', 'waitDurationMs'].sort())
  assert.equal(done.event, 'received'); assert.equal(done.schemaVersion, 2)
  assert.equal(done.waitDurationMs, 25); assert.equal(done.repo, '/project')
  assert.equal(done.deliveryId, wait.deliveryId); assert.equal(done.decisionId, wait.decisionId)
  assert.equal(done.revision, wait.revision); assert.equal(done.traceId, a.traceId)
  const failed = trace.failWait(b.spanId, { outcome: 'stale' })
  assert.equal(failed.waitDurationMs, 15); assert.equal(failed.outcome, 'stale')
  assert.equal(Object.hasOwn(failed, 'answerId'), false)
  assert.equal(new Set(events.map(e => e.eventId)).size, 4)
  assert.notEqual(a.spanId, b.spanId)
  assert.notEqual(fixture().trace.startWait(wait).traceId, b.traceId)
  assert.equal(trace.complete, true)
})

await test('terminal replay is immutable, does not call hooks, and rejects conflicting outcomes', () => {
  let clockCalls = 0
  const { trace, events } = fixture({ monotonicNow: () => ++clockCalls })
  const a = trace.startWait(wait), done = trace.finishWait(a.spanId, { answerId: 'answer' })
  done.answerId = 'mutated'; events[1].answerId = 'mutated'
  assert.equal(trace.finishWait(a.spanId, { answerId: 'answer' }).answerId, 'answer')
  assert.equal(clockCalls, 2); assert.equal(events.length, 2)
  assert.throws(() => trace.finishWait(a.spanId, { answerId: 'other' }), invalid)
  assert.throws(() => trace.failWait(a.spanId, { outcome: 'timeout' }), invalid)
  const b = trace.startWait(wait), failed = trace.failWait(b.spanId, { outcome: 'expired' })
  assert.deepEqual(trace.failWait(b.spanId, { outcome: 'expired' }), failed)
  assert.throws(() => trace.failWait(b.spanId, { outcome: 'failed' }), invalid)
  assert.throws(() => trace.finishWait(b.spanId, { answerId: 'answer' }), invalid)
})

await test('trace rejects unsafe shapes without executing property getters or leaking inputs', () => {
  for (const patch of [{ repo: '/a/../b' }, { repo: 'relative' }, { repo: '/project/' },
    { revision: 'SECRET' }, { invocationRunId: 'SECRET\n' }, { emit: 1 }, { now: null },
    { monotonicNow: null }, { SECRET: 'SECRET' }]) {
    assert.throws(() => createDecisionTrace({ ...options, ...patch }), invalid)
  }
  for (const value of [null, [], 1, 'SECRET', {}]) assert.throws(() => createDecisionTrace(value), invalid)
  const { trace, events } = fixture()
  let getterCalls = 0
  const accessor = { ...wait }
  Object.defineProperty(accessor, 'decisionId', { enumerable: true, get() { getterCalls++; throw Error('SECRET') } })
  for (const value of [null, {}, { ...wait, SECRET: true }, { ...wait, decisionId: 'x'.repeat(81) },
    { ...wait, decisionId: 'choice\n' }, { ...wait, revision: revision.toUpperCase() }, accessor]) {
    assert.throws(() => trace.startWait(value), invalid)
  }
  assert.equal(getterCalls, 0); assert.equal(events.length, 0)
  const a = trace.startWait(wait)
  for (const value of [null, {}, { answerId: 'answer', SECRET: true }, { answerId: 'SECRET\n' }]) {
    assert.throws(() => trace.finishWait(a.spanId, value), invalid)
  }
  assert.throws(() => trace.finishWait('SECRET', { answerId: 'answer' }), invalid)
  assert.throws(() => trace.failWait(a.spanId, { outcome: 'SECRET' }), invalid)
  assert.equal(trace.complete, false)
})

await test('invalid clocks cannot fabricate terminal durations or expose hook errors', () => {
  for (const bad of [NaN, Infinity, -1, '12', null, 0]) {
    const { trace, time, events } = fixture()
    const started = trace.startWait(wait); time(bad)
    assert.throws(() => trace.finishWait(started.spanId, { answerId: 'answer' }), invalid)
    assert.equal(events.length, 1); assert.equal(trace.complete, false)
    time(25)
    assert.equal(trace.failWait(started.spanId, { outcome: 'failed' }).waitDurationMs, 15)
    assert.equal(trace.complete, false)
  }
  for (const now of [() => 'SECRET', () => '2026-02-30T00:00:00Z', () => { throw Error('SECRET') }]) {
    const { trace, events } = fixture({ now })
    assert.throws(() => trace.startWait(wait), invalid); assert.equal(events.length, 0)
  }
  const { trace, events } = fixture({ monotonicNow: () => { throw Error('SECRET') } })
  assert.throws(() => trace.startWait(wait), invalid); assert.equal(events.length, 0)
  const huge = fixture(), started = huge.trace.startWait(wait)
  huge.time(Number.MAX_VALUE)
  assert.throws(() => huge.trace.finishWait(started.spanId, { answerId: 'answer' }), invalid)
  assert.equal(huge.events.length, 1)
  const backwards = fixture(), a = backwards.trace.startWait(wait)
  backwards.time(30); backwards.trace.startWait(wait); backwards.time(20)
  assert.throws(() => backwards.trace.finishWait(a.spanId, { answerId: 'answer' }), invalid)
})

await test('sink failures are swallowed and remain incomplete across exact replay', () => {
  let calls = 0
  const { trace } = fixture({ emit: () => { calls++; throw Error('SECRET') } })
  const start = trace.startWait(wait)
  const done = trace.finishWait(start.spanId, { answerId: 'answer' })
  assert.equal(done.event, 'received'); assert.equal(trace.complete, false)
  assert.deepEqual(trace.finishWait(start.spanId, { answerId: 'answer' }), done)
  assert.equal(calls, 2)
  const plain = fixture().trace
  plain.markIncomplete(); assert.equal(plain.complete, false)
  assert.equal(fixture({ invocationRunId: null }).trace.complete, false)
})

await test('all safe failure outcomes emit exactly once and include no arbitrary data', () => {
  const { trace, events } = fixture()
  for (const outcome of ['timeout', 'cancelled', 'expired', 'stale', 'manual_handoff', 'failed']) {
    const a = trace.startWait(wait), failed = trace.failWait(a.spanId, { outcome })
    assert.equal(failed.event, 'wait_failed'); assert.equal(failed.outcome, outcome)
    assert.equal(failed.waitDurationMs, 0)
    assert.deepEqual(trace.failWait(a.spanId, { outcome }), failed)
  }
  assert.equal(events.length, 12)
  assert.equal(trace.complete, true)
})

await test('default hooks emit one parseable stdout line per observation', () => {
  const write = process.stdout.write, lines = []
  let start, done
  try {
    process.stdout.write = line => { lines.push(line); return true }
    const trace = createDecisionTrace(options)
    start = trace.startWait(wait)
    done = trace.finishWait(start.spanId, { answerId: 'answer' })
    trace.finishWait(start.spanId, { answerId: 'answer' })
  } finally { process.stdout.write = write }
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map(line => {
    assert.match(line, /^PANDASTACK_DECISION \{[^\n]*\}\n$/)
    return JSON.parse(line.slice('PANDASTACK_DECISION '.length))
  }), [start, done])
  assert.ok(done.waitDurationMs >= 0)
})
