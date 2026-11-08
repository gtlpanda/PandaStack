// profile-report.test.mjs - P-07: what a report says about the profile. quick is a partial pass and says what it deferred; deep is not a partial pass because of its profile (it is more
// than standard, not less) and states what it ran; standard says nothing new. Acceptance test of .autobuild/contracts/profiles.md, section P-07. Frozen.
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { buildReports, reportContext } from '../skills/security-audit/audit-report.mjs'
import { META, STATE, UNIT, fixtureRun } from './report-fixtures.mjs'
import { QUICK_DEFERRED } from './profile-support.mjs'

console.log('== P-07: the report states the profile')
const reportOf = dir => buildReports(reportContext(dir), { findings: 'PASS: 0 findings valid', ledger: 'PASS: 1 coverage units valid' })['REPORT.md']
const CRITIC_DONE = { missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: true }
const run = (profile, over = {}) => reportOf(fixtureRun({ meta: META({ profile, ...(over.meta ?? {}) }), state: STATE(over.state ?? {}), ledger: over.ledger ?? [UNIT('a')], critic: CRITIC_DONE }))
const lines = text => text.split('\n')
// A failed match prints one short line, not the whole report.
const says = (text, pattern, what) => assert.ok(pattern.test(text), what)
const lacks = (text, pattern, what) => assert.ok(!pattern.test(text), what)
const QUICK_LINE = '- Profile rules: quick ran one hunter wave and one final critic pass, with one fresh verifier per candidate doing both the candidate validation and the final record check; what the critic found and what it reopened are deferred, not hunted.'
const DEEP_LINE = '- Profile rules: deep asked for units split per subsystem and lifecycle mode, ran critic waves to a clean pass, kept candidate validation and final record verification as separate fresh agents, and gave units an earlier run covered on unchanged source an independent second pass.'

