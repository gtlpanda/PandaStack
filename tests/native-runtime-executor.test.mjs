import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { test, REPO, load, run } from '../scripts/workflow-harness.mjs'

const api = async () => ({ ...await import('../core/skills/native-runtime/registry.mjs'),
  ...await import('../core/skills/native-runtime/runtime.mjs') })
const ids = ['blueprint-design', 'bughunt-flow', 'dev-build', 'harness-repair', 'release-flow', 'security-audit-flow']
const dirs = ['blueprint', 'hunt', 'dev', 'qa', 'release', 'security-audit']
const hashes = () => Object.fromEntries(ids.map((id, i) => [id, createHash('sha256')
  .update(readFileSync(`${REPO}/graphs/${dirs[i]}/workflows/${id}.js`)).digest('hex')]))
const coded = code => e => e.code === code
const check = { verdict: 'PASS', verify_block: 'VERIFY: PASS', failures: [] }
const review = { files_reviewed: 1, findings: [] }
const answer = req => req.agentType === 'checker' ? check : review
const envelope = (req, value = answer(req)) => ({ outcome: 'returned', wire: { json: JSON.stringify(value) },
  usage: null, receipt: { ...req.selection, invocationId: 'fixture-call' } })
const args = { repo: '/inert/project' }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function setup(overrides = {}) {
  const { respond, ...runtimeOptions } = overrides
  const { loadWorkflowRegistry, createNativeRuntime } = await api()
  const requests = [], rows = new Map()
  const checkpoints = {
    async reserve(binding) {
      const old = rows.get(binding.callId)
      if (old) {
        assert.deepEqual(binding, old.binding)
        return old.completion ? { state: 'completed', completion: old.completion } : { state: 'uncertain' }
      }
      rows.set(binding.callId, { binding: structuredClone(binding) })
      return { state: 'dispatch' }
    },
    async settle(id, completion) { rows.get(id).completion = structuredClone(completion) },
    async uncertain(id) { rows.get(id).uncertain = true },
    ...overrides.checkpoints,
  }
  const provider = { async runLeaf(req) {
    requests.push(req)
    return respond ? respond(req) : envelope(req)
  } }
  const registry = loadWorkflowRegistry({ installationRoot: REPO, workflowHashes: hashes() })
  const runtime = createNativeRuntime({ registry, provider, checkpoints,
    resolveLeaf: () => ({ selection: { provider: 'codex', model: 'fixture', effort: 'high' }, profile: 'source-review' }),
    maxConcurrentSubagents: 2, deadlineMs: Date.now() + 10000, ...runtimeOptions, checkpoints, provider })
  return { runtime, requests, rows }
}
async function using(options, fn) {
  const f = await setup(options)
  try { await fn(f) } finally { await f.runtime.close().catch(() => {}) }
}

await test('native executor matches trusted harness QA ledger exactly', async () => {
  const expected = await run(load(`${REPO}/graphs/qa/workflows/harness-repair.js`).fn,
    { checker: [check], reviewer: [review], 'qa-auditor': [review] }, args)
  await using({}, async f => {
    assert.deepEqual(await f.runtime.run('harness-repair', args, { invocationId: 'qa' }), expected.result)
    assert.deepEqual(f.requests.map(r => r.agentType), expected.calls.map(r => r.agentType))
    assert.ok([...f.rows.values()].every(r => r.completion))
  })
})

await test('native executor rejects input hooks and proxies without calling them', async () => {
  await using({}, async f => {
    let touched = 0
    for (const input of [{ get repo() { touched++; return '/' } },
      new Proxy({}, { ownKeys() { touched++; return [] } }), { repo: Infinity }, { repo: 'a'.repeat(1048576) }]) {
      await assert.rejects(f.runtime.run('harness-repair', input, { invocationId: 'bad' }), coded('INVALID_RUNTIME_INPUT'))
    }
    assert.equal(touched, 0); assert.equal(f.requests.length, 0)
  })
  const { loadWorkflowRegistry } = await api()
  let touched = 0
  assert.throws(() => loadWorkflowRegistry({ get installationRoot() { touched++; return REPO }, workflowHashes: hashes() }), coded('INVALID_RUNTIME_INPUT'))
  assert.equal(touched, 0)
})

await test('native executor rejects malformed receipts, envelopes and oversized usage as uncertainty', async () => {
  for (const mutate of [r => ({ ...r, extra: true }), r => ({ ...r, receipt: { ...r.receipt, model: 'wrong' } }),
    r => ({ ...r, usage: [] }), r => ({ ...r, usage: { bytes: 'x'.repeat(1048576) } }),
    r => ({ ...r, wire: { json: '{}', extra: true } })]) {
    await using({ respond: req => mutate(envelope(req)) }, async f => {
      await assert.rejects(f.runtime.run('harness-repair', args, { invocationId: 'malformed' }), coded('DISPATCH_UNCERTAIN'))
      assert.equal(f.requests.length, 1)
      assert.ok([...f.rows.values()].every(r => r.uncertain && !r.completion))
    })
  }
})

