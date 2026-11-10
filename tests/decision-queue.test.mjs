import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { test } from '../scripts/workflow-harness.mjs'
import { createDecisionQueue } from '../core/skills/decisions/queue.mjs'

const NOW = '2026-11-10T12:00:00.000Z'
const REV = 'a'.repeat(40)
const decision = (patch = {}) => ({ schemaVersion: 1, id: 'choice', runId: 'run', repo: '/repo', revision: REV,
  question: 'Which?', reason: 'Choose a mode', options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }],
  recommendation: null, evidence: [], kind: 'question', scope: null, createdAt: NOW, expiresAt: null, ...patch })
const answer = (patch = {}) => ({ answerId: 'answer', actor: 'Local user', at: NOW, value: 'one', revision: REV, ...patch })
const recipient = (patch = {}) => ({ deliveryId: 'delivery', repo: '/repo', runId: 'run', revision: REV, ...patch })
const code = expected => error => error.code === expected && !error.message.includes('PRIVATE_INPUT')
function fixture(work) {
  const root = fs.mkdtempSync(join(tmpdir(), 'decision-queue-unit-'))
  let now = NOW
  const q = createDecisionQueue(root, { now: () => now })
  try { return work(q, root, value => { now = value }) } finally { q.close(); fs.rmSync(root, { recursive: true, force: true }) }
}

await test('queue invalid inputs and failed transitions are safe and leave durable state unchanged', () => fixture(q => {
  q.request(decision())
  const before = q.read('choice')
  for (const value of [null, {}, answer({ extra: 'PRIVATE_INPUT' }), answer({ actor: ' ' }), answer({ at: '2026-02-30T00:00:00Z' }), answer({ answerId: 'x\n' })]) {
    assert.throws(() => q.answer('choice', value), code('INVALID_DECISION'))
    assert.deepEqual(q.read('choice'), before)
  }
  let calls = 0
  const input = answer(); Object.defineProperty(input, 'actor', { get() { calls++; throw Error('PRIVATE_INPUT') } })
  assert.throws(() => q.answer('choice', input), code('INVALID_DECISION')); assert.equal(calls, 0)
  for (const method of ['answer', 'deliver', 'acknowledge', 'cancel']) {
    const value = method === 'answer' ? answer() : method === 'cancel' ? { reason: 'Stop' } : recipient()
    assert.throws(() => q[method]('missing', value), code('NOT_FOUND'))
  }
  assert.throws(() => q.acknowledge('choice', recipient()), code('NOT_READY'))
  q.answer('choice', answer()); q.deliver('choice', recipient())
  assert.throws(() => q.acknowledge('choice', recipient({ deliveryId: 'another' })), code('CONFLICT'))
  assert.equal(q.read('choice').state, 'delivered')
  assert.deepEqual(q.acknowledge('choice', recipient()), { created: true })
  assert.deepEqual(q.answer('choice', answer()), { created: false })
  const snapshot = q.read('choice'); snapshot.answer.actor = 'Changed'; snapshot.delivery.runId = 'Changed'; snapshot.ack.deliveryId = 'Changed'
  assert.equal(q.read('choice').answer.actor, 'Local user'); assert.equal(q.read('choice').ack.deliveryId, 'delivery')
}))

await test('queue orders fractional timestamps precisely and enforces exact expiry and answer time', () => fixture((q, root, clock) => {
  q.request(decision({ id: 'z', createdAt: '2026-11-10T12:00:00Z' }))
  q.request(decision({ id: 'a', createdAt: NOW }))
  q.request(decision({ id: 'fraction', createdAt: '2026-11-10T12:00:00.0001Z', expiresAt: '2026-11-10T12:00:00.0003Z' }))
  assert.deepEqual(q.list().map(x => x.decision.id), ['a', 'z', 'fraction'])
  clock('2026-11-10T12:00:00.0002Z')
  assert.throws(() => q.answer('fraction', answer({ at: '2026-11-10T12:00:00.0000Z' })), code('INVALID_DECISION'))
  assert.throws(() => q.answer('fraction', answer({ at: '2026-11-10T12:00:00.00025Z' })), code('INVALID_DECISION'))
  q.answer('fraction', answer({ at: '2026-11-10T12:00:00.0002Z' })); q.deliver('fraction', recipient())
  clock('2026-11-10T12:00:00.0003Z')
  assert.throws(() => q.acknowledge('fraction', recipient()), code('EXPIRED'))
  assert.equal(q.read('fraction').state, 'delivered')
  clock('PRIVATE_INPUT'); assert.throws(() => q.deliver('fraction', recipient()), code('IO_ERROR'))
}))

