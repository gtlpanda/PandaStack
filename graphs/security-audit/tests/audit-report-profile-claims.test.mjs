// audit-report-profile-claims.test.mjs - the report's `Profile rules` line states what the run did only when it did it. The frozen test (profile-report.test.mjs) pins the line
// of a complete run in which a hunter ran ("quick ran one hunter wave ...", "deep ... ran critic waves to a clean pass ..."). Two kinds of run cannot say that: an incomplete one
// (a deep run stopped by critic_budget_exhausted printed "ran critic waves to a clean pass" two sections above a Final critic that says the final-clean critic did not run, and
// upstream forbids a clean-coverage claim then) and a complete one in which no hunter ran (quick at --budget 8, the smallest init accepts, funds none). Both get a line that says what
// the profile asks for and that none of it is claimed as done.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { buildReports, reportContext } from '../skills/security-audit/audit-report.mjs'
import { audit, meta, mkRepo } from './audit-fixtures.mjs'
import { driveAudit } from './e2e-driver.mjs'
import { checkOf } from './ledger-fixtures.mjs'
import { META, STATE, UNIT, fixtureRun } from './report-fixtures.mjs'
import { TOY_FILES } from './toy-app.mjs'
import { deepAnswer, quickAnswer } from './profile-e2e-support.mjs'
import { QUICK_DEFERRED } from './profile-support.mjs'

console.log('== the report states what the profile ran only when it ran it')

const CRITIC_DONE = { missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: true }
const reportOf = dir => buildReports(reportContext(dir), { findings: 'PASS: 0 findings valid', ledger: 'PASS: 1 coverage units valid' })['REPORT.md']
const run = (profile, { meta: over = {}, state = {}, ledger = [UNIT('a')] } = {}) => reportOf(fixtureRun({ meta: META({ profile, ...over }), state: STATE(state), ledger, critic: CRITIC_DONE }))
const rulesLine = text => text.split('\n').find(l => l.startsWith('- Profile rules:'))
const incomplete = reason => ({ run_status: 'incomplete', incomplete_reason: reason })

const QUICK_RAN = '- Profile rules: quick ran one hunter wave and one final critic pass, with one fresh verifier per candidate doing both the candidate validation and the final record check; what the critic found and what it reopened are deferred, not hunted.'
const DEEP_RAN = '- Profile rules: deep asked for units split per subsystem and lifecycle mode, ran critic waves to a clean pass, kept candidate validation and final record verification as separate fresh agents, and gave units an earlier run covered on unchanged source an independent second pass.'
const QUICK_ASKED = '- Profile rules: quick asks for one hunter wave and one final critic pass, with one fresh verifier per candidate doing both the candidate validation and the final record check; what the critic finds and what it reopens are deferred, not hunted.'
const DEEP_ASKED = '- Profile rules: deep asks for units split per subsystem and lifecycle mode, critic waves until a clean pass, candidate validation and final record verification as separate fresh agents, and an independent second pass for units an earlier run covered on unchanged source.'
const INCOMPLETE_TAIL = ' This run is incomplete, so none of that is claimed as done: the Status section says why it stopped.'
const NO_HUNTER_TAIL = ' No hunter ran in this run, so none of that is claimed as done.'
const CLAIMS = [/ran one hunter wave/, /ran critic waves to a clean pass/, /gave units an earlier run covered/, /kept candidate validation and final record verification/]
const claimsNothing = (text, what) => { for (const c of CLAIMS) assert.ok(!c.test(text), `${what}: no ${c}`) }

await test('a deep run stopped by critic_budget_exhausted does not claim a clean pass, waves or a second pass, and its Final critic section no longer contradicts the Run section', () => {
  const text = run('deep', { meta: incomplete('critic_budget_exhausted'), state: { critic_kind: 'post-wave', wave: 2 } })
  assert.equal(rulesLine(text), DEEP_ASKED + INCOMPLETE_TAIL)
  claimsNothing(text, 'deep, critic_budget_exhausted')
  assert.ok(text.includes('The final-clean critic did not run: the budget no longer covered it. No clean-coverage claim is made.'), 'the Final critic section is as it was')
})
await test('an incomplete quick run, whatever stopped it, says what quick asks for and claims none of it', () => {
  for (const reason of ['validation_budget_exhausted', 'critic_budget_exhausted', 'ledger_validation_failed', 'budget_cannot_fund_reconnaissance_and_reserves', QUICK_DEFERRED]) {
    const text = run('quick', { meta: incomplete(reason), state: { critic_kind: 'post-wave', wave: 1 } })
    assert.equal(rulesLine(text), QUICK_ASKED + INCOMPLETE_TAIL, reason)
    claimsNothing(text, `quick, ${reason}`)
  }
})
await test('an incomplete deep run is the same whatever stopped it, and a run that is not complete (in progress) claims nothing either', () => {
  for (const over of [incomplete('validation_budget_exhausted'), incomplete('complete_check_failed'), { run_status: 'in_progress' }]) {
    const text = run('deep', { meta: over })
    assert.equal(rulesLine(text), DEEP_ASKED + INCOMPLETE_TAIL, JSON.stringify(over))
    claimsNothing(text, JSON.stringify(over))
  }
})

