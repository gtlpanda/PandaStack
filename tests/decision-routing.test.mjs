import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getEventListeners } from 'node:events'
import { test } from '../scripts/workflow-harness.mjs'
import { createDecisionQueue } from '../core/skills/decisions/queue.mjs'
import { waitForDecision } from '../core/skills/decisions/routing.mjs'
import { main } from '../scripts/pandastack.mjs'

const revision = 'a'.repeat(40)
const request = (patch = {}) => ({ schemaVersion: 1, id: 'choice', runId: 'run', repo: '/project', revision,
  question: 'Which mode?', reason: 'Need a choice', options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }],
  recommendation: null, evidence: [], kind: 'question', scope: null, createdAt: '2026-01-01T00:00:00Z', expiresAt: null, ...patch })
const reply = { answerId: 'answer', value: 'one', actor: 'Fixture user', at: '2026-01-01T00:00:01Z', revision }
const recipient = () => ({ repo: '/project', runId: 'run', revision, deliveryId: 'delivery' })
const code = expected => error => error.code === expected && !error.message.includes('PRIVATE_INPUT')
async function fixture(work) {
  const root = mkdtempSync(join(tmpdir(), 'decision-routing-unit-'))
  const store = join(root, 'queue'), queue = createDecisionQueue(store)
  try { await work(queue, root, store) } finally { queue.close(); rmSync(root, { recursive: true, force: true }) }
}

await test('wait snapshots the recipient, isolates requests, and replays delivery after reopen without ack', () => fixture(async (queue, root, store) => {
  queue.request(request()); queue.request(request({ id: 'other', runId: 'other-run' }))
  const target = recipient(), controller = new AbortController()
  const waiting = waitForDecision({ queue, id: 'choice', recipient: target, pollMs: 5, timeoutMs: 500, signal: controller.signal })
  target.runId = 'other-run'; target.deliveryId = 'mutated'
  queue.answer('other', reply)
  assert.equal(queue.read('choice').delivery, null)
  queue.answer('choice', reply)
  const delivered = await waiting
  assert.equal(delivered.state, 'delivered'); assert.deepEqual(delivered.delivery, recipient()); assert.equal(delivered.ack, null)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  const reopened = createDecisionQueue(store)
  try {
    assert.deepEqual(await waitForDecision({ queue: reopened, id: 'choice', recipient: recipient() }), delivered)
    assert.deepEqual(reopened.acknowledge('choice', recipient()), { created: true })
    assert.equal((await waitForDecision({ queue, id: 'choice', recipient: recipient() })).state, 'acknowledged')
  } finally { reopened.close() }
  assert.equal(queue.read('other').delivery, null)
}))

await test('wait rejects pending wrong/stale recipients, missing requests, cancellation, expiry and closed storage', () => fixture(async queue => {
  queue.request(request())
  const opts = { queue, id: 'choice', recipient: recipient(), pollMs: 5, timeoutMs: 100 }
  await assert.rejects(waitForDecision({ ...opts, recipient: { ...recipient(), repo: '/elsewhere' } }), code('WRONG_RECIPIENT'))
  await assert.rejects(waitForDecision({ ...opts, recipient: { ...recipient(), revision: 'b'.repeat(40) } }), code('STALE'))
  await assert.rejects(waitForDecision({ ...opts, id: 'missing' }), code('NOT_FOUND'))
  const waiting = waitForDecision(opts); queue.cancel('choice', { reason: 'No longer needed' })
  await assert.rejects(waiting, code('CANCELLED'))
  queue.request(request({ id: 'expired', expiresAt: '2026-01-01T00:00:02Z' }))
  await assert.rejects(waitForDecision({ ...opts, id: 'expired' }), code('EXPIRED'))
  queue.close()
  await assert.rejects(waitForDecision(opts), code('IO_ERROR'))
}))

await test('wait bounds timeout independently of poll interval and removes abort listeners', () => fixture(async queue => {
  queue.request(request())
  const controller = new AbortController(), opts = { queue, id: 'choice', recipient: recipient(), signal: controller.signal, pollMs: 1000, timeoutMs: 15 }
  const start = performance.now()
  await assert.rejects(waitForDecision(opts), code('TIMEOUT'))
  assert.ok(performance.now() - start < 800, 'timeout must not wait a full poll interval')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  const waiting = waitForDecision({ ...opts, timeoutMs: 1000 }); controller.abort(Error('PRIVATE_INPUT'))
  await assert.rejects(waiting, code('CANCELLED'))
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  queue.answer('choice', reply)
  await assert.rejects(waitForDecision(opts), code('CANCELLED'))
  assert.equal(queue.read('choice').delivery, null)
}))

await test('wait rejects invalid bounds and shapes and never retries storage errors', async () => {
  let calls = 0
  const queue = { deliver() { calls++; throw Error('PRIVATE_INPUT') } }
  const opts = { queue, id: 'choice', recipient: recipient() }
  for (const value of [null, 0, -1, 1.5, NaN, Infinity, '10', 2147483648]) {
    await assert.rejects(waitForDecision({ ...opts, pollMs: value }), code('INVALID_DECISION'))
  }
  for (const value of [null, -1, 1.5, NaN, Infinity, '10', 2147483648]) {
    await assert.rejects(waitForDecision({ ...opts, timeoutMs: value }), code('INVALID_DECISION'))
  }
  for (const value of [null, {}, { ...opts, signal: {} }, { ...opts, extra: true }, { ...opts, recipient: null }]) {
    await assert.rejects(waitForDecision(value), code('INVALID_DECISION'))
  }
  assert.equal(calls, 0)
  await assert.rejects(waitForDecision(opts), code('IO_ERROR')); assert.equal(calls, 1)
})

