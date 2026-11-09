// profile-deep.test.mjs - P-06: what deep adds to standard. A unit an earlier run covered on unchanged source (prior_covered_same_source) gets an independent second pass: once,
// at the first critic application after this run's own pass covered it, archived in `attempts` with a fresh owner for the next wave. Deep's critics and its two verification passes
// are standard's, and nothing else of standard moves. Acceptance test of the PR 9 profile contract (retro.md, entry 43), section P-06.
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { applyCritic, mergeWave, planWave, seed } from '../skills/security-audit/audit-ledger.mjs'
import { advanceState, formatNext, nextStep } from '../skills/security-audit/audit-run.mjs'
import { audit, newRun } from './audit-fixtures.mjs'
import { assignments, candidateOf, coverAll, hunterResult, hunterUnit, ledgerValid, priorRun, priorUnit, readLedger, reconInput, unitInput } from './ledger-fixtures.mjs'
import { SECOND_PASS_REASON, asProfile, byName, critic } from './profile-support.mjs'

console.log('== P-06: the second pass')
// An earlier run covered `prior` units (and left no other trace); this run seeds `names` under the default profile, is then recorded as `profile` (a quick seed would refuse units that
// are not coarsened, which is P-03's business), takes wave 1 to a merged result (`results`: every unit covered by default) and saves the critic: apply-critic is next.
function firstCritic(profile, { names = ['keep', 'fresh'], prior = ['keep'], results = coverAll } = {}) {
  const run = newRun({ before: repo => priorRun(repo, prior.map(n => priorUnit(n, 'covered'))) })
  seed(run.runDir, reconInput(names.map(n => unitInput(n))))
  asProfile(run.runDir, profile)
  planWave(run.runDir)
  advanceState(run.runDir, 'hunt')
  mergeWave(run.runDir, results(assignments(run.runDir), run.runDir))
  advanceState(run.runDir, 'critic', { critic_kind: 'post-wave' })
  advanceState(run.runDir, 'mint')
  return run
}
const state = runDir => byName(readLedger(runDir))

await test('fixture: the unit an earlier run covered carries prior_covered_same_source into the new run, and wave 1 covers both units under one hunter', () => {
  const { runDir } = firstCritic('standard')
  const by = state(runDir)
  assert.deepEqual([by.keep.prior_status, by.fresh.prior_status, by.keep.status, by.fresh.status, by.keep.agent_id], ['prior_covered_same_source', 'new', 'covered', 'covered', 'h1-01'])
})
await test('deep: the first critic application archives the same-source covered unit\'s pass and plans it again (wave 2, unassigned, empty evidence); a unit the earlier run did not cover is left alone', () => {
  const { runDir } = firstCritic('deep')
  const out = applyCritic(runDir, critic(), { units: [] })
  assert.match(out.summary, / second_pass=1$/, out.summary)
  const by = state(runDir)
  assert.deepEqual([by.keep.status, by.keep.wave, by.keep.agent_id, by.keep.unresolved, by.keep.reviewed_paths, by.keep.local_checks, by.keep.result_fingerprints], ['planned', 2, null, [], [], [], []])
  assert.equal(by.keep.attempts.length, 1)
  assert.deepEqual([by.keep.attempts[0].wave, by.keep.attempts[0].status, by.keep.attempts[0].agent_id, by.keep.attempts[0].reassignment_reason], [1, 'covered', 'h1-01', SECOND_PASS_REASON])
  assert.deepEqual([by.fresh.status, by.fresh.wave, by.fresh.attempts.length], ['covered', 1, 0])
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['next', runDir]).last, 'NEXT: plan-wave run=helper wave=2')
})
await test('deep: the second pass is an independent hunter in the next wave, and it happens once: the second critic application leaves the unit alone and the run goes on to the final-clean critic', () => {
  const { runDir } = firstCritic('deep')
  applyCritic(runDir, critic(), { units: [] })
  planWave(runDir)
  const owners = assignments(runDir)
  assert.deepEqual(Object.values(owners).flat(), [state(runDir).keep.coverage_id], 'only the unit being passed again is hunted')
  assert.deepEqual(Object.keys(owners), ['h2-01'], 'a fresh owner, not wave 1\'s')
  advanceState(runDir, 'hunt')
  mergeWave(runDir, coverAll(owners))
  advanceState(runDir, 'critic', { critic_kind: 'post-wave' })
  advanceState(runDir, 'mint')
  const out = applyCritic(runDir, critic(), { units: [] })
  assert.match(out.summary, / second_pass=0$/, out.summary)
  const keep = state(runDir).keep
  assert.deepEqual([keep.status, keep.agent_id, keep.wave, keep.attempts.length], ['covered', 'h2-01', 2, 1])
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['next', runDir]).last, 'NEXT: critic run=workflow kind=final-clean wave=2')
})
await test('deep: a unit the critic itself reopens in the same application is not archived a second time for the second pass', () => {
  const { runDir } = firstCritic('deep')
  const keepId = state(runDir).keep.coverage_id
  const out = applyCritic(runDir, critic({ reassign_ids: [keepId] }), { units: [] })
  assert.match(out.summary, /reassigned=1 .* second_pass=0$/, out.summary)
  assert.equal(state(runDir).keep.attempts.length, 1)
  assert.equal(state(runDir).keep.status, 'planned')
})
await test('deep: only a unit this run covered gets the second pass: a prior same-source unit that came back a candidate or blocked is left as it is, and the summary counts one', () => {
  const mixed = (assigned, runDir) => {
    const agent = Object.keys(assigned)[0], id = n => state(runDir)[n].coverage_id
    return { [agent]: hunterResult([hunterUnit(id('keep'), agent), hunterUnit(id('cand'), agent, { disposition: 'candidate', candidate_fingerprints: ['fp-cand'] }), hunterUnit(id('blk'), agent, { disposition: 'blocked', unresolved: ['needs a runtime fact'] })], { candidates: [candidateOf('fp-cand')] }) }
  }
  const { runDir } = firstCritic('deep', { names: ['keep', 'cand', 'blk'], prior: ['keep', 'cand', 'blk'], results: mixed })
  const before = state(runDir)
  assert.deepEqual([before.keep.status, before.cand.status, before.blk.status, before.cand.prior_status, before.blk.prior_status], ['covered', 'candidate', 'blocked', 'prior_covered_same_source', 'prior_covered_same_source'], 'the fixture')
  const out = applyCritic(runDir, critic(), { units: [] })
  assert.match(out.summary, / second_pass=1$/, out.summary)
  const by = state(runDir)
  assert.deepEqual([by.keep.status, by.keep.wave, by.cand.status, by.cand.attempts.length, by.blk.status, by.blk.attempts.length], ['planned', 2, 'candidate', 0, 'blocked', 0])
  assert.ok(ledgerValid(runDir))
})
for (const profile of ['standard', 'quick']) {
  await test(`${profile}: no second pass: the same-source covered unit stays covered, nothing is archived, and the summary has no second_pass count`, () => {
    const { runDir } = firstCritic(profile)
    const out = applyCritic(runDir, critic(), { units: [] })
    assert.doesNotMatch(out.summary, /second_pass/)
    const keep = state(runDir).keep
    assert.deepEqual([keep.status, keep.wave, keep.attempts.length], ['covered', 1, 0])
    assert.ok(ledgerValid(runDir))
    assert.equal(audit(['next', runDir]).last, profile === 'quick' ? 'NEXT: write-findings run=helper' : 'NEXT: critic run=workflow kind=final-clean wave=1')
  })
}

