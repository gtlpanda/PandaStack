import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test, REPO } from '../../../scripts/workflow-harness.mjs'
import { META, STATE } from './report-fixtures.mjs'
import { openAuditJournal, readAuditJournal } from '../skills/security-audit/dispatch-journal.mjs'
import { createAuditCheckpoints } from '../skills/security-audit/native-checkpoints.mjs'
import { publishPartialReport, readPartialReport } from '../skills/security-audit/audit-report.mjs'
import { recordSpend } from '../skills/security-audit/audit-run.mjs'
import { loadWorkflowRegistry } from '../../../core/skills/native-runtime/registry.mjs'
import { createNativeRuntime } from '../../../core/skills/native-runtime/runtime.mjs'

// Actual owners over ordinary inert metadata; no Git export, child process,
// target code, provider or substituted journal/publication authority.
const paths = { 'blueprint-design': 'blueprint', 'bughunt-flow': 'hunt', 'dev-build': 'dev',
  'harness-repair': 'qa', 'release-flow': 'release', 'security-audit-flow': 'security-audit' }
const registry = loadWorkflowRegistry({ installationRoot: REPO, workflowHashes: Object.fromEntries(
  Object.entries(paths).map(([id, dir]) => [id, createHash('sha256')
    .update(readFileSync(`${REPO}/graphs/${dir}/workflows/${id}.js`)).digest('hex')])) })
const code = expected => e => e?.code === expected
const envelope = (req, value) => ({ outcome: 'returned', wire: { json: JSON.stringify(value) },
  usage: null, receipt: { ...req.selection, invocationId: 'inert-call' } })
const qaAnswer = req => req.agentType === 'checker'
  ? { verdict: 'PASS', verify_block: 'VERIFY: PASS', failures: [] } : { files_reviewed: 1, findings: [] }
const research = req => ({ agent: req.label.slice('recon-'.length), items: [{ text: 'inert fact', refs: ['src/app.js:1'] }], limits: [] })
const auditArgs = { stage: 'recon', part: 'facts', tree: '/inert', maxParallel: 4,
  execution: { capability: 'none', blockers: ['source only'] },
  parts: { recon1a: 'inert', recon1b: 'inert', recon1c: 'inert', recon1d: 'inert' } }
async function fixture(check, grant = 4) {
  const runDir = mkdtempSync(join(tmpdir(), 'checkpoint-owners-'))
  writeFileSync(join(runDir, 'run-metadata.json'), JSON.stringify(META({ run_status: 'in_progress' })))
  writeFileSync(join(runDir, 'stage-state.json'), JSON.stringify(STATE({ last: 'init', critic_kind: null })))
  const journal = openAuditJournal({ runDir, invocationLimit: 4 }), ports = [], runtimes = [], calls = []
  journal.initControl({ initialGrant: grant })
  const port = () => { const p = createAuditCheckpoints({ runDir, journal }); ports.push(p); return p }
  const fresh = () => {
    assert.ok(['published', 'replayed'].includes(publishPartialReport(runDir).status))
    journal.acknowledgeReport({ expectedRevision: journal.getControl().revision })
    assert.equal(readPartialReport(runDir).status, 'current')
  }
  const runtime = (answer = qaAnswer, signal) => {
    const r = createNativeRuntime({ registry, checkpoints: port(), signal,
      provider: { async runLeaf(req) { calls.push(req); return envelope(req, await answer(req)) } },
      resolveLeaf: ({ workflowId }) => ({ selection: { provider: 'codex', model: 'inert', effort: 'high' },
        profile: workflowId === 'security-audit-flow' ? 'audit-source-only' : 'source-review' }),
      maxConcurrentSubagents: 2, deadlineMs: Date.now() + 5000 })
    runtimes.push(r); return r
  }
  try { await check({ runDir, journal, port, ports, fresh, runtime, calls, rows: () => readAuditJournal(runDir) }) }
  finally {
    for (const r of runtimes) await r.close()
    for (const p of ports) await p.close()
    journal.close(); rmSync(runDir, { recursive: true, force: true })
  }
}
const qa = runtime => runtime.run('harness-repair', { repo: '/inert' }, { invocationId: 'actual-qa' })