async function cli(args) {
  const out = [], err = [], log = console.log, error = console.error
  console.log = value => out.push(value); console.error = value => err.push(value)
  try { return { status: await main(['decision', ...args]), out, err } }
  finally { console.log = log; console.error = error }
}

await test('decision CLI commands share native state, preserve inert input and require explicit ack', () => fixture(async (queue, root, store) => {
  const file = join(root, 'request file.json'), who = join(root, 'recipient.json'), answerFile = join(root, 'answer.json'), marker = join(root, 'marker')
  const decision = request({ question: `Inert $(touch ${marker}) and \`touch ${marker}\`` })
  writeFileSync(file, JSON.stringify(decision)); writeFileSync(who, JSON.stringify(recipient())); writeFileSync(answerFile, JSON.stringify(reply))
  const run = async (command, ...args) => {
    const result = await cli([command, '--store', store, ...args])
    assert.equal(result.status, 0, result.err.join('\n')); assert.deepEqual(result.err, []); assert.equal(result.out.length, 1)
    return JSON.parse(result.out[0])
  }
  assert.deepEqual(await run('request', '--file', file), { created: true })
  assert.deepEqual(await run('request', '--file', file), { created: false })
  assert.equal((await run('list', '--repo', '/project', '--run-id', 'run')).length, 1)
  assert.deepEqual(await run('list', '--run-id', 'other'), [])
  assert.equal((await run('show', '--id', 'choice')).decision.question, decision.question)
  assert.equal(await run('show', '--id', 'missing'), null)
  assert.deepEqual(await run('answer', '--id', 'choice', '--file', answerFile), { created: true })
  assert.equal((await run('wait', '--id', 'choice', '--file', who, '--timeout-ms', '0')).state, 'delivered')
  assert.equal(queue.read('choice').ack, null)
  assert.deepEqual(await run('ack', '--id', 'choice', '--file', who), { created: true })
  assert.deepEqual(await run('ack', '--id', 'choice', '--file', who), { created: false })
  assert.equal((await run('wait', '--id', 'choice', '--file', who)).state, 'acknowledged')
  queue.request(request({ id: 'cancel' }))
  assert.deepEqual(await run('cancel', '--id', 'cancel', '--reason', 'Finished'), { created: true })
  assert.equal(queue.read('cancel').state, 'cancelled'); assert.equal(existsSync(marker), false)
}))

await test('decision CLI validates syntax before opening storage and redacts file/queue errors', () => fixture(async (queue, root) => {
  const store = join(root, 'must-not-create'), base = ['--store', store]
  for (const args of [[], ['unknown', ...base], ['list', ...base, ...base], ['list', ...base, '--unknown', 'value'],
    ['show', ...base], ['list', ...base, '--id', 'choice'], ['list', '--store'], ['list', ...base, 'extra'],
    ...['NaN', '-1', '1.5', '1e2', '0x10', ' 1', '1\n', '2147483648'].map(n => ['wait', ...base, '--id', 'choice', '--file', 'unused', '--timeout-ms', n])]) {
    const result = await cli(args)
    assert.equal(result.status, 1); assert.deepEqual(result.out, []); assert.equal(JSON.parse(result.err[0]).error, 'INVALID_DECISION')
    assert.equal(existsSync(store), false)
  }
  const file = join(root, 'bad.json'); writeFileSync(file, '{"data":"PRIVATE_INPUT"')
  for (const path of [file, join(root, 'PRIVATE_INPUT')]) {
    const result = await cli(['request', ...base, '--file', path])
    assert.equal(result.status, 1); assert.deepEqual(result.out, []); assert.equal(result.err.length, 1)
    assert.ok(!result.err[0].includes('PRIVATE_INPUT')); assert.ok(!result.err[0].includes('JSON.parse'))
    assert.equal(existsSync(store), false)
  }
}))

await test('decision CLI waits for native answers and reports timeout/conflict safely without acknowledgment', () => fixture(async (queue, root, store) => {
  queue.request(request())
  const who = join(root, 'recipient.json'); writeFileSync(who, JSON.stringify(recipient()))
  const args = ['wait', '--store', store, '--id', 'choice', '--file', who, '--timeout-ms']
  const timeout = await cli([...args, '0'])
  assert.equal(timeout.status, 1); assert.deepEqual(timeout.out, []); assert.deepEqual(JSON.parse(timeout.err[0]), { error: 'TIMEOUT' })
  assert.equal(queue.read('choice').delivery, null)
  const timer = setTimeout(() => queue.answer('choice', reply), 10)
  try {
    const result = await cli([...args, '1000'])
    assert.equal(result.status, 0); assert.deepEqual(result.err, []); assert.equal(JSON.parse(result.out[0]).state, 'delivered')
  } finally { clearTimeout(timer) }
  assert.equal(queue.read('choice').ack, null)
  writeFileSync(who, JSON.stringify({ ...recipient(), deliveryId: 'competing' }))
  const conflict = await cli([...args, '1000'])
  assert.equal(conflict.status, 1); assert.deepEqual(conflict.out, []); assert.deepEqual(JSON.parse(conflict.err[0]), { error: 'CONFLICT' })
  assert.equal(queue.read('choice').ack, null)
}))
