// profile-quick-waves.test.mjs - P-04: quick's one hunter wave and one final critic. After the critic result is applied the run goes straight to validation: no second wave, no
// final-clean critic; what the critic found, what it reopened and what no hunter reached are `deferred` with upstream's reason, never hunted. Acceptance test of
// .autobuild/contracts/profiles.md, section P-04. Frozen.
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { applyCritic, applyCriticProblems } from '../skills/security-audit/audit-ledger.mjs'
import { formatNext, nextStep } from '../skills/security-audit/audit-run.mjs'
import { audit, ledgerCli } from './audit-fixtures.mjs'
import { candidateOf, hunterResult, hunterUnit, ledgerValid, needsValidationRecord, priorRun, priorUnit, readJsonFile, readLedger, unitInput } from './ledger-fixtures.mjs'
import { QUICK_DEFERRED, afterWave, byName, critic, gap, quickUnit } from './profile-support.mjs'

console.log('== P-04: `next` for quick')
const M = (profile, extra = {}) => ({ run_status: 'in_progress', incomplete_reason: null, ...(profile ? { profile } : {}), ...extra })
const S = (last, wave = 0, critic_kind = null) => ({ version: 1, last, wave, critic_kind })
const unit = (status, extra = {}) => ({ status, result_fingerprints: [], ...extra })
const cand = (...fps) => unit('candidate', { result_fingerprints: fps })
const step = (profile, state, ledger, extra) => nextStep({ meta: M(profile, extra), state, ledger })

await test('the first critic of a quick run is the same step as standard\'s: after merge-wave, a post-wave critic of wave 1', () => {
  for (const profile of ['quick', 'standard', 'deep', undefined]) assert.deepEqual(step(profile, S('merge-wave', 1), [unit('covered')]), { step: 'critic', kind: 'post-wave', wave: 1 }, String(profile))
})
await test('after the critic result is applied, quick goes to validation, never to another wave or a final-clean critic, even with a unit still planned; standard and deep go on hunting', () => {
  const planned = [unit('covered'), unit('planned')]
  assert.equal(formatNext(step('quick', S('apply-critic', 1, 'post-wave'), planned)), 'NEXT: write-findings run=helper')
  assert.equal(formatNext(step('quick', S('apply-critic', 1, 'post-wave'), [unit('covered')])), 'NEXT: write-findings run=helper', 'no final-clean critic either')
  assert.equal(formatNext(step('quick', S('apply-critic', 1, 'post-wave'), [cand('fp-1'), unit('deferred')])), 'NEXT: validate run=workflow')
  assert.equal(formatNext(step('quick', S('apply-critic', 1, 'post-wave'), [cand('fp-1'), cand('fp-2')])), 'NEXT: consolidate run=workflow')
  for (const profile of ['standard', 'deep', undefined]) {
    assert.equal(formatNext(step(profile, S('apply-critic', 1, 'post-wave'), planned)), 'NEXT: plan-wave run=helper wave=2', String(profile))
    assert.equal(formatNext(step(profile, S('apply-critic', 1, 'post-wave'), [unit('covered')])), 'NEXT: critic run=workflow kind=final-clean wave=1', String(profile))
  }
})
await test('a quick run with nothing to hunt (every unit deferred, out of scope or carried) still gets its one critic, as the post-wave critic of wave 1, and then goes to validation; standard asks the final-clean critic', () => {
  const nothing = [unit('out_of_scope'), unit('deferred')]
  assert.deepEqual(step('quick', S('seed', 0), nothing), { step: 'critic', kind: 'post-wave', wave: 1, hunted: false })
  assert.deepEqual(step('standard', S('seed', 0), nothing), { step: 'critic', kind: 'final-clean', wave: 1, hunted: false })
  assert.deepEqual(step('quick', S('seed', 0), [unit('planned'), unit('out_of_scope')]), { step: 'plan-wave', wave: 1 })
  assert.equal(formatNext(step('quick', S('apply-critic', 1, 'post-wave'), nothing)), 'NEXT: write-findings run=helper')
})
await test('a quick run whose one wave the budget could not fund (plan-wave deferred every unit) still gets its one critic, the post-wave critic, not a final-clean one; standard asks the final-clean critic', () => {
  const deferredOnly = [unit('deferred'), unit('deferred')]
  assert.deepEqual(step('quick', S('plan-wave', 1), deferredOnly), { step: 'critic', kind: 'post-wave', wave: 1 })
  assert.deepEqual(step('standard', S('plan-wave', 1), deferredOnly), { step: 'critic', kind: 'final-clean', wave: 1 })
})
await test('quick\'s first wave is planned and hunted like any (plan-wave, hunt, merge-wave are unchanged), and a quick run that stopped incomplete still goes on to validate what it has', () => {
  assert.deepEqual(step('quick', S('plan-wave', 1), [unit('in_progress')]), { step: 'hunt', wave: 1 })
  assert.deepEqual(step('quick', S('hunt', 1), [unit('in_progress')]), { step: 'merge-wave', wave: 1 })
  assert.equal(formatNext(step('quick', S('merge-wave', 1), [cand('fp-1')], { run_status: 'incomplete', incomplete_reason: 'critic_budget_exhausted' })), 'NEXT: validate run=workflow')
})