await test('queue checks stored snapshots and metadata instead of trusting valid SQLite bytes', () => {
  for (const mutate of [
    db => db.exec('PRAGMA user_version=999'),
    db => db.exec("UPDATE queue_metadata SET namespace='../PRIVATE_INPUT'"),
    db => db.exec("UPDATE decisions SET snapshot='{}'"),
    db => { const row = db.prepare('SELECT snapshot FROM decisions').get(); const value = JSON.parse(row.snapshot); value.state = 'acknowledged'; db.prepare('UPDATE decisions SET snapshot=?').run(JSON.stringify(value)) },
    db => { const row = db.prepare('SELECT snapshot FROM decisions').get(); const value = JSON.parse(row.snapshot); value.decision.id = 'different'; db.prepare('UPDATE decisions SET snapshot=?').run(JSON.stringify(value)) },
  ]) {
    fixture((q, root) => {
      q.request(decision()); q.close()
      const db = new DatabaseSync(join(root, 'decisions.sqlite')); try { mutate(db) } finally { db.close() }
      let reopened
      try { assert.throws(() => { reopened = createDecisionQueue(root); reopened.list() }, code('CORRUPT')) } finally { reopened?.close() }
    })
  }
})

await test('queue rejects unsafe storage on existing connections and closes idempotently', () => fixture((q, root) => {
  q.request(decision())
  const file = join(root, 'decisions.sqlite')
  fs.chmodSync(file, 0o644)
  assert.throws(() => q.cancel('choice', { reason: 'Stop' }), code('CORRUPT'))
  fs.chmodSync(file, 0o600)
  assert.equal(q.read('choice').state, 'pending')
  fs.chmodSync(root, 0o755)
  assert.throws(() => q.read('choice'), code('CORRUPT'))
  fs.chmodSync(root, 0o700)
  q.close(); q.close()
  assert.throws(() => q.readNamespace(), code('IO_ERROR'))
}))

await test('queue cancellation survives restart and unsupported filters fail safely', () => fixture((q, root) => {
  q.request(decision()); q.answer('choice', answer()); q.deliver('choice', recipient()); q.cancel('choice', { reason: 'Withdrawn' })
  q.close()
  const reopened = createDecisionQueue(root, { now: () => NOW })
  try {
    assert.deepEqual(reopened.cancel('choice', { reason: 'Withdrawn' }), { created: false })
    assert.throws(() => reopened.cancel('choice', { reason: 'Different' }), code('CONFLICT'))
    assert.throws(() => reopened.acknowledge('choice', recipient()), code('CANCELLED'))
    assert.equal(reopened.list({ state: 'cancelled' }).length, 1)
    for (const filter of [null, { state: 'PRIVATE_INPUT' }, { typo: true }, { runId: '../x' }, { repo: 'relative' }]) {
      assert.throws(() => reopened.list(filter), code('INVALID_DECISION'))
    }
  } finally { reopened.close() }
}))

await test('queue rolls back failed delivery and acknowledgment commits and remains usable', () => fixture(q => {
  q.request(decision()); q.answer('choice', answer())
  const original = DatabaseSync.prototype.exec
  function failCommit(work) {
    let injected = false
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === 'COMMIT' && !injected) { injected = true; throw Error('PRIVATE_INPUT') }
      return original.call(this, sql)
    }
    try { assert.throws(work, code('IO_ERROR')); assert.equal(injected, true) } finally { DatabaseSync.prototype.exec = original }
  }
  failCommit(() => q.deliver('choice', recipient()))
  assert.equal(q.read('choice').state, 'answered'); assert.equal(q.read('choice').delivery, null)
  q.deliver('choice', recipient())
  failCommit(() => q.acknowledge('choice', recipient()))
  assert.equal(q.read('choice').state, 'delivered'); assert.equal(q.read('choice').ack, null)
  assert.deepEqual(q.acknowledge('choice', recipient()), { created: true })
}))

