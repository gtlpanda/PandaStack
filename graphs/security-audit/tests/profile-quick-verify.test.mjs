// profile-quick-verify.test.mjs - P-05: quick merges Phase 3 and Phase 5. The one fresh verifier of a candidate is given upstream's Phase 5 record checks too and returns the final
// record; there is no verify stage; complete-check accepts that verifier as the record's Phase 5 only in a quick run. Standard and deep keep two separate passes. Acceptance test of
// .autobuild/contracts/profiles.md, section P-05. Frozen.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { completeProblems, writeFindings } from '../skills/security-audit/audit-findings.mjs'
import { nextStep, formatNext } from '../skills/security-audit/audit-run.mjs'
import { audit, meta } from './audit-fixtures.mjs'
import { readJsonFile } from './ledger-fixtures.mjs'
import { decisions, next, rejected, round, toValidate, verified } from './verdict-fixtures.mjs'
import { stage } from './stage-fixtures.mjs'
import { asProfile, phase5Block } from './profile-support.mjs'

console.log('== P-05: `next` after write-findings')
const M = (profile, extra = {}) => ({ run_status: 'in_progress', incomplete_reason: null, ...(profile ? { profile } : {}), ...extra })
const S = (last, wave = 1, critic_kind = 'final-clean') => ({ version: 1, last, wave, critic_kind })

await test('after write-findings a quick run goes to the report (its Phase 3 verifier was its Phase 5), standard and deep to verify when a record needs it, and a profile-less run as standard', () => {
  const records = [{ verdict: 'needs_validation' }, { verdict: 'rejected' }]
  const at = profile => formatNext(nextStep({ meta: M(profile), state: S('write-findings'), ledger: [], findings: records }))
  assert.equal(at('quick'), 'NEXT: report run=helper')
  for (const profile of ['standard', 'deep', undefined]) assert.equal(at(profile), 'NEXT: verify run=workflow', String(profile))
  const onlyRejected = profile => formatNext(nextStep({ meta: M(profile), state: S('write-findings'), ledger: [], findings: [{ verdict: 'rejected' }] }))
  for (const profile of ['quick', 'standard', 'deep']) assert.equal(onlyRejected(profile), 'NEXT: report run=helper', `${profile}: nothing needs Phase 5`)
  assert.equal(formatNext(nextStep({ meta: M('quick', { run_status: 'incomplete', incomplete_reason: 'validation_budget_exhausted' }), state: S('write-findings'), ledger: [], findings: records })), 'NEXT: report run=helper reason=validation_budget_exhausted')
})

console.log('== P-05: the merged verifier')
const DEFS = [{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }]
const answer = (label, c) => (c.fingerprint === 'fp-b' ? rejected('fp-b') : verified(c.fingerprint))
// A run taken to the validate stage as `profile`, the stage planned, run against scripted analysts, and applied.
async function validated(profile) {
  const run = toValidate(DEFS)
  asProfile(run.runDir, profile)
  assert.equal(next(run.runDir), 'NEXT: validate run=workflow')
  const res = await round(run.runDir, answer)
  assert.equal(res.apply.status, 0, res.apply.stdout)
  return { ...run, ...res }
}
const entry = (runDir, fp) => decisions(runDir).entries.find(e => e.fingerprint === fp)

