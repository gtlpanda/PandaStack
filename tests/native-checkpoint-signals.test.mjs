import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { loadWorkflowRegistry } from '../core/skills/native-runtime/registry.mjs'
import { createNativeRuntime } from '../core/skills/native-runtime/runtime.mjs'

const paths = { 'blueprint-design': 'blueprint', 'bughunt-flow': 'hunt', 'dev-build': 'dev',
  'harness-repair': 'qa', 'release-flow': 'release', 'security-audit-flow': 'security-audit' }
const registry = loadWorkflowRegistry({ installationRoot: REPO, workflowHashes: Object.fromEntries(
  Object.entries(paths).map(([id, dir]) => [id, createHash('sha256')
    .update(readFileSync(`${REPO}/graphs/${dir}/workflows/${id}.js`)).digest('hex')])) })
const code = expected => e => e?.code === expected
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const answer = req => ({ outcome: 'returned', usage: null,
  receipt: { ...req.selection, invocationId: 'inert-call' },
  wire: { json: JSON.stringify(req.agentType === 'checker'
    ? { verdict: 'PASS', verify_block: 'VERIFY: PASS', failures: [] }
    : { files_reviewed: 1, findings: [] }) } })
async function fixture(ports, check) {
  const controller = new AbortController(), requests = []
  const checkpoints = { reserve: async () => ({ state: 'dispatch' }), settle: async () => {}, uncertain: async () => {}, ...ports.checkpoints }
  const runtime = createNativeRuntime({ registry, checkpoints, signal: controller.signal,
    provider: { async runLeaf(req) { requests.push(req); return ports.respond ? ports.respond(req) : answer(req) } },
    resolveLeaf: () => ({ selection: { provider: 'codex', model: 'inert', effort: 'high' }, profile: 'source-review' }),
    maxConcurrentSubagents: 1, deadlineMs: Date.now() + 5000 })
  const run = () => runtime.run('harness-repair', { repo: '/inert' }, { invocationId: 'signal-lifetime' })
  try { await check({ runtime, controller, requests, run }) }
  finally { await runtime.close() }
}

await test('reserve lifetime never inspects accessor or Proxy state before inert validation', async () => {
  let hooks = 0
  const trap = () => { hooks++; throw Error('must not inspect checkpoint state') }
  const getter = Object.defineProperty({}, 'state', { enumerable: true, get: trap })
  const proxy = new Proxy({ state: 'dispatch' }, { get(target, key) {
    // Promise assimilation is outside the JSON boundary; do not count its then lookup.
    if (key === 'then') return undefined
    return trap()
  }, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap })
  for (const result of [getter, proxy]) await fixture({ checkpoints: { reserve: async () => result } }, async f => {
    await assert.rejects(f.run(), code('CHECKPOINT_ERROR'))
    assert.equal(f.requests.length, 0)
  })
  assert.equal(hooks, 0)
})

await test('reserve signal stays linked after provider response until terminal persistence joins', async () => {
  const entered = deferred(), release = deferred()
  let reserveSignal, settleSignal
  await fixture({ checkpoints: {
    reserve: async (_binding, { signal }) => { reserveSignal = signal; return { state: 'dispatch' } },
    settle: async (_id, _completion, { signal }) => { settleSignal = signal; entered.resolve(); await release.promise },
  } }, async f => {
    const rejected = assert.rejects(f.run(), code('CHECKPOINT_UNCERTAIN'))
    try {
      await entered.promise
      assert.equal(reserveSignal.aborted, false)
      f.controller.abort()
      await rejected
      assert.equal(reserveSignal.aborted, true)
      assert.equal(settleSignal.aborted, true)
      assert.equal(f.requests.length, 1)
    } finally { release.resolve(); await rejected }
  })
})

await test('terminal leaf ownership detaches reserve cancellation before later leaves run', async () => {
  const signals = [], entered = deferred()
  await fixture({ checkpoints: { reserve: async (_binding, { signal }) => {
    signals.push(signal); return { state: 'dispatch' }
  } }, respond: req => req.agentType === 'checker' ? answer(req) : new Promise(resolve => {
    req.signal.addEventListener('abort', () => resolve(answer(req)), { once: true }); entered.resolve()
  }) }, async f => {
    const rejected = assert.rejects(f.run(), code('RUNTIME_ABORTED'))
    await entered.promise
    f.controller.abort(); await rejected
    assert.equal(signals.length, 2)
    assert.equal(signals[0].aborted, false)
    assert.equal(signals[1].aborted, true)
    assert.equal(f.requests.length, 2)
  })
})

await test('controlled settle pause returns detached blockers and grants no subsequent leaf', async () => {
  const blockers = ['paused_budget', 'report_stale']
  await fixture({ checkpoints: { settle: async () => ({ state: 'paused', blockers }) } }, async f => {
    let paused
    await assert.rejects(f.run(), e => { paused = e; return e.code === 'CONTROL_PAUSED' })
    blockers.length = 0
    assert.deepEqual(paused.blockers, ['paused_budget', 'report_stale'])
    assert.equal(f.requests.length, 1)
    assert.equal(f.requests[0].signal.aborted, false)
  })
})

await test('malformed controlled pause remains fatal instead of becoming a successful graph result', async () => {
  for (const blockers of [[], ['report_stale', 'paused_budget'], ['paused_budget', 'paused_budget'], ['invented']]) {
    await fixture({ checkpoints: { settle: async () => ({ state: 'paused', blockers }) } }, async f => {
      await assert.rejects(f.run(), code('CHECKPOINT_ERROR'))
      assert.equal(f.requests.length, 1)
    })
  }
})