await test('queue refuses unknown databases and schema changes without resetting their content', () => {
  for (const setup of [
    db => db.exec('CREATE TABLE foreign_data (id TEXT); DROP TABLE foreign_data'),
    db => db.exec('CREATE TABLE foreign_data (id TEXT)'),
    db => db.exec('PRAGMA journal_mode=WAL; CREATE TABLE foreign_data (id TEXT)'),
  ]) {
    const root = fs.mkdtempSync(join(tmpdir(), 'decision-queue-foreign-'))
    try {
      const file = join(root, 'decisions.sqlite')
      fs.writeFileSync(file, '', { mode: 0o600 })
      const db = new DatabaseSync(file); try { setup(db) } finally { db.close() }
      const before = fs.readFileSync(file)
      assert.throws(() => createDecisionQueue(root), code('CORRUPT'))
      assert.deepEqual(fs.readFileSync(file), before)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
})

await test('queue rejects final-newline identifiers at every queue boundary', () => fixture(q => {
  for (const key of ['id', 'runId']) assert.throws(() => q.request(decision({ [key]: 'unsafe\n' })), code('INVALID_DECISION'))
  q.request(decision())
  assert.throws(() => q.read('choice\n'), code('INVALID_DECISION'))
  assert.throws(() => q.answer('choice', answer({ answerId: 'answer\n' })), code('INVALID_DECISION'))
  q.answer('choice', answer())
  assert.throws(() => q.deliver('choice', recipient({ deliveryId: 'delivery\n' })), code('INVALID_DECISION'))
  assert.equal(q.read('choice').state, 'answered')
}))

// Separate SQLite connections in worker isolates exercise lock contention without
// depending on the sandbox's suppressed child-process stdout. The host's frozen
// acceptance retains the separate-process boundary and is not replaced here.
await test('concurrent queue connections agree on namespace and preserve a single answer/delivery winner', async () => {
  const { Worker } = await import('node:worker_threads')
  const root = fs.mkdtempSync(join(tmpdir(), 'decision-queue-concurrent-'))
  const directory = join(root, 'queue')
  const moduleUrl = new URL('../core/skills/decisions/queue.mjs', import.meta.url).href
  function worker(operation) {
    return new Promise((resolve, reject) => {
      const source = `import {parentPort,workerData} from 'node:worker_threads';
        (async()=>{let q;try{const {createDecisionQueue}=await import(workerData.moduleUrl);
        q=createDecisionQueue(workerData.directory,{now:()=>workerData.now});
        const result=q[workerData.operation.method](...workerData.operation.args);
        parentPort.postMessage({ok:true,result});}catch(e){parentPort.postMessage({ok:false,code:e.code})}finally{q?.close()}})()`
      const thread = new Worker(new URL('data:text/javascript,' + encodeURIComponent(source)), { workerData: { moduleUrl, directory, now: NOW, operation } })
      let result
      const timer = setTimeout(() => { thread.terminate(); reject(Error('Queue worker timeout')) }, 15000)
      thread.on('message', value => { result = value })
      thread.once('error', error => { clearTimeout(timer); reject(error) })
      thread.once('exit', status => { clearTimeout(timer); if (status !== 0 || !result) reject(Error('Queue worker failed')); else resolve(result) })
    })
  }
  let q
  try {
    const namespaces = await Promise.all(Array.from({ length: 6 }, () => worker({ method: 'readNamespace', args: [] })))
    assert.ok(namespaces.every(value => value.ok), JSON.stringify(namespaces))
    assert.equal(new Set(namespaces.map(value => value.result)).size, 1)
    const requests = await Promise.all(Array.from({ length: 6 }, (_, i) => worker({ method: 'request', args: [decision({ id: 'request-' + i })] })))
    assert.ok(requests.every(value => value.ok && value.result.created), JSON.stringify(requests))
    q = createDecisionQueue(directory, { now: () => NOW }); q.request(decision())
    for (const method of ['answer', 'deliver']) {
      const results = await Promise.all(Array.from({ length: 4 }, (_, i) => worker({ method, args: ['choice', method === 'answer' ? answer({ answerId: 'answer-' + i }) : recipient({ deliveryId: 'delivery-' + i })] })))
      assert.equal(results.filter(value => value.ok).length, 1, JSON.stringify(results))
      assert.ok(results.filter(value => !value.ok).every(value => value.code === 'CONFLICT'))
    }
    assert.equal(q.list().length, 7)
    const delivered = q.read('choice')
    const acks = await Promise.all(Array.from({ length: 4 }, () => worker({ method: 'acknowledge', args: ['choice', delivered.delivery] })))
    assert.ok(acks.every(value => value.ok)); assert.equal(acks.filter(value => value.result.created).length, 1)
    assert.equal(q.read('choice').state, 'acknowledged')
  } finally { q?.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