await test('actual bridge pauses at exhausted grant and same invocation replays its durable checker', () => fixture(async x => {
  x.fresh()
  await assert.rejects(qa(x.runtime()), code('CONTROL_PAUSED'))
  const before = x.rows().rows[0]
  assert.equal(before.state, 'returned'); assert.equal(x.calls.length, 1)
  x.journal.adjustGrant({ expectedRevision: x.journal.getControl().revision, currentGrant: 4, reason: 'operator_increase' })
  x.fresh(); x.journal.resumeBudget({ expectedRevision: x.journal.getControl().revision })
  assert.equal((await qa(x.runtime())).status, 'done')
  assert.deepEqual(x.calls.map(r => r.agentType), ['checker', 'reviewer', 'qa-auditor'])
  assert.deepEqual(x.rows().rows[0], before)
  assert.equal(readPartialReport(x.runDir).status, 'current')
}, 1))

await test('actual freshness blocks absent and prepared admissions while preserving binding conflict authority', () => fixture(async x => {
  x.fresh(); const p = x.port(), binding = { callId: 'prepared', promptHash: 'original' }
  x.journal.prepare({ id: binding.callId, input: binding }); x.fresh()
  recordSpend(x.runDir, 'inert-observation', 1)
  assert.equal(readPartialReport(x.runDir).status, 'stale')
  assert.deepEqual(x.journal.getControl().blockers, [])
  await assert.rejects(p.reserve({ ...binding, promptHash: 'different' }), code('CONFLICT'))
  assert.deepEqual(await p.reserve({ callId: 'absent' }), { state: 'paused', blockers: ['report_stale'] })
  assert.deepEqual(await p.reserve(binding), { state: 'paused', blockers: ['report_stale'] })
  assert.deepEqual(x.rows().rows.map(r => [r.id, r.state]), [['prepared', 'prepared']])
}))

await test('actual bridge rejects a cancelled queued admission without creating another row', () => fixture(async x => {
  x.fresh(); const p = x.port(), controller = new AbortController()
  const first = p.reserve({ callId: 'first' })
  const second = p.reserve({ callId: 'cancelled' }, { signal: controller.signal })
  controller.abort()
  const refused = assert.rejects(second, code('RUNTIME_ABORTED'))
  try { assert.deepEqual(await first, { state: 'dispatch' }); await refused }
  finally { await p.uncertain('first', { code: 'RUNTIME_ABORTED' }) }
  assert.deepEqual(x.rows().rows.map(r => [r.id, r.state]), [['first', 'uncertain']])
}))

await test('actual bridge known failure retains exact receipt and a closed owner refuses later ports', () => fixture(async x => {
  x.fresh(); const p = x.port(), binding = { callId: 'known' }
  await p.reserve(binding)
  await assert.rejects(p.close(), code('BUSY'))
  const completion = { outcome: 'failed', code: 'REMOTE_FAILED', usage: { total: 0 },
    receipt: { provider: 'codex', model: 'inert', effort: 'high', invocationId: 'known-failure' } }
  await p.settle('known', completion)
  x.journal.pauseControl({ expectedRevision: x.journal.getControl().revision, reason: 'paused_budget' })
  assert.deepEqual(await p.reserve(binding), { state: 'completed', completion })
  const before = x.rows(); await p.uncertain('known', { code: 'RUNTIME_ABORTED' }); assert.deepEqual(x.rows(), before)
  x.journal.close()
  await assert.rejects(p.reserve(binding), code('CLOSED'))
  await assert.rejects(p.settle('known', completion), code('CLOSED'))
  await assert.rejects(p.uncertain('known', { code: 'RUNTIME_ABORTED' }), code('CLOSED'))
}))

