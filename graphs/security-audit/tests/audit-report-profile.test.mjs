// audit-report-profile.test.mjs - the edges of what REPORT.md says about a run's profile that the frozen acceptance test (profile-report.test.mjs) leaves out: a meta with no profile or an
// unknown one reads as standard, the quick-deferred count is taken from the whole ledger (not the listed slice) and from no profile in particular, and quick's critic sentence is only
// for a critic that was not the final-clean one.
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { buildReports, reportContext } from '../skills/security-audit/audit-report.mjs'
import { QUICK_DEFERRED } from '../skills/security-audit/audit-profile.mjs'
import { META, STATE, UNIT, fixtureRun } from './report-fixtures.mjs'

console.log('== the report and the run profile: edges')
const CRITIC_DONE = { missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: true }
const reportOf = dir => buildReports(reportContext(dir), { findings: 'PASS: 0 findings valid', ledger: 'PASS: 1 coverage units valid' })['REPORT.md']
const report = ({ meta = META(), state = STATE(), ledger = [UNIT('a')] } = {}) => reportOf(fixtureRun({ meta, state, ledger, critic: CRITIC_DONE }))
const COUNT = n => `Units deferred as \`${QUICK_DEFERRED}\` (found by the one critic, reopened by it, or not reached by the one wave): ${n}. The quick profile does not hunt them.`
const quickDeferred = (name, over = {}) => UNIT(name, 'deferred', { unresolved: [QUICK_DEFERRED], ...over })
// The run line names the profile as recorded, so it is the one line that may differ between a meta with no profile and a standard one.
const withoutRunLine = text => text.split('\n').filter(l => !l.startsWith('- Run ')).join('\n')

await test('a meta with no profile, or one that is not a profile name, reports exactly as standard: no rules line, no profile reason, the standard status and critic sentences', () => {
  const state = STATE({ critic_kind: 'post-wave' })
  const standard = withoutRunLine(report({ state }))
  const { profile, ...noProfile } = META()
  assert.equal(profile, 'standard')
  assert.equal(withoutRunLine(report({ meta: noProfile, state })), standard, 'no profile key')
  assert.equal(withoutRunLine(report({ meta: META({ profile: 'fast' }), state })), standard, 'an unknown profile is not a partial pass of its own')
  assert.ok(!standard.includes('- Profile rules:') && !standard.includes('partial pass') && !standard.includes('by design'))
  assert.match(standard, /every retained record passed Phase 5 verification\./)
  assert.match(standard, /It was not the final-clean critic: coverage is not claimed to be clean\./)
})

await test('the quick-deferred count is the whole ledger\'s, though the gap list stops at 40', () => {
  const ledger = [UNIT('a'), ...Array.from({ length: 41 }, (_, i) => quickDeferred(`q${String(i).padStart(2, '0')}`))]
  const rows = report({ meta: META({ profile: 'quick' }), state: STATE({ critic_kind: 'post-wave', wave: 1 }), ledger }).split('\n')
  assert.equal(rows.filter(l => l.startsWith('- deferred: ')).length, 40, 'the list is cut at 40')
  assert.ok(rows.includes('- …and 1 more in coverage-ledger.json.'))
  assert.ok(rows.includes(COUNT(41)), 'the count is not cut')
  assert.equal(rows[rows.indexOf(COUNT(41)) - 1], '', 'a blank line before the count, which is its own paragraph')
})

await test('a deferred unit whose reasons include the string among others is counted; the count line is not tied to the run\'s profile', () => {
  const ledger = [UNIT('a'), quickDeferred('b', { unresolved: ['a note', QUICK_DEFERRED] })]
  assert.ok(report({ meta: META({ profile: 'quick' }), state: STATE({ critic_kind: 'post-wave', wave: 1 }), ledger }).split('\n').includes(COUNT(1)))
  for (const profile of ['standard', 'deep']) assert.ok(report({ meta: META({ profile }), ledger }).split('\n').includes(COUNT(1)), profile)
})

await test('a quick report whose last critic was final-clean (a run not made by this version) claims neither the missing final-clean critic nor the one-by-design critic', () => {
  const text = report({ meta: META({ profile: 'quick' }), state: STATE({ critic_kind: 'final-clean', wave: 2 }) })
  assert.match(text, /The last critic was the final-clean critic of wave 2: .* said stop true\.\n/)
  assert.ok(!text.includes('by design') && !text.includes('It was not the final-clean critic'))
})

await test('an incomplete quick run keeps the incomplete status line, and the quick reason is still explained from the one constant', () => {
  const text = report({ meta: META({ profile: 'quick', run_status: 'incomplete', incomplete_reason: QUICK_DEFERRED }) })
  assert.match(text, /The run is \*\*INCOMPLETE\*\* \(`quick_profile_final_critic`\): the quick profile deferred what its one critic found\. This is a partial pass\./)
  assert.ok(!text.includes('merged Phase 3 and Phase 5'), 'no completion claim of any kind')
  assert.match(text, /\*\*This is a partial pass:\*\* the run is incomplete; the quick profile does not run the full method\./)
})
