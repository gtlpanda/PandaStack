// profile-e2e-quick.test.mjs - P-09: a whole quick audit of the toy repository, offline, from `init --profile quick` to the reports, driven exactly as the entry skill says (the commands come
// out of SKILL.md, what runs next is whatever `next` prints), by scripted agents through the workflow harness; the vendored validators run on every artifact. Acceptance test of
// the PR 9 profile contract (retro.md, entry 43), section P-09.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { audit, meta, mkRepo, sh } from './audit-fixtures.mjs'
import { driveAudit } from './e2e-driver.mjs'
import { TOY_FILES } from './toy-app.mjs'
import { validateFindingsFile, validateLedgerFile } from '../skills/security-audit/upstream.mjs'
import { QUICK_DEFERRED, QUICK_REF } from './profile-support.mjs'
import { quickAnswer } from './profile-e2e-support.mjs'

console.log('== P-09: a whole quick audit, driven by the skill, offline')
const readJson = f => JSON.parse(readFileSync(f, 'utf8'))
const repo = mkRepo(TOY_FILES, 'toy')
const headBefore = sh(repo, 'rev-parse', 'HEAD')
const driven = await driveAudit({ repo, answer: quickAnswer, initArgs: ['--profile', 'quick', '--max-parallel', '2'] })
const { RUN, trace } = driven
const kinds = trace.map(s => `${s.step}${s.next.match(/kind=(\S+)/) ? `:${s.next.match(/kind=(\S+)/)[1]}` : ''}`)
const labels = trace.flatMap(s => s.calls.map(c => c.label))
const ledger = () => readJson(join(RUN, 'coverage-ledger.json'))

