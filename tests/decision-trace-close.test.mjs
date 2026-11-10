import assert from 'node:assert/strict'
import { test } from '../scripts/workflow-harness.mjs'
import { createDecisionTrace } from '../core/skills/decisions/observations.mjs'

const scope = { queueNamespace: 'queue', decisionRunId: 'logical', featureId: 'F-1',
  decisionId: 'choice', revision: 'b'.repeat(40), deliveryId: 'delivery' }
const invalid = e => e.code === 'INVALID_OBSERVATION'
function fixture(patch = {}) {
  const events = []
  const trace = createDecisionTrace({ repo: '/fixture', revision: 'a'.repeat(40), invocationRunId: 'outer',
    emit: e => events.push(e), ...patch })
  return { trace, events }
}

await test('close inventories interleaved spans and distinct launches, detached from sink and caller', () => {
  const { trace, events } = fixture()
  const a = trace.startWait(scope), b = trace.startWait({ ...scope, decisionId: 'other' })
  trace.failWait(b.spanId, { outcome: 'cancelled' })
  trace.finishWait(a.spanId, { answerId: 'answer' })
  const supplied = trace.contextSupplied(a.spanId, { providerRunId: null, launchId: 'launch-1' })
  trace.contextSupplied(a.spanId, { providerRunId: 'child', launchId: 'launch-2' })
  assert.deepEqual(trace.contextSupplied(a.spanId, { providerRunId: null, launchId: 'launch-1' }), supplied)
  const expectedIds = events.map(e => e.eventId)
  const closed = trace.close(), original = structuredClone(closed)
  assert.equal(closed.complete, true)
  assert.equal(closed.revision, 'a'.repeat(40))
  assert.deepEqual(closed.spanIds, [a.spanId, b.spanId])
  assert.deepEqual(closed.eventIds, expectedIds)
  assert.deepEqual(closed.contextEventIds, events.filter(e => e.event === 'context_supplied').map(e => e.eventId))
  closed.eventIds.push('tampered'); events.at(-1).spanIds.length = 0
  assert.deepEqual(trace.close(), original)
  for (const mutate of [() => trace.startWait(scope), () => trace.markIncomplete(),
    () => trace.finishWait(a.spanId, { answerId: 'answer' }),
    () => trace.contextSupplied(a.spanId, { providerRunId: null, launchId: 'launch-1' })]) assert.throws(mutate, invalid)
  assert.deepEqual(trace.close(), original)
  assert.equal(events.length, 7)
})

await test('receipt inputs are exact inert data and invalid calls permanently degrade coverage', () => {
  const { trace, events } = fixture(), a = trace.startWait(scope)
  assert.throws(() => trace.contextSupplied(a.spanId, { providerRunId: 'child', launchId: 'launch' }), invalid)
  trace.finishWait(a.spanId, { answerId: 'answer' })
  let getters = 0
  const accessor = { launchId: 'launch', get providerRunId() { getters++; return 'child' } }
  for (const value of [null, {}, { providerRunId: 'child', launchId: 'launch', extra: true },
    { providerRunId: 'bad\n', launchId: 'launch' }, { providerRunId: 'child', launchId: '' }, accessor]) {
    assert.throws(() => trace.contextSupplied(a.spanId, value), invalid)
  }
  assert.equal(getters, 0)
  trace.contextSupplied(a.spanId, { providerRunId: 'child', launchId: 'launch' })
  assert.throws(() => trace.contextSupplied(a.spanId, { providerRunId: 'other', launchId: 'launch' }), invalid)
  assert.equal(trace.close().complete, false)
  assert.equal(events.length, 4)
})

await test('sink and clock failures cannot manufacture complete closure or duplicate intended events', () => {
  const attempts = []
  let brokenClock = false
  const { trace } = fixture({ now: () => brokenClock ? 'invalid' : '2026-11-10T12:00:00Z',
    emit: e => { attempts.push(structuredClone(e)); e.eventId = 'tampered'; throw Error('synthetic sink error') } })
  const a = trace.startWait(scope)
  trace.finishWait(a.spanId, { answerId: 'answer' })
  trace.contextSupplied(a.spanId, { providerRunId: 'child', launchId: 'launch' })
  brokenClock = true
  assert.throws(() => trace.close(), invalid)
  brokenClock = false
  const closed = trace.close()
  assert.equal(closed.complete, false)
  assert.deepEqual(closed.eventIds, attempts.slice(0, -1).map(e => e.eventId))
  assert.deepEqual(trace.close(), closed)
  assert.equal(attempts.length, 4)
  assert.equal(fixture({ invocationRunId: null }).trace.close().complete, false)
  const open = fixture(); open.trace.startWait(scope); assert.equal(open.trace.close().complete, false)
  const zero = fixture().trace.close(); assert.equal(zero.complete, true); assert.deepEqual(zero.eventIds, [])
})