await test('the Run section says what the profile ran: one exact line for quick and one for deep, none for standard', () => {
  assert.ok(lines(run('quick')).includes(QUICK_LINE), 'quick')
  assert.ok(lines(run('deep')).includes(DEEP_LINE), 'deep')
  assert.ok(!lines(run('standard')).some(l => l.startsWith('- Profile rules:')), 'standard has no such line')
  assert.ok(!lines(run('quick')).includes(DEEP_LINE) && !lines(run('deep')).includes(QUICK_LINE))
  for (const [profile, line] of [['quick', QUICK_LINE], ['deep', DEEP_LINE]]) {
    const rows = lines(run(profile))
    assert.equal(rows.indexOf(line), rows.findIndex(l => l.startsWith('- Run ')) + 1, `${profile}: the line is right after the "- Run" line`)
  }
})
await test('the Status section of a complete quick run does not claim a Phase 5 pass that never ran as its own: it says the verification was the quick profile\'s merged Phase 3 and Phase 5; standard and deep keep their sentence', () => {
  const merged = 'every retained record passed the quick profile\'s merged Phase 3 and Phase 5 verification.'
  says(run('quick'), new RegExp(merged.replace(/[.']/g, '\\$&')), 'quick')
  lacks(run('quick'), /passed Phase 5 verification/, 'quick: no separate Phase 5 is claimed')
  for (const profile of ['standard', 'deep']) {
    says(run(profile), /every retained record passed Phase 5 verification\./, profile)
    lacks(run(profile), /merged Phase 3 and Phase 5/, profile)
  }
})
await test('quick is a partial pass because of its profile, in the words it already had; a complete deep run under no scope or budget is not a partial pass at all, and neither is standard', () => {
  says(run('quick'), /\*\*This is a partial pass:\*\* the quick profile does not run the full method\./, 'quick: partial pass, because of its profile')
  assert.ok(!run('deep').includes('partial pass'), 'deep')
  assert.ok(!run('standard').includes('partial pass'), 'standard')
})
await test('the profile is one reason among the others, never the only one that matters: scope, budget and deferred coverage are stated for each profile, and for deep never as a profile reason', () => {
  const scoped = { meta: { scope_paths: ['src/app.js'], budget: 100 } }
  says(run('quick', scoped), /\*\*This is a partial pass:\*\* it was scoped to `src\/app\.js`; the quick profile does not run the full method; it ran under a strict budget of 100 agent invocations\./, 'quick, scoped, budgeted')
  says(run('deep', scoped), /\*\*This is a partial pass:\*\* it was scoped to `src\/app\.js`; it ran under a strict budget of 100 agent invocations\./, 'deep, scoped, budgeted: no profile reason')
  says(run('deep', { ledger: [UNIT('a'), UNIT('b', 'deferred')] }), /\*\*This is a partial pass:\*\* some coverage was deferred\./, 'deep with deferred coverage')
  says(run('deep', { meta: { run_status: 'incomplete', incomplete_reason: 'validation_budget_exhausted' } }), /\*\*This is a partial pass:\*\* the run is incomplete\./, 'deep, incomplete')
})
await test('the final critic section of a quick run says its one critic was the final one by design (and not that a final-clean critic is missing); standard\'s and deep\'s sentences are as they were', () => {
  const sentence = /The last critic was the post-wave critic of wave 1: .* It was the one final critic the quick profile runs, so no final-clean critic ran, by design: coverage is not claimed to be clean\./
  const quick = run('quick', { state: { critic_kind: 'post-wave', wave: 1 } })
  says(quick, sentence, 'quick: its one critic was the final one by design')
  lacks(quick, /It was not the final-clean critic/, 'quick: no missing final-clean critic is claimed')
  for (const profile of ['standard', 'deep']) {
    const text = run(profile, { state: { critic_kind: 'post-wave', wave: 2 } })
    says(text, /It was not the final-clean critic: coverage is not claimed to be clean\./, `${profile}: a post-wave critic is not the final one`)
    lacks(text, /by design/, profile)
    lacks(run(profile, { state: { critic_kind: 'final-clean', wave: 2 } }), /by design|not the final-clean/, `${profile}: the final-clean critic`)
  }
})
await test('units deferred as quick_profile_final_critic are listed with their reason and counted in one sentence that says the profile does not hunt them; no such sentence without any', () => {
  const ledger = [UNIT('a'), UNIT('b', 'deferred', { unresolved: [QUICK_DEFERRED] }), UNIT('c', 'deferred', { unresolved: [QUICK_DEFERRED] }), UNIT('d', 'deferred', { unresolved: ['budget_cannot_reserve_critics_and_validation'] })]
  const text = run('quick', { ledger, state: { critic_kind: 'post-wave', wave: 1 } })
  const deferred = lines(text).filter(l => l.startsWith('- deferred: '))
  assert.equal(deferred.length, 3)
  assert.equal(deferred.filter(l => l.endsWith(`: ${QUICK_DEFERRED.replaceAll('_', '\\_')}`)).length, 2, 'each is listed with its reason, escaped as every quoted text is')
  assert.ok(lines(text).includes('Units deferred as `quick_profile_final_critic` (found by the one critic, reopened by it, or not reached by the one wave): 2. The quick profile does not hunt them.'))
  assert.ok(!run('quick', { ledger: [UNIT('a'), UNIT('d', 'deferred', { unresolved: ['budget_cannot_reserve_critics_and_validation'] })] }).includes('Units deferred as `quick_profile_final_critic`'))
  // Text a hunter wrote is never counted: a blocked unit's unresolved text that happens to be the reason, and a deferred unit's that merely contains it, are not deferred-as-quick units.
  const hostile = [UNIT('a'), UNIT('b', 'deferred', { unresolved: [QUICK_DEFERRED] }), UNIT('c', 'blocked', { unresolved: [QUICK_DEFERRED] }), UNIT('d', 'deferred', { unresolved: [`not ${QUICK_DEFERRED} at all`] })]
  assert.ok(lines(run('quick', { ledger: hostile, state: { critic_kind: 'post-wave', wave: 1 } })).includes('Units deferred as `quick_profile_final_critic` (found by the one critic, reopened by it, or not reached by the one wave): 1. The quick profile does not hunt them.'), 'only the deferred unit whose reason is exactly the string is counted')
})
await test('the deferred count sits in the coverage summary, after the gap list and before the final critic section', () => {
  const rows = lines(run('quick', { ledger: [UNIT('a'), UNIT('b', 'deferred', { unresolved: [QUICK_DEFERRED] })], state: { critic_kind: 'post-wave', wave: 1 } }))
  const at = rows.findIndex(l => l.startsWith('Units deferred as `quick_profile_final_critic`'))
  assert.ok(at > rows.findLastIndex(l => l.startsWith('- deferred: ')) && at < rows.indexOf('### Final critic'), `line ${at}`)
})
