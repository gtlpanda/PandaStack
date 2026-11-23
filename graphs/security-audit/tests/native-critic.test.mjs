// The native critic stage: full-evidence partitions plus one global reconciliation, each a leaf of the trusted workflow under its own
// invocation id, then the unchanged critic applier once. Offline: an in-process provider answers the leaves; nothing here is a model.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test, REPO, NO_LINUX_STORES } from '../../../scripts/workflow-harness.mjs'
import { advanceState } from '../skills/security-audit/audit-run.mjs'
import { mergeWave, planWave } from '../skills/security-audit/audit-ledger.mjs'
import { openAuditJournal, readAuditJournal } from '../skills/security-audit/dispatch-journal.mjs'
import { runNativeAuditStage } from '../skills/security-audit/native-stage.mjs'
import { createAuditCriticStageCheckpoints } from '../skills/security-audit/native-checkpoints.mjs'
import { loadRun, nextStep } from '../skills/security-audit/audit-run.mjs'
import { loadWorkflowRegistry } from '../../../core/skills/native-runtime/registry.mjs'
import { checkOf, coverAll, hunterResult, hunterUnit, refsOf, seeded, unitInput, assignments } from './ledger-fixtures.mjs'
import { stageDirs } from './stage-fixtures.mjs'

const ids = ['blueprint-design', 'bughunt-flow', 'dev-build', 'harness-repair', 'release-flow', 'security-audit-flow']
const dirs = ['blueprint', 'hunt', 'dev', 'qa', 'release', 'security-audit']
const sha = s => createHash('sha256').update(s).digest('hex')
const registry = () => loadWorkflowRegistry({ installationRoot: REPO, workflowHashes: Object.fromEntries(ids.map((id, i) => [id, sha(readFileSync(join(REPO, 'graphs', dirs[i], 'workflows', id + '.js')))])) })
const CRITIC = (over = {}) => ({ missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: true, ...over })
const GAP = { surface: 'gap', boundary: 'b', subsystem: 's', attack_class: 'Access control', starting_paths: ['src/app.js'], selected_companion_blocks: [], excluded_blocks: [], reason: 'found by the first partition' }
const BIG = 'full evidence of a long check. '.repeat(125).trim()   // 3,875 characters, upstream's per-text maximum is 4,096; the clipped critic keeps no check result at all

// A run at the post-wave critic step: `n` units, one hunter each, every unit covered with twelve checks of BIG evidence (about 47 KB a unit).
function atCritic(n) {
  const run = seeded(Array.from({ length: n }, (_, i) => unitInput(`u${i}`, { canonical_refs: refsOf(`u${i}`, { subsystem: `s${i}` }) })))
  planWave(run.runDir)
  advanceState(run.runDir, 'hunt')
  const assigned = assignments(run.runDir)
  const results = Object.fromEntries(Object.entries(assigned).map(([agent, unitIds]) => [agent,
    hunterResult(unitIds.map(id => hunterUnit(id, agent, { checks: Array.from({ length: 12 }, () => checkOf(agent, ['src/app.js'], { result: BIG })) })))]))
  mergeWave(run.runDir, results)
  assert.equal(nextStep(loadRun(run.runDir)).step, 'critic')
  return run
}

async function fixture(run, grant, work) {
  const journal = openAuditJournal({ runDir: run.runDir, invocationLimit: 16 }), calls = []
  journal.initControl({ initialGrant: grant })
  const state = { answer: () => CRITIC() }
  const options = { runDir: run.runDir, journal, registry: registry(), maxConcurrentSubagents: 1, deadlineMs: Date.now() + 60000,
    resolveLeaf: () => ({ selection: { provider: 'codex', model: 'fixture', effort: 'high' }, profile: 'audit-source-only' }),
    provider: { async runLeaf(req) {
      calls.push({ callId: req.callId, label: req.label, prompt: req.prompt })
      return { outcome: 'returned', wire: { json: JSON.stringify(state.answer(req, calls.length)) }, usage: null, receipt: { ...req.selection, invocationId: req.callId } }
    } } }
  try { await work({ ...run, journal, calls, options, state }) } finally { journal.close() }
}
const stageOf = runDir => join(runDir, 'stages', stageDirs(runDir).at(-1))

