// audit-report-profile-claims.test.mjs - the report's `Profile rules` line states what the run did only when it did it. The acceptance test (profile-report.test.mjs) pins the line
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
import { SECOND_PASS_REASON } from '../skills/security-audit/audit-ledger.mjs'

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
const DEEP_RAN_NO_PRIOR = '- Profile rules: deep asked for units split per subsystem and lifecycle mode, ran critic waves to a clean pass, and kept candidate validation and final record verification as separate fresh agents; no unit had earlier coverage on unchanged source, so none needed an independent second pass.'
const DEEP_RAN_PARTLY = '- Profile rules: deep asked for units split per subsystem and lifecycle mode, ran critic waves to a clean pass, and kept candidate validation and final record verification as separate fresh agents; the budget did not allow every unit an earlier run covered on unchanged source an independent second pass.'
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
  assert.equal(rulesLine(run('deep')), DEEP_RAN_NO_PRIOR, 'a first deep run: the ran line, without a second-pass claim')
  const attempt = { wave: 1, status: 'covered', agent_id: 'h1-01', reviewed_paths: ['src/app.js'], local_checks: [checkOf('h1-01', ['src/app.js'])], result_fingerprints: [], unresolved: [], reassignment_reason: 'the critic listed this unit' }
  const archived = UNIT('a', 'deferred', { wave: 2, unresolved: [QUICK_DEFERRED], agent_id: null, attempts: [attempt] })
  assert.equal(rulesLine(run('quick', { ledger: [archived], state: { critic_kind: 'post-wave', wave: 1 } })), QUICK_RAN)
})
await test('a hunter that ran and returned nothing usable leaves no owner in the ledger, but its hunt stage spent agents: that run did run a hunter wave', () => {
  const lone = [UNIT('a', 'deferred', { unresolved: [QUICK_DEFERRED] })]
  const spent = stage_spend => ({ meta: { stage_spend, agents_spent: Object.values(stage_spend).reduce((a, b) => a + b, 0) }, ledger: lone, state: { critic_kind: 'post-wave', wave: 1 } })
  for (const key of ['03-hunt-w1', '12-hunt-w2', '03-hunt-w1-lost-0a1b2c3d']) assert.equal(rulesLine(run('quick', spent({ '01-recon-facts': 4, [key]: 1 }))), QUICK_RAN, key)
  for (const key of ['03-hunt-w1', 'hunt-w1', '03-hunt-w1x', '03-hunt-w', '03-mint-hunt-w1', '03-hunt-w1-lost-', '03-critic-post-wave-w1']) {
    const stages = { '01-recon-facts': 4, [key]: key === '03-hunt-w1' ? 0 : 1 }
    assert.equal(rulesLine(run('quick', spent(stages))), QUICK_ASKED + NO_HUNTER_TAIL, `${key} (${stages[key]} spent)`)
  }
})
await test('what counts as a hunter is an exact hunter ID: a verifier, a critic, a lookalike, or no owner is not one', () => {
  for (const agent of ['v01', 'r02', 'c1', 'xh1-01', 'h1-01x', 'h1', 'h-1-01', 'h1-01-02']) {
    const unit = UNIT('a', 'covered', { agent_id: agent })
    assert.equal(rulesLine(run('quick', { ledger: [unit], state: { critic_kind: 'post-wave', wave: 1 } })), QUICK_ASKED + NO_HUNTER_TAIL, `owner ${JSON.stringify(agent)}`)
  }
})
await test('a complete deep run that left a unit an earlier run covered on unchanged source without its second pass (the budget did not allow it) does not claim it; one that gave it keeps the pinned line, and one with no such unit (a first deep run) says none needed a pass', () => {
  const eligible = { ...UNIT('b'), prior_status: 'prior_covered_same_source' }
  assert.equal(rulesLine(run('deep', { ledger: [UNIT('a'), eligible] })), DEEP_RAN_PARTLY)
  const attempt = { wave: 1, status: 'covered', agent_id: 'h1-01', reviewed_paths: ['src/app.js'], local_checks: [checkOf('h1-01', ['src/app.js'])], result_fingerprints: [], unresolved: [], reassignment_reason: SECOND_PASS_REASON }
  const given = { ...UNIT('b', 'covered', { wave: 2, agent_id: 'h2-01', local_checks: [checkOf('h2-01', ['src/app.js'])], attempts: [attempt] }), prior_status: 'prior_covered_same_source' }
  assert.equal(rulesLine(run('deep', { ledger: [UNIT('a'), given] })), DEEP_RAN, 'the pass was given')
  assert.equal(rulesLine(run('deep', { ledger: [UNIT('a')] })), DEEP_RAN_NO_PRIOR, 'no such unit: no second pass is claimed')
  for (const status of ['candidate', 'blocked']) assert.equal(rulesLine(run('deep', { ledger: [UNIT('a'), { ...UNIT('b', status, status === 'candidate' ? { result_fingerprints: ['fp-b'] } : {}), prior_status: 'prior_covered_same_source' }] })), DEEP_RAN, `a ${status} unit is not eligible for the pass`)
  assert.equal(rulesLine(run('deep', { ledger: [UNIT('a'), { ...UNIT('b'), prior_status: 'prior_covered_changed_source' }] })), DEEP_RAN_NO_PRIOR, 'changed source is not eligible, so no second pass is claimed')
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
await test('a quick run whose one hunter throws is complete with every unit deferred: the hunter ran and spent its agent, and the report does not say no hunter ran', async () => {
  const failing = (label, ctx) => (/^h\d+-\d+$/.test(label) ? { throws: 'the hunter failed' } : quickAnswer(label, ctx))
  const d = await driveAudit({ repo: mkRepo(TOY_FILES, 'toy'), answer: failing, initArgs: ['--profile', 'quick'], tolerateRefusals: true })
  const m = meta(d.RUN)
  assert.deepEqual([m.run_status, m.incomplete_reason], ['complete', null])
  assert.ok(Object.keys(m.stage_spend).some(k => /-hunt-w1$/.test(k) && m.stage_spend[k] > 0), `a hunt stage spent agents: ${JSON.stringify(m.stage_spend)}`)
  assert.equal(rulesLine(readFileSync(join(d.RUN, 'REPORT.md'), 'utf8')), QUICK_RAN)
})
await test('quick at --budget 12 (complete, one hunter wave) keeps the pinned line; at --budget 11 (incomplete, validation_budget_exhausted) it claims nothing', async () => {
  assert.equal((await rulesOfRun('quick', quickAnswer, 12)).line, QUICK_RAN)
  const { m, line } = await rulesOfRun('quick', quickAnswer, 11)
  assert.deepEqual([m.run_status, m.incomplete_reason], ['incomplete', 'validation_budget_exhausted'])
  assert.equal(line, QUICK_ASKED + INCOMPLETE_TAIL)
})
await test('deep at --budget 11 (incomplete, validation_budget_exhausted) claims nothing; at --budget 10 (complete, no hunter) neither; at --budget 22 (complete, a first audit) it says what ran and that no second pass was needed', async () => {
  const eleven = await rulesOfRun('deep', deepAnswer, 11)
  assert.deepEqual([eleven.m.run_status, eleven.m.incomplete_reason], ['incomplete', 'validation_budget_exhausted'])
  assert.equal(eleven.line, DEEP_ASKED + INCOMPLETE_TAIL)
  const ten = await rulesOfRun('deep', deepAnswer, 10)
  assert.deepEqual([ten.m.run_status, ten.m.incomplete_reason], ['complete', null])
  assert.equal(ten.line, DEEP_ASKED + NO_HUNTER_TAIL)
  assert.equal((await rulesOfRun('deep', deepAnswer, 22)).line, DEEP_RAN_NO_PRIOR, 'a first real deep audit claims no second pass')
})
