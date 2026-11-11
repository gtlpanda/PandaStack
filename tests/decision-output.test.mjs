import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { test } from '../scripts/workflow-harness.mjs'
import { createDecisionTrace } from '../core/skills/decisions/observations.mjs'

const scope = { queueNamespace: 'queue', decisionRunId: 'logical', featureId: 'F-1',
  decisionId: 'choice', revision: 'a'.repeat(40), deliveryId: 'delivery' }
const trace = patch => createDecisionTrace({ repo: '/fixture', revision: scope.revision,
  invocationRunId: 'outer', ...patch })
const tick = () => new Promise(resolve => setImmediate(resolve))
async function withOutput(stream, work) {
  const original = Object.getOwnPropertyDescriptor(process, 'stdout')
  Object.defineProperty(process, 'stdout', { configurable: true, value: stream })
  try { await work() } finally { Object.defineProperty(process, 'stdout', original); stream.destroy() }
}

await test('close-only sink failure preserves incomplete detached replay and intended references', () => {
  for (const received of [false, true]) {
    const events = [], t = trace({ emit: event => {
      events.push(structuredClone(event))
      if (event.event === 'trace_closed') throw Error('synthetic closing failure')
    } })
    if (received) t.finishWait(t.startWait(scope).spanId, { answerId: 'answer' })
    assert.equal(t.complete, true)
    const closed = t.close(), expected = structuredClone(closed)
    assert.equal(closed.complete, false); assert.equal(t.complete, false)
    assert.deepEqual(closed.eventIds, events.slice(0, -1).map(e => e.eventId))
    closed.eventIds.push('changed'); closed.complete = true
    assert.deepEqual(t.close(), expected)
    assert.equal(events.filter(e => e.event === 'trace_closed').length, 1)
  }
})

await test('default output keeps received result through asynchronous stream failure without replay', async () => {
  let failWrite, writes = 0
  const stream = new Writable({ write(chunk, encoding, callback) {
    writes++
    if (writes === 1) callback()
    else failWrite = callback
  } })
  await withOutput(stream, async () => {
    const t = trace(), waiting = t.startWait(scope)
    const received = t.finishWait(waiting.spanId, { answerId: 'answer' })
    const expected = structuredClone(received)
    assert.equal(stream.listenerCount('error'), 1)
    failWrite(Object.assign(Error('synthetic pipe failure'), { code: 'EPIPE' }))
    await tick()
    assert.equal(t.complete, false)
    assert.deepEqual(received, expected)
    assert.deepEqual(t.finishWait(waiting.spanId, { answerId: 'answer' }), expected)
    assert.equal(t.close().complete, false); assert.equal(writes, 2)
  })
})

await test('bounded output completion retains every event through temporary backpressure', async () => {
  const { flushDecisionOutput } = await import('../core/skills/decisions/output.mjs')
  const lines = []; let release, blocked = true
  const stream = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {
    lines.push(chunk.toString())
    if (blocked) { blocked = false; release = callback } else callback()
  } })
  await withOutput(stream, async () => {
    const t = trace()
    for (let i = 0; i < 200; i++) {
      const waiting = t.startWait({ ...scope, decisionId: `choice-${i}` })
      t.finishWait(waiting.spanId, { answerId: `answer-${i}` })
      t.contextSupplied(waiting.spanId, { providerRunId: 'child', launchId: 'launch' })
    }
    const closed = t.close()
    assert.ok(stream.writableLength > 0)
    let finished = false
    const flushed = flushDecisionOutput().then(result => { finished = true; return result })
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(finished, false)
    release(); assert.equal(await flushed, true)
    const events = lines.map(line => JSON.parse(line.slice(20)))
    assert.equal(events.length, 601); assert.deepEqual(events.at(-1), closed)
    assert.deepEqual(closed.eventIds, events.slice(0, -1).map(e => e.eventId))
    assert.equal(t.complete, true); assert.deepEqual(t.close(), closed)
    assert.equal(lines.length, 601)
    assert.equal(await flushDecisionOutput(), true)
  })
})

await test('synchronously broken default output preserves work and incomplete close without retry', async () => {
  const { flushDecisionOutput } = await import('../core/skills/decisions/output.mjs')
  let attempts = 0
  const stream = new Writable({ write(chunk, encoding, callback) { callback() } })
  stream.write = () => { attempts++; throw Error('synthetic stdout exception') }
  await withOutput(stream, async () => {
    const t = trace(), waiting = t.startWait(scope)
    assert.equal(t.finishWait(waiting.spanId, { answerId: 'answer' }).answerId, 'answer')
    assert.equal(t.close().complete, false)
    assert.equal(await flushDecisionOutput(), false); assert.equal(attempts, 3)
    t.close(); assert.equal(attempts, 3)
  })
})

await test('permanently blocked output has bounded completion and cannot regain complete replay', async () => {
  const { flushDecisionOutput } = await import('../core/skills/decisions/output.mjs')
  let release
  const stream = new Writable({ write(chunk, encoding, callback) { release = callback } })
  await withOutput(stream, async () => {
    const t = trace(), closed = t.close(), started = performance.now()
    assert.equal(closed.complete, true, 'snapshot precedes asynchronous output outcome')
    assert.equal(await flushDecisionOutput(20), false)
    assert.ok(performance.now() - started < 1000)
    assert.equal(t.complete, false); assert.equal(t.close().complete, false)
    release(); await tick()
    assert.equal(t.complete, false); assert.equal(t.close().complete, false)
  })
})

await test('late close-write failure degrades cached closure and many traces share one error listener', async () => {
  const { flushDecisionOutput } = await import('../core/skills/decisions/output.mjs')
  let release
  const stream = new Writable({ write(chunk, encoding, callback) { release = callback } })
  await withOutput(stream, async () => {
    const traces = Array.from({ length: 20 }, () => trace())
    for (const t of traces) t.close()
    assert.equal(stream.listenerCount('error'), 1)
    const flushed = flushDecisionOutput()
    release(Error('synthetic output failure')); await tick()
    assert.equal(await flushed, false)
    for (const t of traces) {
      assert.equal(t.complete, false); assert.equal(t.close().complete, false)
    }
  })
})
