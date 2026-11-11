import assert from 'node:assert/strict'
import fs, { readFileSync, chmodSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test, REPO } from '../../../scripts/workflow-harness.mjs'
import { newInit, RESEARCH, SYNTH, UNIT, stageDirs } from './stage-fixtures.mjs'
import { openAuditJournal, readAuditJournal } from '../skills/security-audit/dispatch-journal.mjs'
import { runNativeAuditStage } from '../skills/security-audit/native-stage.mjs'
import { readPartialReport } from '../skills/security-audit/audit-report.mjs'
import { loadWorkflowRegistry } from '../../../core/skills/native-runtime/registry.mjs'
import { atVerify } from './verdict-fixtures.mjs'
import { loadRun } from '../skills/security-audit/audit-run.mjs'
import { planNativeStage } from '../skills/security-audit/audit-stage.mjs'
const ids = ['blueprint-design', 'bughunt-flow', 'dev-build', 'harness-repair', 'release-flow', 'security-audit-flow']
const dirs = ['blueprint', 'hunt', 'dev', 'qa', 'release', 'security-audit']
const sha = s => createHash('sha256').update(s).digest('hex')
async function fixture(grant, work, existingRunDir) {
  const runDir = existingRunDir ?? newInit().runDir, journal = openAuditJournal({ runDir, invocationLimit: 8 }), calls = []
  journal.initControl({ initialGrant: grant })
  const registry = loadWorkflowRegistry({ installationRoot: REPO, workflowHashes: Object.fromEntries(ids.map((id, i) => [id, sha(readFileSync(join(REPO, 'graphs', dirs[i], 'workflows', id + '.js')))])) })
  const options = { runDir, journal, registry, maxConcurrentSubagents: 1, deadlineMs: Date.now() + 30000,
    resolveLeaf: () => ({ selection: { provider: 'codex', model: 'fixture', effort: 'high' }, profile: 'audit-source-only' }),
    provider: { async runLeaf(req) {
      calls.push(req.label)
      const result = req.agentType === 'audit-researcher' ? RESEARCH(req.label.slice(6)) : SYNTH()
      return { outcome: 'returned', wire: { json: JSON.stringify(result) }, usage: null, receipt: { ...req.selection, invocationId: req.callId } }
    } } }
  try { await work({ runDir, journal, calls, options }) } finally { journal.close() }
}
await test('native stage composition executes real recon facts and synthesis through unchanged appliers', () => fixture(8, async ({ runDir, calls, options }) => {
  const facts = await runNativeAuditStage(options)
  assert.equal(facts.result.results.part, 'facts'); assert.equal(calls.length, 4)
  assert.equal(readPartialReport(runDir).status, 'current')
  const synth = await runNativeAuditStage(options)
  assert.equal(synth.result.results.part, 'synthesize'); assert.equal(calls.length, 5)
  assert.notEqual(synth.invocationId, facts.invocationId)
  const meta = JSON.parse(readFileSync(join(runDir, 'run-metadata.json')))
  assert.equal(meta.agents_spent, 5)
  assert.equal(JSON.parse(readFileSync(join(runDir, 'recon.json'))).units.length, 1)
  assert.equal(readPartialReport(runDir).status, 'current')
}))
await test('paused native stage resumes the captured invocation and replays completed researchers without repeat spend', () => fixture(1, async ({ runDir, journal, calls, options }) => {
  await assert.rejects(runNativeAuditStage(options), e => e.code === 'CONTROL_PAUSED')
  assert.equal(calls.length, 1); assert.equal(readAuditJournal(runDir).settledCalls, 1)
  assert.equal(JSON.parse(readFileSync(join(runDir, 'run-metadata.json'))).agents_spent, 1)
  const firstLabel = calls[0]
  journal.adjustGrant({ expectedRevision: journal.getControl().revision, currentGrant: 4, reason: 'operator_increase' })
  journal.resumeBudget({ expectedRevision: journal.getControl().revision })
  await runNativeAuditStage(options)
  assert.equal(calls.length, 4); assert.equal(calls.filter(x => x === firstLabel).length, 1)
  assert.equal(readAuditJournal(runDir).settledCalls, 4)
  assert.equal(JSON.parse(readFileSync(join(runDir, 'run-metadata.json'))).agents_spent, 4)
  assert.equal(readPartialReport(runDir).status, 'current')
}))
await test('unprotected snapshot refuses before native planning or provider calls', () => fixture(8, async ({ runDir, calls, options }) => {
  const tree = join(runDir, 'tree'); chmodSync(tree, 0o755)
  try { await assert.rejects(runNativeAuditStage(options), e => e.code === 'SNAPSHOT_UNPROTECTED'); assert.equal(calls.length, 0); assert.equal(readAuditJournal(runDir).rows.length, 0) }
  finally { chmodSync(tree, 0o555) }
}))

