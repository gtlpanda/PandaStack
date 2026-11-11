// SA-LT01: inert library inputs and trusted fake workflow only. No run init,
// target execution, provider calls, or publication/retry authority.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, load, run } from '../../../scripts/workflow-harness.mjs'
import { inspectUnitInputs, unitFromInput, criticTransitionContext, inspectCriticTransitions } from '../skills/security-audit/audit-ledger.mjs'
import { unitInput, refsOf } from './ledger-fixtures.mjs'
import { planCriticBatch, planCriticReconciliation, acceptCriticReconciliation } from '../skills/security-audit/critic-partitions.mjs'

const ctx = { runDir: '/inert', scope: [], priorStatus: 'none', profile: 'standard', skipPathCheck: true }
const inspect = (inputs, context = ctx, options = { kind: 'seed' }) => inspectUnitInputs(inputs, context, options)
const invalid = e => e.code === 'INVALID_INPUT'
const critic = ids => ({ missing_units: [], reassign_ids: ids, resolved_prior_leads: [], stop: false })

await test('feedback rejects invalid profile envelopes even with no rows instead of defaulting to standard', () => {
  for (const profile of [null, '', ' ', 'QUICK', 'unknown', ['quick'], {}, 0, false]) {
    assert.throws(() => inspect([], { ...ctx, profile }), invalid, JSON.stringify(profile))
    assert.throws(() => inspect([unitInput('good')], { ...ctx, profile }), invalid, JSON.stringify(profile))
  }
  const { profile, ...legacy } = ctx
  assert.equal(inspect([unitInput('good')], legacy).accepted.length, 1)
  assert.equal(inspect([unitInput('good')], { ...ctx, profile: 'quick' }).rejected.length, 1)
})

await test('feedback retains exact original JSON and lifecycle identity with detached nested values', () => {
  const good = unitInput('pair', { lifecycle: 'Startup', canonical_refs: refsOf('pair', { lifecycle: 'startup' }) })
  const absent = unitInput('absent'), inputs = [good, absent]
  const bytes = JSON.stringify(inputs), result = inspect(inputs, { ...ctx, profile: 'deep' })
  assert.deepEqual(result.rejected, [])
  assert.equal(JSON.stringify(result.accepted.map(r => r.input)), bytes)
  assert.equal(result.accepted[0].coverageId, unitFromInput(good, ctx).unit.coverage_id)
  assert.equal(Object.hasOwn(result.accepted[1].input, 'lifecycle'), false)
  result.accepted[0].input.canonical_refs.lifecycle = 'changed'
  result.accepted[1].input.starting_paths.push('changed')
  assert.equal(JSON.stringify(inputs), bytes)
})

await test('feedback rejects null empty one-sided lifecycle and every otherwise-valid duplicate slot', () => {
  const same = unitInput('same'), bad = [null, '', ' '].map(lifecycle =>
    unitInput('bad', { lifecycle, canonical_refs: refsOf('bad', { lifecycle }) }))
  const inputs = [same, ...bad, unitInput('one', { lifecycle: 'startup' }),
    structuredClone(same), unitInput('independent'), unitInput('same', { status: 'covered' })]
  const result = inspect(inputs)
  assert.deepEqual(result.accepted.map(r => r.index), [6])
  assert.deepEqual(result.rejected.map(r => r.index), [0, 1, 2, 3, 4, 5, 7])
  const oneValid = inspect([same, unitInput('same', { status: 'covered' })])
  assert.deepEqual(oneValid.accepted.map(r => r.index), [0])
})