await test('native executor pending settlement abort is bounded and late completion never advances graph', async () => {
  const started = deferred(), pending = deferred(), controller = new AbortController()
  let opSignal
  await using({ signal: controller.signal, checkpoints: { settle(_id, _value, { signal }) {
    opSignal = signal; started.resolve(); return pending.promise
  } } }, async f => {
    const running = f.runtime.run('harness-repair', args, { invocationId: 'settle' })
    await started.promise; controller.abort()
    await assert.rejects(running, coded('CHECKPOINT_UNCERTAIN'))
    assert.equal(opSignal.aborted, true)
    pending.resolve(); await new Promise(r => setImmediate(r))
    assert.equal(f.requests.length, 1)
  })
})

await test('native executor enforces busy and close while provider is pending', async () => {
  const started = deferred()
  await using({ respond: req => new Promise((resolve, reject) => {
    req.signal.addEventListener('abort', () => reject(Error('private')), { once: true }); started.resolve()
  }) }, async f => {
    const running = f.runtime.run('harness-repair', args, { invocationId: 'active' })
    const rejected = assert.rejects(running, coded('RUNTIME_ABORTED'))
    await started.promise
    await assert.rejects(f.runtime.run('harness-repair', args, { invocationId: 'second' }), coded('BUSY'))
    await f.runtime.close(); await rejected; await f.runtime.close()
    await assert.rejects(f.runtime.run('harness-repair', args, { invocationId: 'closed' }), coded('CLOSED'))
  })
})

await test('native executor reports unjoined fake provider after bounded cleanup grace', async () => {
  const controller = new AbortController(), pending = deferred()
  await using({ signal: controller.signal, respond: () => { queueMicrotask(() => controller.abort()); return pending.promise } }, async f => {
    await assert.rejects(f.runtime.run('harness-repair', args, { invocationId: 'unjoined' }), coded('CLEANUP_UNCONFIRMED'))
    pending.resolve(null)
  })
})

await test('native executor rejects malformed checkpoint replies and selection before dispatch', async () => {
  for (const response of [{ state: 'dispatch', extra: true }, { state: 'completed' }, null]) {
    await using({ checkpoints: { reserve: async () => response } }, async f => {
      await assert.rejects(f.runtime.run('harness-repair', args, { invocationId: 'reserve' }), coded('CHECKPOINT_ERROR'))
      assert.equal(f.requests.length, 0)
    })
  }
  await using({ resolveLeaf: () => ({ selection: { provider: 'codex', model: '', effort: 'high' }, profile: 'source-review' }) }, async f => {
    await assert.rejects(f.runtime.run('harness-repair', args, { invocationId: 'selection' }), coded('INVALID_SELECTION'))
    assert.equal(f.rows.size, 0)
  })
})