// Ordinary, sequential mocked write failure only: no child/process/capture or
// filesystem replacement scenario. The owning applier has already saved result.
await test('native application resumes a saved result after a state-write failure without redispatch or repeat spend', () => fixture(8, async ({ runDir, calls, options }) => {
  await runNativeAuditStage(options)
  const originalRename = fs.renameSync
  let failed = false
  try {
    fs.renameSync = (from, to) => {
      if (!failed && to === join(runDir, 'stage-state.json')) {
        failed = true
        throw Object.assign(new Error('ordinary fixture write failure'), { code: 'EIO' })
      }
      return originalRename(from, to)
    }
    syncBuiltinESMExports()
    await assert.rejects(runNativeAuditStage(options), e => e.code === 'EIO')
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports() }
  assert.equal(failed, true)
  assert.equal(calls.length, 5)
  assert.equal(loadRun(runDir).state.last, 'init')
  assert.equal(stageDirs(runDir).length, 2)
  assert.throws(() => planNativeStage(runDir), /awaits application recovery/)
  const recovered = await runNativeAuditStage(options)
  assert.equal(recovered.recoveredApplication, true)
  assert.equal(loadRun(runDir).state.last, 'recon')
  assert.equal(calls.length, 5)
  assert.equal(readAuditJournal(runDir).settledCalls, 5)
  assert.equal(loadRun(runDir).meta.agents_spent, 5)
  assert.equal(stageDirs(runDir).length, 2)
  assert.equal(readPartialReport(runDir).status, 'current')
  await assert.rejects(runNativeAuditStage(options), /next step is seed|next.*seed|seed/)
  assert.equal(calls.length, 5)
}))

await test('semantic synthesis refusal starts its bounded next attempt instead of replaying the rejected application', () => fixture(8, async ({ runDir, calls, options }) => {
  await runNativeAuditStage(options)
  const validProvider = options.provider
  options.provider = { async runLeaf(req) {
    calls.push(req.label)
    return { outcome: 'returned', wire: { json: JSON.stringify(SYNTH({ units: [UNIT('a', { starting_paths: ['missing.js'] })] })) }, usage: null, receipt: { ...req.selection, invocationId: req.callId } }
  } }
  await assert.rejects(runNativeAuditStage(options), e => e.constructor.name === 'Refusal')
  assert.equal(stageDirs(runDir).length, 2)
  options.provider = validProvider
  await runNativeAuditStage(options)
  assert.equal(stageDirs(runDir).length, 3)
  assert.equal(calls.length, 6)
  assert.equal(loadRun(runDir).state.last, 'recon')
  assert.equal(loadRun(runDir).meta.agents_spent, 6)
}))

await test('saved native application receipt refuses changed result bytes before planning another stage', () => fixture(8, async ({ runDir, calls, options }) => {
  const done = await runNativeAuditStage(options)
  const file = join(runDir, 'stages', done.stageName, 'result.json')
  const result = JSON.parse(readFileSync(file)); result.reason = 'changed result'
  writeFileSync(file, JSON.stringify(result))
  await assert.rejects(runNativeAuditStage(options), /native application receipt changed/)
  assert.equal(calls.length, 4)
  assert.equal(stageDirs(runDir).length, 1)
}))

await test('final native verify publishes a current terminal report without reopening terminal grant authority', async () => {
  const run = await atVerify([{ name: 'a', candidates: ['fp-a'] }])
  await fixture(8, async ({ runDir, journal, calls, options }) => {
    options.provider = { async runLeaf(req) {
      calls.push(req.label)
      return { outcome: 'returned', wire: { json: JSON.stringify({ decision: 'verified', fingerprint: 'fp-a' }) }, usage: null, receipt: { ...req.selection, invocationId: req.callId } }
    } }
    const done = await runNativeAuditStage(options)
    assert.equal(done.result.stage, 'verify')
    assert.equal(calls.length, 1)
    assert.equal(loadRun(runDir).meta.run_status, 'complete')
    assert.equal(readPartialReport(runDir).status, 'current')
    assert.throws(() => journal.acknowledgeReport({ expectedRevision: journal.getControl().revision }), e => e.code === 'TERMINAL_RUN')
    assert.throws(() => journal.prepare({ id: 'terminal-extra', input: {} }), e => e.code === 'TERMINAL_RUN')
  }, run.runDir)
})

await test('failed post-application publication repairs before the next helper-step refusal without repeating agents', () => fixture(8, async ({ runDir, calls, options }) => {
  await runNativeAuditStage(options)
  const originalRename = fs.renameSync
  let failed = false
  try {
    fs.renameSync = (from, to) => {
      if (!failed && String(to).endsWith('/current.json') && loadRun(runDir).state.last === 'recon') {
        failed = true
        throw Object.assign(new Error('ordinary fixture publication failure'), { code: 'EIO' })
      }
      return originalRename(from, to)
    }
    syncBuiltinESMExports()
    await assert.rejects(runNativeAuditStage(options), e => e.code === 'REPORT_NOT_CURRENT')
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports() }
  assert.equal(failed, true)
  assert.equal(loadRun(runDir).state.last, 'recon')
  assert.equal(calls.length, 5)
  assert.notEqual(readPartialReport(runDir).status, 'current')
  await assert.rejects(runNativeAuditStage(options), /seed/)
  assert.equal(readPartialReport(runDir).status, 'current')
  assert.equal(calls.length, 5)
  assert.equal(readAuditJournal(runDir).settledCalls, 5)
  assert.equal(stageDirs(runDir).length, 2)
}))