await test('the run is quick from init to done: next said done status=complete, and the profile is in the metadata and the status line', () => {
  assert.equal(audit(['next', RUN]).last, 'NEXT: done status=complete')
  const m = meta(RUN)
  assert.deepEqual([m.profile, m.run_status, m.incomplete_reason, m.budget, m.execution_capability], ['quick', 'complete', null, null, 'none'])
  assert.match(audit(['status', RUN]).lines[0], /: profile quick, complete$/)
})
await test('the path is quick\'s: recon, seed, ONE wave, ONE critic and its minter, apply, consolidate, validate, write, report: no second wave, no final-clean critic, no verify stage', () => {
  assert.deepEqual(kinds, ['recon', 'recon', 'seed', 'plan-wave', 'hunt', 'merge-wave', 'critic:post-wave', 'mint', 'apply-critic', 'consolidate', 'validate', 'write-findings', 'report', 'done'])
  assert.ok(!kinds.includes('verify') && !kinds.some(k => k.includes('final-clean')))
})
await test('the agents the run spent are exactly the scripted calls: one hunter owns the four coarse units, one critic, one minter, one grouping, and ONE verifier per candidate (v IDs only, no r)', () => {
  assert.deepEqual(labels, ['recon-1a', 'recon-1b', 'recon-1c', 'recon-1d', 'synth-recon', 'h1-01', 'c1', 'synth-mint1', 'synth-cons', 'v01', 'v02', 'v03', 'v04'])
  const m = meta(RUN)
  assert.equal(m.agents_spent, 13)
  assert.equal(Object.values(m.stage_spend).reduce((a, b) => a + b, 0), 13)
})
await test('the ledger: every unit is under upstream\'s one subsystem reference; the four hunted units are candidates; the two gaps the critic and the hunter found are deferred with quick_profile_final_critic, unassigned and empty', () => {
  const units = ledger()
  assert.equal(units.length, 6)
  assert.ok(units.every(u => u.canonical_refs.subsystem === QUICK_REF && u.lifecycle === undefined))
  assert.deepEqual(Object.fromEntries(['candidate', 'deferred', 'planned', 'in_progress'].map(s => [s, units.filter(u => u.status === s).length])), { candidate: 4, deferred: 2, planned: 0, in_progress: 0 })
  for (const u of units.filter(u => u.status === 'deferred')) assert.deepEqual([u.unresolved, u.agent_id, u.reviewed_paths, u.local_checks, u.result_fingerprints], [[QUICK_DEFERRED], null, [], [], []], u.surface)
  assert.ok(validateLedgerFile(join(RUN, 'coverage-ledger.json')).valid)
})
await test('Phase 3 and 5 were one pass: three leads and a rejected claim, each lead marked merged by its own v verifier; both validators pass, the run passes check, and no confirmed is anywhere', () => {
  const findings = readJson(join(RUN, 'findings.json'))
  assert.deepEqual(findings.map(f => [f.fingerprint, f.verdict]), [['config-service-key-literal', 'rejected'], ['cors-origin-reflected-with-credentials', 'needs_validation'], ['files-name-unchecked-path-join', 'needs_validation'], ['notes-byid-no-owner-check', 'needs_validation']])
  const entries = readJson(join(RUN, 'decisions.json')).entries
  for (const e of entries) assert.deepEqual(e.phase5, e.decision === 'rejected' ? null : { state: 'merged', verifier_id: e.verifier_id }, e.fingerprint)
  assert.ok(validateFindingsFile(join(RUN, 'findings.json')).valid)
  assert.equal(audit(['check', RUN]).last, `AUDIT: OK ${RUN} passes check`)
  for (const file of ['findings.json', 'coverage-ledger.json', 'candidates.json', 'decisions.json']) assert.ok(!/"verdict": "confirmed"|"proposed_verdict": "confirmed"|"decision": "confirmed"/.test(readFileSync(join(RUN, file), 'utf8')), file)
})
await test('the report says quick: the profile line, a partial pass, the two deferred units and the count, the one final critic by design; and it still says complete, source only, and not clean', () => {
  const report = readFileSync(join(RUN, 'REPORT.md'), 'utf8')
  const has = (text, what) => assert.ok(report.includes(text), what)
  has('- Profile rules: quick ran one hunter wave and one final critic pass', 'the profile rules line')
  has('**This is a partial pass:** the quick profile does not run the full method; some coverage was deferred.', 'partial pass, and why')
  has('Units deferred as `quick_profile_final_critic` (found by the one critic, reopened by it, or not reached by the one wave): 2. The quick profile does not hunt them.', 'the deferred count')
  has('It was the one final critic the quick profile runs, so no final-clean critic ran, by design: coverage is not claimed to be clean.', 'the critic sentence')
  has('The run is **complete**', 'complete'); has('no target code was executed', 'source only'); has('Complete is not clean', 'not clean')
  has('every retained record passed the quick profile\'s merged Phase 3 and Phase 5 verification.', 'the status says the verification was merged')
  assert.equal(report.split('\n').filter(l => l.startsWith('- deferred: ')).length, 2)
  const needs = readFileSync(join(RUN, 'NEEDS-VALIDATION.md'), 'utf8')
  for (const fp of ['notes-byid-no-owner-check', 'files-name-unchecked-path-join', 'cors-origin-reflected-with-credentials']) assert.ok(needs.includes(fp.replace(/_/g, '\\_')) || needs.includes(fp), `${fp} is a lead`)
  assert.ok(existsSync(join(RUN, 'FINDINGS-DETAIL.md')))
})
await test('the audited repository was not touched: the same commit, a clean tree, nothing ignored, and the run lives in .git/security-audit', () => {
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), headBefore)
  assert.equal(sh(repo, 'status', '--porcelain', '--ignored'), '')
  assert.ok(RUN.startsWith(join(repo, '.git', 'security-audit')))
})

console.log('== P-09: quick under a strict budget')
const budgeted = async (budget, opts = {}) => {
  const target = mkRepo(TOY_FILES, 'toy')
  const d = await driveAudit({ repo: target, answer: quickAnswer, initArgs: ['--profile', 'quick', '--budget', String(budget)], ...opts })
  return { ...d, meta: meta(d.RUN) }
}
await test('a quick run under a budget of exactly what it spends (13) completes and spends 13: a candidate costs one verifier, so none is left unvalidated for a Phase 5 reserve that never exists', async () => {
  const d = await budgeted(13)
  assert.deepEqual([d.meta.run_status, d.meta.incomplete_reason, d.meta.agents_spent, d.meta.budget], ['complete', null, 13, 13])
  assert.equal(audit(['check', d.RUN]).last, `AUDIT: OK ${d.RUN} passes check`)
})
await test('one agent fewer (12) never spends past the budget: the run ends complete, or incomplete with upstream\'s reason (which, depends on whether the grouping stage is skipped to save its agent), and passes check', async () => {
  const d = await budgeted(12, { tolerateRefusals: true })
  assert.ok(d.meta.agents_spent <= 12, `${d.meta.agents_spent} agents spent`)
  assert.ok(d.meta.run_status === 'complete' ? d.meta.incomplete_reason === null : d.meta.incomplete_reason === 'validation_budget_exhausted', `${d.meta.run_status} ${d.meta.incomplete_reason}`)
  assert.equal(audit(['check', d.RUN]).last, `AUDIT: OK ${d.RUN} passes check`)
})