await test('a critic over evidence larger than one script runs as several partitions and a reconciliation, unclipped, and applies once', { skip: NO_LINUX_STORES }, async () => {
  const run = atCritic(12)
  await fixture(run, 16, async ({ runDir, calls, options, state }) => {
    state.answer = (req, n) => CRITIC({ missing_units: n === 1 ? [GAP] : [], stop: false })
    const done = await runNativeAuditStage(options)
    const manifest = JSON.parse(readFileSync(join(stageOf(runDir), 'critic-manifest.json')))
    assert.ok(manifest.partitions.length >= 2, `partitions: ${manifest.partitions.length}`)
    assert.equal(calls.length, manifest.partitions.length + 1)
    assert.equal(new Set(calls.map(c => c.callId)).size, calls.length, 'no two leaves share a call id')
    // Every partition prompt carries its units' evidence in full: the clipped critic would have cut it to 300 characters.
    for (const call of calls.slice(0, -1)) { assert.ok(call.prompt.includes(BIG), 'full evidence is in the partition prompt'); assert.ok(!call.prompt.includes('"truncated":true')) }
    assert.ok(calls.at(-1).prompt.includes('global semantic reconciliation'))
    // Applied once, through the unchanged applier: the union of the partitions' proposals, and the critic step saved.
    const critic = JSON.parse(readFileSync(join(runDir, 'critic.json')))
    assert.equal(critic.missing_units.length, 1)
    assert.equal(critic.stop, false)
    assert.equal(loadRun(runDir).state.last, 'critic')
    assert.equal(done.result.results.part, 'critic')
    assert.equal(loadRun(runDir).meta.agents_spent, calls.length)
    assert.equal(readAuditJournal(runDir).settledCalls, calls.length)
    assert.equal(done.result.budgetSpent, calls.length)
  })
})

await test('a small ledger is one partition plus the reconciliation, and the critic result is the planner\'s accepted union', { skip: NO_LINUX_STORES }, async () => {
  const run = atCritic(2)
  await fixture(run, 16, async ({ runDir, calls, options, state }) => {
    await runNativeAuditStage(options)
    assert.equal(calls.length, 2)
    // The partition said stop: true and so did the reconciliation: the union keeps stop.
    assert.equal(JSON.parse(readFileSync(join(runDir, 'critic.json'))).stop, true)
    assert.equal(nextStep(loadRun(runDir)).step, 'mint')
  })
})

await test('a budget pause after one partition resumes the captured stage: completed leaves replay with no new call and no new id', { skip: NO_LINUX_STORES }, async () => {
  const run = atCritic(12)
  await fixture(run, 1, async ({ runDir, journal, calls, options }) => {
    await assert.rejects(runNativeAuditStage(options), e => e.code === 'CONTROL_PAUSED')
    assert.equal(calls.length, 1)
    const first = calls[0].callId, dir = stageDirs(runDir)
    journal.adjustGrant({ expectedRevision: journal.getControl().revision, currentGrant: 16, reason: 'operator_increase' })
    journal.resumeBudget({ expectedRevision: journal.getControl().revision })
    await runNativeAuditStage(options)
    assert.deepEqual(stageDirs(runDir), dir, 'the same stage directory is resumed')
    assert.equal(calls.filter(c => c.callId === first).length, 1, 'the first partition is not called again')
    const manifest = JSON.parse(readFileSync(join(stageOf(runDir), 'critic-manifest.json')))
    assert.equal(calls.length, manifest.partitions.length + 1)
    assert.equal(readAuditJournal(runDir).rows.length, calls.length)
    assert.equal(loadRun(runDir).state.last, 'critic')
  })
})

await test('a changed manifest is refused before any leaf is reserved', { skip: NO_LINUX_STORES }, async () => {
  const run = atCritic(12)
  await fixture(run, 1, async ({ runDir, calls, options }) => {
    await assert.rejects(runNativeAuditStage(options), e => e.code === 'CONTROL_PAUSED')
    const file = join(stageOf(runDir), 'critic-manifest.json')
    const changed = JSON.parse(readFileSync(file, 'utf8')); changed.identity.wave = 2
    writeFileSync(file, JSON.stringify(changed, null, 2))
    const rows = readAuditJournal(runDir).rows.length
    await assert.rejects(runNativeAuditStage(options), e => e.code === 'CAPTURE_INVALID')
    assert.equal(calls.length, 1)
    assert.equal(readAuditJournal(runDir).rows.length, rows)
  })
})