await test('native registry captures immutable templates and refuses static escapes and missing files', async () => {
  const { loadWorkflowRegistry } = await api(), root = mkdtempSync(join(tmpdir(), 'nr02-registry-'))
  const copyTemplates = () => ids.forEach((id, i) => {
    const path = `graphs/${dirs[i]}/workflows/${id}.js`
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), readFileSync(join(REPO, path)))
  })
  try {
    copyTemplates()
    const registry = loadWorkflowRegistry({ installationRoot: root, workflowHashes: hashes() })
    rmSync(join(root, 'graphs'), { recursive: true })
    await using({ registry }, async f => {
      assert.equal((await f.runtime.run('harness-repair', args, { invocationId: 'captured' })).status, 'done')
    })
    assert.throws(() => loadWorkflowRegistry({ installationRoot: root, workflowHashes: hashes() }), coded('IO_ERROR'))
    copyTemplates()
    const path = 'graphs/blueprint/workflows/blueprint-design.js'
    rmSync(join(root, path)); symlinkSync(join(REPO, path), join(root, path))
    assert.throws(() => loadWorkflowRegistry({ installationRoot: root, workflowHashes: hashes() }), coded('REGISTRY_MISMATCH'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

await test('native executor canonical args binding ignores key order and provider mutation cannot change replay', async () => {
  await using({ respond: req => {
    const completion = envelope(req)
    req.schema.required.length = 0
    req.workflowPath.push('changed')
    return completion
  } }, async f => {
    const first = await f.runtime.run('harness-repair', { ...args, a: { z: 1, b: 2 } }, { invocationId: 'keys' })
    const count = f.requests.length
    const replay = await f.runtime.run('harness-repair', { a: { b: 2, z: 1 }, ...args }, { invocationId: 'keys' })
    assert.deepEqual(first, replay); assert.equal(f.requests.length, count)
    assert.ok([...f.rows.values()].every(row => row.binding.workflowPath.length === 1))
  })
})

await test('native executor real deadline bounds pending reserve with sanitized uncertainty diagnostics', async () => {
  const events = [], pending = deferred()
  let opSignal
  await using({ deadlineMs: Date.now() + 40, onEvent: event => events.push(event),
    checkpoints: { reserve(_binding, options) { opSignal = options.signal; return pending.promise } } }, async f => {
    await assert.rejects(f.runtime.run('harness-repair', args, { invocationId: 'bounded-store' }), coded('CHECKPOINT_UNCERTAIN'))
    assert.equal(opSignal.aborted, true); assert.equal(f.requests.length, 0)
    assert.equal(events.length, 1)
    assert.deepEqual(Object.keys(events[0]).sort(), ['callId', 'operation', 'operationPending'])
    assert.equal(events[0].operation, 'reserve'); assert.equal(events[0].operationPending, true)
    pending.resolve({ state: 'dispatch' }); await new Promise(r => setImmediate(r))
    assert.equal(f.requests.length, 0)
    await assert.rejects(f.runtime.run('harness-repair', args, { invocationId: 'no-auto-reopen' }), coded('CHECKPOINT_UNCERTAIN'))
  })
})

await test('native executor real deadline cancels cooperative active fake provider', async () => {
  let stopped = 0
  await using({ deadlineMs: Date.now() + 40, respond: req => new Promise((_, reject) => {
    req.signal.addEventListener('abort', () => { stopped++; reject(Error('private')) }, { once: true })
  }) }, async f => {
    await assert.rejects(f.runtime.run('harness-repair', args, { invocationId: 'bounded-provider' }), coded('RUNTIME_ABORTED'))
    assert.equal(stopped, 1); assert.equal(f.requests.length, 1)
  })
})

await test('native executor close bounds an already pending uncertainty checkpoint', async () => {
  const started = deferred(), pending = deferred()
  let opSignal
  await using({ respond() { throw Error('private') }, checkpoints: {
    uncertain(_id, _value, { signal }) { opSignal = signal; started.resolve(); return pending.promise },
  } }, async f => {
    const running = f.runtime.run('harness-repair', args, { invocationId: 'close-uncertain' })
    const rejected = assert.rejects(running, coded('DISPATCH_UNCERTAIN'))
    await started.promise
    await f.runtime.close(); await rejected
    assert.equal(opSignal.aborted, true); assert.equal(f.requests.length, 1)
    pending.resolve()
  })
})

await test('native executor preserves exact failed envelope on replay and never serializes unsafe provider hooks', async () => {
  await using({ respond: req => ({ outcome: 'failed', code: 'REMOTE_FAILED', usage: { total: 0 },
    receipt: { ...req.selection, invocationId: 'failed-fixture' } }) }, async f => {
    const first = await f.runtime.run('harness-repair', args, { invocationId: 'failed-replay' })
    assert.equal(first.status, 'escalate')
    const before = structuredClone([...f.rows.values()])
    assert.deepEqual(await f.runtime.run('harness-repair', args, { invocationId: 'failed-replay' }), first)
    assert.deepEqual([...f.rows.values()], before); assert.equal(f.requests.length, 1)
    assert.deepEqual(before[0].completion.usage, { total: 0 })
    assert.equal(before[0].completion.code, 'REMOTE_FAILED')
  })
  let invoked = 0
  await using({ respond: req => ({ ...envelope(req), get usage() { invoked++; return null } }) }, async f => {
    await assert.rejects(f.runtime.run('harness-repair', args, { invocationId: 'getter' }), coded('DISPATCH_UNCERTAIN'))
    assert.equal(invoked, 0)
  })
})

await test('native executor hostile checkpoint error descriptors cannot escape the fatal latch', async () => {
  let invoked = 0
  for (const thrown of [Object.defineProperty(new Error('private'), 'code', { get() { invoked++; throw Error('private') } }),
    new Proxy({}, { get() { invoked++; throw Error('private') } })]) {
    await using({ checkpoints: { reserve: async () => { throw thrown } } }, async f => {
      await assert.rejects(f.runtime.run('harness-repair', args, { invocationId: 'error-code' }), coded('CHECKPOINT_ERROR'))
      assert.equal(f.requests.length, 0)
    })
  }
  assert.equal(invoked, 0)
})

await test('native executor accepts and replays an exact one MiB completion envelope', async () => {
  await using({ respond: req => {
    const c = { ...envelope(req), usage: { padding: '' } }
    c.usage.padding = 'x'.repeat(1048576 - Buffer.byteLength(JSON.stringify(c)))
    assert.equal(Buffer.byteLength(JSON.stringify(c)), 1048576)
    return c
  } }, async f => {
    const first = await f.runtime.run('harness-repair', args, { invocationId: 'full-envelope' })
    assert.equal(first.status, 'done')
    assert.deepEqual(await f.runtime.run('harness-repair', args, { invocationId: 'full-envelope' }), first)
    assert.equal(f.requests.length, 3)
  })
})

await test('native executor close prevents starting a later uncertainty checkpoint', async () => {
  const started = deferred()
  let uncertain = 0
  await using({ respond: req => new Promise((_, reject) => {
    req.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }); started.resolve()
  }), checkpoints: { uncertain: async () => { uncertain++ } } }, async f => {
    const rejected = assert.rejects(f.runtime.run('harness-repair', args, { invocationId: 'close-before-cleanup' }), coded('RUNTIME_ABORTED'))
    await started.promise; await f.runtime.close(); await rejected
    assert.equal(uncertain, 0)
  })
})