console.log('== P-06: everything else of deep is standard\'s')
const M = (profile, extra = {}) => ({ run_status: 'in_progress', incomplete_reason: null, profile, ...extra })
const S = (last, wave = 0, critic_kind = null) => ({ version: 1, last, wave, critic_kind })
const unit = (status, extra = {}) => ({ status, result_fingerprints: [], ...extra })
const cand = (...fps) => unit('candidate', { result_fingerprints: fps })

await test('next is the same line for deep as for standard in every state of the stage machine: the critics run to a clean pass, and verification keeps its own stage', () => {
  const states = [
    [S('init'), []], [S('recon'), []], [S('seed'), [unit('planned')]], [S('seed'), [unit('out_of_scope')]], [S('plan-wave', 1), [unit('in_progress')]], [S('hunt', 1), [unit('in_progress')]],
    [S('merge-wave', 1), [unit('covered')]], [S('critic', 1), [unit('covered')]], [S('mint', 1), [unit('covered')]],
    [S('apply-critic', 1, 'post-wave'), [unit('covered'), unit('planned')]], [S('apply-critic', 1, 'post-wave'), [unit('covered')]], [S('apply-critic', 2, 'final-clean'), [cand('fp-1')]],
    [S('apply-critic', 2, 'final-clean'), [cand('fp-1'), cand('fp-2')]], [S('apply-critic', 2, 'final-clean'), [unit('covered')]], [S('consolidate', 2), [cand('fp-1')]], [S('validate', 2), [cand('fp-1')]],
  ]
  for (const [st, ledger] of states) assert.equal(formatNext(nextStep({ meta: M('deep'), state: st, ledger })), formatNext(nextStep({ meta: M('standard'), state: st, ledger })), JSON.stringify([st, ledger.map(u => u.status)]))
  const records = [{ verdict: 'needs_validation' }]
  assert.equal(formatNext(nextStep({ meta: M('deep'), state: S('write-findings', 2, 'final-clean'), ledger: [], findings: records })), 'NEXT: verify run=workflow')
  assert.equal(formatNext(nextStep({ meta: M('deep'), state: S('verify', 2, 'final-clean'), ledger: [], findings: records })), 'NEXT: report run=helper')
})