await test('a partition that answers with an ID outside the ledger is a completed rejection: no application, and a new stage starts on the next run', { skip: NO_LINUX_STORES }, async () => {
  const run = atCritic(2)
  await fixture(run, 16, async ({ runDir, calls, options, state }) => {
    state.answer = (req, n) => CRITIC({ reassign_ids: n === 1 ? ['NOT-A-UNIT'] : [] })
    await assert.rejects(runNativeAuditStage(options), e => e.constructor.name === 'Refusal' && /escalated/.test(e.message))
    assert.equal(loadRun(runDir).state.last, 'merge-wave')
    assert.equal(calls.length, 1, 'the reconciliation never ran on an invalid partition')
    state.answer = () => CRITIC()
    await runNativeAuditStage(options)
    assert.equal(stageDirs(runDir).length, 2, 'a fresh stage, with fresh invocation ids')
    assert.equal(loadRun(runDir).state.last, 'critic')
    assert.equal(new Set(calls.map(c => c.callId)).size, calls.length)
  })
})

await test('critic stage checkpoints own only the ids they were given: bad owner lists are refused, and a foreign invocation never reserves', { skip: NO_LINUX_STORES }, async () => {
  const run = atCritic(2)
  await fixture(run, 16, async ({ runDir, journal, options }) => {
    await assert.rejects(runNativeAuditStage({ ...options, provider: { async runLeaf() { throw new Error('stop') } } }))
    const stageName = stageDirs(runDir).at(-1)
    const marker = JSON.parse(readFileSync(join(runDir, 'stages', stageName, 'native-capture.json')))
    const base = { runDir, journal, stageName, invocationId: marker.invocation_id }
    for (const owned of [[], 'x', [marker.invocation_id, marker.invocation_id], ['nothex'], [marker.invocation_id.toUpperCase()]]) {
      assert.throws(() => createAuditCriticStageCheckpoints({ ...base, ownedInvocationIds: owned }), e => e.code === 'INVALID_JOURNAL_INPUT')
    }
    const other = sha('foreign'), before = readAuditJournal(runDir).rows.length
    const checkpoints = createAuditCriticStageCheckpoints({ ...base, ownedInvocationIds: [sha('mine')] })
    await assert.rejects(checkpoints.reserve({ callId: 'nr-' + sha('x'), invocationId: other }), e => e.code === 'INVOCATION_MISMATCH')
    assert.equal(readAuditJournal(runDir).rows.length, before)
    await checkpoints.close()
    assert.throws(() => createAuditCriticStageCheckpoints({ ...base, invocationId: sha('wrong'), ownedInvocationIds: [sha('mine')] }), e => e.code === 'CAPTURE_INVALID')
  })
})

await test('the script measure equals the bytes run-script.mjs really writes, including an input that holds replacement patterns', async () => {
  const { measureWorkflowScript } = await import('../skills/security-audit/critic-stage.mjs')
  const { mkdtempSync, statSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const source = join(REPO, 'graphs', 'security-audit', 'workflows', 'security-audit-flow.js')
  const input = { stage: 'critic', text: "a $& b $1 $' $` é   \"quoted\" \\ back" }
  const dir = mkdtempSync(join(tmpdir(), 'measure-')), state = join(dir, 'input.json'), out = join(dir, 'run.js')
  writeFileSync(state, JSON.stringify(input))
  const r = spawnSync(process.execPath, [join(REPO, 'core', 'skills', 'workflow-state', 'run-script.mjs'), 'INJECTED_INPUT', state, source, out], { encoding: 'utf8' })
  assert.match(r.stdout, /^run-script: wrote/)
  assert.equal(measureWorkflowScript(readFileSync(source, 'utf8'))(input), statSync(out).size)
  assert.throws(() => measureWorkflowScript('no seam here'), /exactly once/)
})