await test('feedback uses actual path and block checks without publishing any files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-lt01-inputs-'))
  try {
    mkdirSync(join(dir, 'tree', 'src'), { recursive: true })
    writeFileSync(join(dir, 'tree', 'src', 'app.js'), 'inert source text\n')
    writeFileSync(join(dir, 'sentinel.json'), '{"unchanged":true}\n')
    const before = readdirSync(dir), sentinel = readFileSync(join(dir, 'sentinel.json'), 'utf8')
    const { skipPathCheck, ...context } = ctx
    const result = inspect([unitInput('yes'), unitInput('missing', { starting_paths: ['src/absent.js'] }),
      unitInput('block', { ordinary_attack_class_block: 'ATTACK-CLASSES.md#Absent' }),
      unitInput('deferred', { status: 'deferred', reason: 'held' })], { ...context, runDir: dir }, { kind: 'mint' })
    assert.deepEqual(result.accepted.map(r => r.index), [0])
    assert.deepEqual(result.rejected.map(r => r.index), [1, 2, 3])
    assert.deepEqual(readdirSync(dir), before)
    assert.equal(readFileSync(join(dir, 'sentinel.json'), 'utf8'), sentinel)
    assert.equal(readFileSync(join(dir, 'tree', 'src', 'app.js'), 'utf8'), 'inert source text\n')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test('feedback rejects non-JSON boundaries without running hooks', () => {
  let hooks = 0
  const proxy = new Proxy({}, { ownKeys() { hooks++; return [] }, get() { hooks++; return 'seed' } })
  const getter = { get status() { hooks++; return 'planned' } }
  const cycle = {}; cycle.self = cycle
  for (const unsafe of [proxy, getter, cycle, new Date(), Object.create({ inherited: true }),
    { toJSON() { hooks++; return {} } }, { value: undefined }, { value: Infinity }]) {
    assert.throws(() => inspect([unsafe]), invalid)
    assert.throws(() => inspect([], unsafe), invalid)
  }
  assert.throws(() => inspect([], ctx, proxy), invalid)
  assert.throws(() => inspect([], ctx, { get kind() { hooks++; return 'seed' } }), invalid)
  assert.equal(hooks, 0)
})

await test('feedback bounds JSON bytes depth row counts requested IDs and per-row diagnostics', () => {
  assert.throws(() => inspect(Array(1001).fill(null)), invalid)
  assert.throws(() => inspect([{ text: 'x'.repeat(1048576) }]), invalid)
  let deep = {}; for (let i = 0; i < 64; i++) deep = { deep }
  assert.throws(() => inspect([deep]), invalid)
  assert.throws(() => criticTransitionContext(Array.from({ length: 1001 }, (_, i) => ({ coverage_id: String(i), status: 'covered' }))), invalid)
  assert.throws(() => inspectCriticTransitions([], critic(Array(1001).fill('unknown'))), invalid)
  const result = inspect([null, false, 0, [], unitInput('bad', {
    excluded_blocks: Array.from({ length: 60 }, () => ({ block: 'invalid\n' + 'x'.repeat(500), reason: 'ordinary' })),
  }), unitInput('good')])
  assert.deepEqual(result.accepted.map(r => r.index), [5])
  assert.deepEqual(result.rejected.map(r => r.index), [0, 1, 2, 3, 4])
  for (const row of result.rejected) {
    assert.ok(row.problems.length > 0 && row.problems.length <= 40)
    assert.ok(row.problems.every(p => p.length <= 400 && !/[\x00-\x1f\x7f]/.test(p)))
  }
})

await test('feedback refuses malformed options and context before returning partial results', () => {
  for (const options of [null, [], {}, { kind: 'other' }, { kind: 'seed', skipPathCheck: true }]) {
    assert.throws(() => inspect([unitInput('good')], ctx, options), invalid)
  }
  for (const over of [{ runDir: '' }, { scope: [null] }, { priorStatus: '' }, { skipPathCheck: 'true' }, { extra: true }]) {
    assert.throws(() => inspect([unitInput('good')], { ...ctx, ...over }), invalid)
  }
})

const { src, fn } = load(new URL('../workflows/security-audit-flow.js', import.meta.url))
const measureScript = input => Buffer.byteLength(src.replace('const INJECTED_INPUT = null',
  'const INJECTED_INPUT = JSON.parse(' + JSON.stringify(JSON.stringify(input)) + ')'))
const opts = { measureScript }
const batch = () => ({ identity: { runId: 'feedback', sourceRef: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  kind: 'post-wave', wave: 1, profile: 'standard' },
shared: { tree: '/inert/tree', architecture_md: 'architecture', parts: { criticSection: 'method' },
  execution: { capability: 'none', blockers: ['source only'] } },
items: ['covered', 'deferred'].map((status, i) => ({ itemId: `u${i}`, kind: 'unit', owners: [`u${i}`],
  value: { coverage_id: `id${i}`, status, evidence: 'full evidence '.repeat(19000) } })),
})

await test('partition and global contexts cover exactly their unit sets and are measured before binding', () => {
  const input = batch(), m = planCriticBatch(input, opts)
  assert.equal(m.partitions.length, 2)
  for (const p of m.partitions) {
    assert.deepEqual(p.input.transitionContext, criticTransitionContext(p.input.ledger))
    assert.equal(p.scriptBytes, measureScript(p.input))
    assert.ok(p.scriptBytes <= 500000)
  }
  const results = m.partitions.map(p => ({ batchId: m.batchId, partId: p.partId, inputDigest: p.inputDigest,
    critic: critic([]), summary: { text: 'summary', itemIds: p.itemIds } }))
  const { plan } = planCriticReconciliation({ manifest: m, results }, opts)
  assert.deepEqual(plan.input.transitionContext, criticTransitionContext(input.items.map(i => i.value)))
  assert.equal(plan.scriptBytes, measureScript(plan.input))
  const result = { batchId: m.batchId, inputDigest: plan.inputDigest, critic: critic([]) }
  for (const context of [criticTransitionContext([]), criticTransitionContext([{ coverage_id: 'extra', status: 'covered' }]),
    criticTransitionContext(input.items.map(i => ({ ...i.value, status: i.value.status === 'covered' ? 'deferred' : 'covered' })))]) {
    const forged = structuredClone(plan); forged.input.transitionContext = context
    assert.throws(() => acceptCriticReconciliation({ manifest: m, results, plan: forged, result }), e => e.code === 'INVALID_PARTITION_RESULT')
  }
  assert.throws(() => planCriticBatch({ ...input, transitionContext: plan.input.transitionContext }, opts), e => e.code === 'INVALID_PARTITION_INPUT')
})

await test('malformed transition grammar dispatches nobody while absent context keeps legacy behavior', async () => {
  const input = planCriticBatch(batch(), opts).partitions[0].input
  const good = input.transitionContext
  for (const context of [null, {}, { ...good, maxSemanticAttempts: 1 }, { ...good, extra: true },
    { ...good, reassignableIds: ['id0', 'id0'] },
    { ...good, nonReassignable: [{ coverageId: 'id0', status: 'deferred', code: 'DEFERRED_NOT_REOPENABLE' }] }]) {
    const out = await run(fn, {}, { ...input, transitionContext: context })
    assert.equal(out.result.status, 'escalate'); assert.equal(out.calls.length, 0)
  }
  const { transitionContext, critic_context, ...legacy } = input
  const out = await run(fn, { 'audit-researcher': [critic([])] }, legacy)
  assert.equal(out.result.status, 'done')
  assert.equal(out.calls.length, 1)
  assert.ok(!out.calls[0].prompt.includes('untrusted-transition-context'))
})