// Both inert providers enter before any terminal mutation. The only filesystem
// conflict used below is the contract's reviewed, sequential owned pointer fixture.
async function concurrent(x, work) {
  const controller = new AbortController(), pending = []
  let ready; const entered = new Promise(resolve => { ready = resolve })
  const r = x.runtime(req => new Promise((resolve, reject) => {
    req.signal.addEventListener('abort', () => resolve(research(req)), { once: true })
    pending.push({ req, resolve: () => resolve(research(req)), reject })
    if (pending.length === 2) ready()
  }), controller.signal)
  const observed = r.run('security-audit-flow', auditArgs, { invocationId: 'actual-audit' })
    .then(value => ({ value }), error => ({ error }))
  try {
    await Promise.race([entered, observed.then(() => { throw Error('ended before two callbacks') })])
    assert.equal(readPartialReport(x.runDir).status, 'current')
    assert.equal(x.rows().rows.filter(r => r.state === 'dispatched').length, 2)
    await work({ pending, controller, observed })
  } finally { for (const p of pending) p.resolve(); controller.abort(); await observed }
}

await test('actual cooperative external cancellation joins owned callbacks and keeps exactly two charges', () => fixture(async x => {
  x.fresh()
  await concurrent(x, async ({ controller, observed }) => {
    controller.abort(); assert.equal((await observed).error?.code, 'RUNTIME_ABORTED')
    const before = x.rows()
    assert.equal(before.heldCalls, 2); assert.equal(before.settledCalls, 0)
    assert.ok(before.rows.every(r => r.state === 'uncertain')); assert.equal(x.calls.length, 2)
    // Cancellation joined storage; the host explicitly refreshes its report
    // before checking that repeated uncertainty joins are side-effect free.
    x.fresh()
    const control = x.journal.getControl()
    for (const r of before.rows) await x.ports[0].uncertain(r.id, { code: 'RUNTIME_ABORTED' })
    assert.deepEqual(x.rows(), before); assert.deepEqual(x.journal.getControl(), control)
    await x.ports[0].close(); x.journal.close()
  })
}))

await test('actual controlled pause cannot hide unknown transport from an already authorized sibling', () => fixture(async x => {
  x.fresh()
  await concurrent(x, async ({ pending, observed }) => {
    x.journal.pauseControl({ expectedRevision: x.journal.getControl().revision, reason: 'paused_budget' })
    pending[0].resolve(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(x.rows().settledCalls, 1)
    assert.equal(pending[1].req.signal.aborted, false)
    pending[1].reject(Error('inert unknown outcome'))
    assert.equal((await observed).error?.code, 'DISPATCH_UNCERTAIN')
    assert.equal(x.calls.length, 2)
    assert.deepEqual(x.rows().rows.map(r => r.state), ['returned', 'uncertain'])
  })
}))

await test('actual publication failure drains siblings and repaired same invocation replays both receipts', () => fixture(async x => {
  x.fresh()
  const pointer = join(x.runDir, 'partial-reports/current.json'), bytes = readFileSync(pointer)
  let conflict = false
  const repair = () => { if (conflict) { rmdirSync(pointer); writeFileSync(pointer, bytes, { mode: 0o600 }); conflict = false } }
  try {
    await concurrent(x, async ({ pending, observed }) => {
      unlinkSync(pointer); mkdirSync(pointer, { mode: 0o700 }); conflict = true
      pending[0].resolve(); await new Promise(resolve => setImmediate(resolve))
      assert.equal(x.rows().settledCalls, 1)
      assert.equal(pending[1].req.signal.aborted, false); assert.equal(x.calls.length, 2)
      pending[1].resolve(); assert.equal((await observed).error?.code, 'CONTROL_PAUSED')
    })
    const before = x.rows().rows
    assert.ok(before.every(r => r.state === 'returned'))
    assert.deepEqual(x.journal.getControl().blockers, ['report_stale'])
    repair(); x.fresh()
    const result = await x.runtime(research).run('security-audit-flow', auditArgs, { invocationId: 'actual-audit' })
    assert.equal(result.status, 'done'); assert.equal(x.calls.length, 4)
    assert.deepEqual(x.rows().rows.slice(0, 2), before)
  } finally { repair() }
}))