await test('quick: the validate stage carries upstream\'s Phase 5 block (parts.phase5), the verifier\'s prompt has it verbatim and says the record it returns is final', async () => {
  const { input, prompts } = await validated('quick')
  assert.ok(input.parts?.phase5 === phase5Block(), 'input.parts.phase5 is upstream\'s "Phase 5: Verify the final records with fresh eyes" block, byte for byte')
  for (const [label, prompt] of Object.entries(prompts)) {
    assert.ok(prompt.includes(phase5Block()), `${label}: the prompt has the Phase 5 block, byte for byte`)
    assert.match(prompt, /Phase 5 record checks, merged into this pass/, label)
    assert.match(prompt, /no later Phase 5 pass/, `${label}: the verifier is told its record is the final one`)
  }
})
for (const profile of ['standard', 'deep']) {
  await test(`${profile}: the validate stage is as it was: no parts.phase5 and no Phase 5 text in the verifier's prompt`, async () => {
    const { input, prompts } = await validated(profile)
    assert.ok(!('phase5' in (input.parts ?? {})))
    for (const [label, prompt] of Object.entries(prompts)) assert.ok(!prompt.includes(phase5Block()) && !/merged into this pass/.test(prompt), label)
  })
}
await test('quick: each decided record that Phase 5 would have read (needs_validation) is marked merged by its own Phase 3 verifier; a rejected one is not marked', async () => {
  const { runDir } = await validated('quick')
  const a = entry(runDir, 'fp-a'), b = entry(runDir, 'fp-b')
  assert.deepEqual([a.state, a.decision, a.phase5], ['decided', 'needs_validation', { state: 'merged', verifier_id: a.verifier_id }])
  assert.deepEqual([b.state, b.decision, b.phase5], ['decided', 'rejected', null])
  assert.match(a.verifier_id, /^v\d{2}$/, 'a Phase 3 verifier\'s ID, not a Phase 5 one')
})
await test('quick: write-findings ends the run: both validators pass, the run is complete, next says report, complete-check finds nothing, and no verify step is ever named', async () => {
  const { runDir } = await validated('quick')
  writeFindings(runDir)
  assert.equal(meta(runDir).run_status, 'complete')
  assert.equal(meta(runDir).incomplete_reason, null)
  assert.equal(next(runDir), 'NEXT: report run=helper')
  assert.deepEqual(completeProblems(runDir).problems, [])
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
  assert.deepEqual(readJsonFile(runDir, 'findings.json').map(r => [r.fingerprint, r.verdict]), [['fp-a', 'needs_validation'], ['fp-b', 'rejected']])
})
await test('quick: the merge is checked, not trusted: a record whose marker names another verifier, or has none, makes the run incomplete (complete_check_failed) at write-findings', async () => {
  for (const tamper of [e => { e.phase5 = { state: 'merged', verifier_id: 'v77' } }, e => { e.phase5 = null }, e => { e.phase5 = { state: 'verified', verifier_id: e.verifier_id } }]) {
    const { runDir } = await validated('quick')
    const file = join(runDir, 'decisions.json')
    const d = JSON.parse(readFileSync(file, 'utf8'))
    tamper(d.entries.find(e => e.fingerprint === 'fp-a'))
    writeFileSync(file, JSON.stringify(d, null, 2))
    writeFindings(runDir)
    assert.deepEqual([meta(runDir).run_status, meta(runDir).incomplete_reason], ['incomplete', 'complete_check_failed'], JSON.stringify(tamper.toString()))
  }
})
// A quick run in which fp-a's first verifier returned nothing (its result is discarded and it is retried once) and the retry, v01-t2, was kept: both are validators of fp-a in the history.
async function retried() {
  const run = toValidate(DEFS)
  asProfile(run.runDir, 'quick')
  const first = await round(run.runDir, (label, c) => (c.fingerprint === 'fp-a' ? null : answer(label, c)))
  assert.equal(first.apply.status, 0, first.apply.stdout)
  assert.equal(next(run.runDir), 'NEXT: validate run=workflow')
  const second = await round(run.runDir, answer)
  assert.equal(second.apply.status, 0, second.apply.stdout)
  const a = entry(run.runDir, 'fp-a')
  assert.deepEqual([a.state, a.verifier_id, a.phase5], ['decided', 'v01-t2', { state: 'merged', verifier_id: 'v01-t2' }], 'the fixture: the kept result is the retry\'s')
  return run
}
await test('quick: the marker names the verifier whose result was kept, not an earlier attempt of the same candidate that was discarded (both are validators of it in the independence history)', async () => {
  const run = await retried()
  const file = join(run.runDir, 'decisions.json')
  const d = JSON.parse(readFileSync(file, 'utf8'))
  d.entries.find(e => e.fingerprint === 'fp-a').phase5 = { state: 'merged', verifier_id: 'v01' }
  writeFileSync(file, JSON.stringify(d, null, 2))
  writeFindings(run.runDir)
  assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['incomplete', 'complete_check_failed'])
})
await test('quick: the marker must name an agent the independence history holds as that candidate\'s validator: with the kept verifier dropped from the history (the discarded attempt stays), the run is incomplete', async () => {
  const run = await retried()
  const file = join(run.runDir, 'agent-history.json')
  const h = JSON.parse(readFileSync(file, 'utf8'))
  h.fingerprints['fp-a'] = h.fingerprints['fp-a'].filter(e => !(e.role === 'validator' && e.id === 'v01-t2'))
  assert.ok(h.fingerprints['fp-a'].some(e => e.role === 'validator' && e.id === 'v01'), 'the fixture: the discarded attempt is still a validator, so the "no Phase 3 verifier" check cannot be what fires')
  writeFileSync(file, JSON.stringify(h, null, 2))
  writeFindings(run.runDir)
  assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['incomplete', 'complete_check_failed'])
})
await test('the validate stage funds the verifiers a profile really spends: with two agents left quick validates both candidates (one verifier each); standard and deep fund one (it keeps one agent for the candidate\'s Phase 5) and end the run incomplete with upstream\'s reason', async () => {
  for (const [profile, funded, status, reason] of [['quick', 2, 'in_progress', null], ['standard', 1, 'incomplete', 'validation_budget_exhausted'], ['deep', 1, 'incomplete', 'validation_budget_exhausted']]) {
    const run = toValidate(DEFS, { args: ['--budget', '200'] })
    asProfile(run.runDir, profile, { agents_spent: 198, stage_spend: { earlier: 198 } })
    const res = await round(run.runDir, answer)
    assert.equal(res.input.candidates.length, funded, `${profile}: candidates funded with two agents left`)
    assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], [status, reason], profile)
  }
})
await test('the refusal when no candidate can be funded speaks of the verifiers the profile has: quick\'s says nothing of a Phase 5 verifier, standard\'s and deep\'s still say a Phase 5 verifier each', () => {
  for (const profile of ['quick', 'standard', 'deep']) {
    const run = toValidate(DEFS, { args: ['--budget', '200'] })
    asProfile(run.runDir, profile, { agents_spent: 200, stage_spend: { earlier: 200 } })
    const plan = stage(['plan', run.runDir])
    assert.equal(plan.status, 1, `${profile}: ${plan.stdout}`)
    assert.ok(/^AUDIT: FAIL validation_budget_exhausted: /.test(plan.last), `${profile}: upstream's reason`)
    if (profile === 'quick') assert.ok(!/Phase 5/.test(plan.last), 'quick: the refusal speaks of a Phase 5 verifier it does not have')
    else assert.ok(/with a Phase 5 verifier each/.test(plan.last), `${profile}: the refusal is as it was`)
  }
})
for (const profile of ['standard', 'deep']) {
  await test(`${profile}: Phase 5 is still its own pass: next after write-findings is verify, and a merged marker (which only quick's validate writes) does not satisfy complete-check`, async () => {
    const { runDir } = await validated(profile)
    writeFindings(runDir)
    assert.equal(next(runDir), 'NEXT: verify run=workflow')
    assert.equal(meta(runDir).run_status, 'in_progress')
    const file = join(runDir, 'decisions.json')
    const d = JSON.parse(readFileSync(file, 'utf8'))
    const a = d.entries.find(e => e.fingerprint === 'fp-a')
    a.phase5 = { state: 'merged', verifier_id: a.verifier_id }
    writeFileSync(file, JSON.stringify(d, null, 2))
    assert.ok(completeProblems(runDir).problems.some(p => /fp-a.*did not pass Phase 5/.test(p)), `${profile}: ${JSON.stringify(completeProblems(runDir).problems)}`)
  })
}