await test('a complete quick run in which no hunter ran (every unit deferred by the budget, or never assigned) does not say it ran a hunter wave; it says none of it is claimed as done', () => {
  const noHunter = [UNIT('a', 'deferred', { unresolved: ['budget_cannot_reserve_critics_and_validation'] }), UNIT('b', 'planned')]
  const text = run('quick', { ledger: noHunter, state: { critic_kind: 'post-wave', wave: 1 } })
  assert.equal(rulesLine(text), QUICK_ASKED + NO_HUNTER_TAIL)
  claimsNothing(text, 'quick, no hunter')
})
await test('a complete deep run in which no hunter ran says the same: it asks, and claims nothing as done', () => {
  const text = run('deep', { ledger: [UNIT('a', 'deferred', { unresolved: ['budget_cannot_reserve_critics_and_validation'] })] })
  assert.equal(rulesLine(text), DEEP_ASKED + NO_HUNTER_TAIL)
  claimsNothing(text, 'deep, no hunter')
})
await test('a complete run in which a hunter ran keeps the pinned line, whether its evidence is live or only archived (quick reopens a hunted unit and defers it, so the hunter is in attempts)', () => {
  assert.equal(rulesLine(run('quick')), QUICK_RAN)
  assert.equal(rulesLine(run('deep')), DEEP_RAN)
  const attempt = { wave: 1, status: 'covered', agent_id: 'h1-01', reviewed_paths: ['src/app.js'], local_checks: [checkOf('h1-01', ['src/app.js'])], result_fingerprints: [], unresolved: [], reassignment_reason: 'the critic listed this unit' }
  const archived = UNIT('a', 'deferred', { wave: 2, unresolved: [QUICK_DEFERRED], agent_id: null, attempts: [attempt] })
  assert.equal(rulesLine(run('quick', { ledger: [archived], state: { critic_kind: 'post-wave', wave: 1 } })), QUICK_RAN)
})
await test('what counts as a hunter is an exact hunter ID: a verifier, a critic, a lookalike, or no owner is not one', () => {
  for (const agent of ['v01', 'r02', 'c1', 'xh1-01', 'h1-01x', 'h1', 'h-1-01', 'h1-01-02']) {
    const unit = UNIT('a', 'covered', { agent_id: agent })
    assert.equal(rulesLine(run('quick', { ledger: [unit], state: { critic_kind: 'post-wave', wave: 1 } })), QUICK_ASKED + NO_HUNTER_TAIL, `owner ${JSON.stringify(agent)}`)
  }
})
await test('standard says nothing about its profile in any state, and a meta with no profile or an unknown one reads as standard', () => {
  for (const over of [{}, incomplete('critic_budget_exhausted'), incomplete('validation_budget_exhausted')]) assert.equal(rulesLine(run('standard', { meta: over })), undefined, JSON.stringify(over))
  for (const profile of [undefined, 'fast', null]) assert.equal(rulesLine(run(profile, { meta: incomplete('critic_budget_exhausted') })), undefined, String(profile))
})

// ---------- the real path: runs the budget decides ----------
const rulesOfRun = async (profile, answer, budget) => {
  const d = await driveAudit({ repo: mkRepo(TOY_FILES, 'toy'), answer, initArgs: ['--profile', profile, '--budget', String(budget)], tolerateRefusals: true })
  return { m: meta(d.RUN), line: rulesLine(readFileSync(join(d.RUN, 'REPORT.md'), 'utf8')), check: audit(['check', d.RUN]).last, RUN: d.RUN }
}

await test('quick at --budget 8, the smallest init accepts: the run is complete, no hunter ran, and the report does not say one did', async () => {
  const { m, line, check, RUN } = await rulesOfRun('quick', quickAnswer, 8)
  assert.deepEqual([m.run_status, m.incomplete_reason], ['complete', null])
  assert.ok(!Object.keys(m.stage_spend).some(k => k.includes('hunt')), `no hunt stage spent an agent: ${Object.keys(m.stage_spend)}`)
  assert.equal(line, QUICK_ASKED + NO_HUNTER_TAIL)
  assert.equal(check, `AUDIT: OK ${RUN} passes check`)
})
await test('quick at --budget 12 (complete, one hunter wave) keeps the pinned line; at --budget 11 (incomplete, validation_budget_exhausted) it claims nothing', async () => {
  assert.equal((await rulesOfRun('quick', quickAnswer, 12)).line, QUICK_RAN)
  const { m, line } = await rulesOfRun('quick', quickAnswer, 11)
  assert.deepEqual([m.run_status, m.incomplete_reason], ['incomplete', 'validation_budget_exhausted'])
  assert.equal(line, QUICK_ASKED + INCOMPLETE_TAIL)
})
await test('deep at --budget 11 (incomplete, validation_budget_exhausted) claims nothing; at --budget 10 (complete, no hunter) neither; at --budget 22 (complete) it keeps the pinned line', async () => {
  const eleven = await rulesOfRun('deep', deepAnswer, 11)
  assert.deepEqual([eleven.m.run_status, eleven.m.incomplete_reason], ['incomplete', 'validation_budget_exhausted'])
  assert.equal(eleven.line, DEEP_ASKED + INCOMPLETE_TAIL)
  const ten = await rulesOfRun('deep', deepAnswer, 10)
  assert.deepEqual([ten.m.run_status, ten.m.incomplete_reason], ['complete', null])
  assert.equal(ten.line, DEEP_ASKED + NO_HUNTER_TAIL)
  assert.equal((await rulesOfRun('deep', deepAnswer, 22)).line, DEEP_RAN)
})