console.log('== P-04: apply-critic in a quick run')
// Three units under one subsystem (so one hunter, h1-01): `a` covered, `b` a candidate, `c` not answered (returned to planned for another attempt, which quick does not have).
const results = (assigned, runDir) => {
  const agent = Object.keys(assigned)[0]
  const id = n => byName(readLedger(runDir))[n].coverage_id
  return { [agent]: hunterResult([hunterUnit(id('a'), agent), hunterUnit(id('b'), agent, { disposition: 'candidate', candidate_fingerprints: ['fp-b'] })], { candidates: [candidateOf('fp-b')] }) }
}
const wave = (profile, opts = {}) => {
  const run = afterWave([unitInput('a'), unitInput('b'), unitInput('c')], { profile, results, ...opts })
  return { ...run, by: byName(readLedger(run.runDir)) }
}
const mint = (...units) => ({ units })

await test('quick: what the critic found (minted units), what it reopened (reassign_ids) and what no hunter reached (a unit still planned) are deferred with quick_profile_final_critic, evidence archived, the ledger valid; the unit that is a candidate stays', () => {
  const { runDir, by } = wave('quick')
  assert.deepEqual([by.a.status, by.b.status, by.c.status], ['covered', 'candidate', 'planned'], 'the fixture: the state before the critic is applied')
  const out = applyCritic(runDir, critic({ missing_units: [gap('g')], reassign_ids: [by.a.coverage_id] }), mint(quickUnit('m1')))
  assert.match(out.summary, / deferred=3$/, out.summary)
  const after = byName(readLedger(runDir))
  const deferredLike = u => [u.status, u.agent_id, u.unresolved, u.reviewed_paths, u.local_checks, u.result_fingerprints]
  assert.deepEqual(deferredLike(after.a), ['deferred', null, [QUICK_DEFERRED], [], [], []], 'reopened: deferred, unassigned, no live evidence')
  assert.deepEqual([after.a.wave, after.a.attempts.length, after.a.attempts[0].status, after.a.attempts[0].agent_id], [2, 1, 'covered', 'h1-01'], '...its covered attempt archived, the wave incremented')
  assert.deepEqual(deferredLike(after.c), ['deferred', null, [QUICK_DEFERRED], [], [], []], 'no hunter reached it: deferred, not left planned')
  assert.deepEqual(deferredLike(after.m1), ['deferred', null, [QUICK_DEFERRED], [], [], []], 'minted: deferred, not planned')
  assert.deepEqual([after.b.status, after.b.result_fingerprints], ['candidate', ['fp-b']], 'a candidate is validated, not deferred')
  assert.ok(!Object.values(after).some(u => u.status === 'planned' || u.status === 'in_progress'), 'nothing is left to hunt')
  assert.ok(ledgerValid(runDir))
  assert.deepEqual(readJsonFile(runDir, 'uncovered.json'), [], 'the queue was spent')
  assert.equal(audit(['next', runDir]).last, 'NEXT: validate run=workflow')
  assert.match(ledgerCli(['plan-wave', runDir]).last, /^AUDIT: FAIL plan-wave is not the next step of this run: NEXT: validate run=workflow/, 'there is no second wave to plan')
})
await test('quick: a unit a verifier owns (a carried prior record) is not hunter work and stays planned, and the run goes to validation with its record; the hunted unit stays covered', () => {
  const before = repo => priorRun(repo, [priorUnit('nv', 'candidate', { result_fingerprints: ['fp-nv'] })], [needsValidationRecord('fp-nv')])
  const { runDir } = afterWave([unitInput('nv'), unitInput('a')], { profile: 'quick', opts: { before } })
  const kept = byName(readLedger(runDir))
  assert.deepEqual([kept.nv.status, kept.nv.prior_status, kept.nv.agent_id, kept.a.status], ['planned', 'prior_needs_validation', null, 'covered'], 'the fixture')
  const out = applyCritic(runDir, critic(), mint())
  assert.match(out.summary, / deferred=0$/, out.summary)
  const after = byName(readLedger(runDir))
  assert.deepEqual([after.nv.status, after.nv.prior_status, after.nv.unresolved, after.a.status], ['planned', 'prior_needs_validation', [], 'covered'])
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['next', runDir]).last, 'NEXT: validate run=workflow')
})
await test('quick: a unit the critic proposes outside a scoped run\'s scope is out_of_scope, as upstream says, not deferred; units hunters covered stay covered', () => {
  const { runDir } = afterWave([unitInput('a'), unitInput('b')], { profile: 'quick', opts: { args: ['--scope', 'src/app.js'] } })
  const out = applyCritic(runDir, critic({ missing_units: [gap('g', { starting_paths: ['src/db.js'] })] }), mint(quickUnit('m3', { starting_paths: ['src/db.js'] })))
  assert.match(out.summary, / deferred=0$/, out.summary)
  const by = byName(readLedger(runDir))
  assert.deepEqual([by.a.status, by.b.status, by.m3.status], ['covered', 'covered', 'out_of_scope'])
  assert.ok(ledgerValid(runDir))
})
await test('quick: a minted unit must be coarsened too, the same refusal as seed\'s, and the gap is counted as rejected, not added', () => {
  const { runDir } = wave('quick')
  const c = critic({ missing_units: [gap('g')] })
  const problems = applyCriticProblems(runDir, c, mint(unitInput('m2')))
  assert.ok(problems.some(p => /the quick profile coarsens every unit to one subsystem/.test(p)), JSON.stringify(problems))
  const out = applyCritic(runDir, c, mint(unitInput('m2')))
  assert.match(out.summary, /rejected=1/)
  assert.ok(!('m2' in byName(readLedger(runDir))))
})
for (const profile of ['standard', 'deep']) {
  await test(`${profile} is untouched by all of it: reopened, minted and unreached units are planned for the next wave, and the summary has no deferred count`, () => {
    const { runDir, by } = wave(profile)
    const out = applyCritic(runDir, critic({ missing_units: [gap('g')], reassign_ids: [by.a.coverage_id] }), mint(quickUnit('m1')))
    assert.doesNotMatch(out.summary, /deferred=/)
    const after = byName(readLedger(runDir))
    assert.deepEqual([after.a.status, after.a.wave, after.a.attempts.length, after.c.status, after.m1.status, after.b.status], ['planned', 2, 1, 'planned', 'planned', 'candidate'])
    assert.ok(ledgerValid(runDir))
    assert.equal(audit(['next', runDir]).last, 'NEXT: plan-wave run=helper wave=2')
  })
}
