// audit-quick-verify.test.mjs - the edges of quick's merged Phase 3 and Phase 5 that the acceptance test (profile-quick-verify.test.mjs) does not reach: the grouping stage
// funds validation at the profile's verifiers per candidate, a run with no profile is standard (a merged marker never passes it), the verifier is told which object to return,
// and write-findings says why the run ended.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { completeProblems, writeFindings } from '../skills/security-audit/audit-findings.mjs'
import { recordSpend } from '../skills/security-audit/audit-run.mjs'
import { meta } from './audit-fixtures.mjs'
import { atValidation, decisions, next, rejected, round, toValidate, verified } from './verdict-fixtures.mjs'
import { stage } from './stage-fixtures.mjs'
import { asProfile } from './profile-support.mjs'

const DEFS = [{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }]
const answer = (label, c) => (c.fingerprint === 'fp-b' ? rejected('fp-b') : verified(c.fingerprint))

await test('the grouping stage keeps its agent only when validation would still fund as many candidates: with 4 left quick (one verifier each) groups, standard and deep (two each) skip', () => {
  for (const [profile, grouped] of [['quick', true], ['standard', false], ['deep', false]]) {
    const run = atValidation(DEFS, { args: ['--budget', '40'] })
    asProfile(run.runDir, profile)
    recordSpend(run.runDir, 'earlier', 36)
    const plan = stage(['plan', run.runDir])
    if (grouped) assert.match(plan.last, /^AUDIT: OK plan consolidate /, `${profile}: ${plan.stdout}`)
    else assert.match(plan.last, /consolidation skipped: 4 agent\(s\) left of the budget: the grouping's agent would leave validation able to fund fewer candidates/, `${profile}: ${plan.stdout}`)
  }
})
await test('quick still skips the grouping when its agent would cost a candidate its verifier: two candidates and 2 agents left', () => {
  const run = atValidation(DEFS, { args: ['--budget', '40'] })
  asProfile(run.runDir, 'quick')
  recordSpend(run.runDir, 'earlier', 38)
  assert.match(stage(['plan', run.runDir]).last, /consolidation skipped: 2 agent\(s\) left of the budget: the grouping's agent would leave validation able to fund fewer candidates/)
})

await test('quick: the merged section sits after the schema branches and before the closing instruction, and tells the verifier to return the Phase 3 object, not Phase 5\'s', async () => {
  const run = toValidate(DEFS)
  asProfile(run.runDir, 'quick')
  const { prompts } = await round(run.runDir, answer)
  for (const [label, prompt] of Object.entries(prompts)) {
    const at = s => prompt.lastIndexOf(s)   // the upstream text quoted earlier in the prompt may use the same words
    assert.ok(at('The rejected branch:') < at('## Phase 5 record checks, merged into this pass') && at('## Phase 5 record checks, merged into this pass') < at('Return exactly one JSON object'), label)
    assert.match(prompt, /return the object named at the end, not a verified or replace object/, label)
  }
})

await test('quick: write-findings says the run ended at the merged pass, and records only the decided needs_validation entry as merged', async () => {
  const run = toValidate(DEFS)
  asProfile(run.runDir, 'quick')
  assert.equal((await round(run.runDir, answer)).apply.status, 0)
  const out = writeFindings(run.runDir)
  assert.equal(out.notes.length, 1)
  assert.match(out.notes[0], /^the quick profile's merged pass: each record's Phase 3 verifier made the Phase 5 record checks too, so no verify stage runs; every candidate has an independent final disposition/)
  assert.deepEqual(decisions(run.runDir).entries.map(e => [e.fingerprint, e.phase5?.state ?? null]), [['fp-a', 'merged'], ['fp-b', null]])
})

await test('a run whose metadata names no profile is standard: validation keeps a Phase 5 verifier, write-findings goes on to verify, and a merged marker does not pass complete-check', async () => {
  const run = toValidate(DEFS)
  asProfile(run.runDir, undefined)   // JSON drops the key: a run-metadata.json with no profile at all
  assert.ok(!('profile' in meta(run.runDir)))
  const { input, apply } = await round(run.runDir, answer)
  assert.equal(apply.status, 0, apply.stdout)
  assert.ok(!('phase5' in input.parts))
  assert.equal(decisions(run.runDir).entries.find(e => e.fingerprint === 'fp-a').phase5, null)
  writeFindings(run.runDir)
  assert.equal(next(run.runDir), 'NEXT: verify run=workflow')
  const file = join(run.runDir, 'decisions.json')
  const d = JSON.parse(readFileSync(file, 'utf8'))
  const a = d.entries.find(e => e.fingerprint === 'fp-a')
  a.phase5 = { state: 'merged', verifier_id: a.verifier_id }
  writeFileSync(file, JSON.stringify(d, null, 2))
  assert.ok(completeProblems(run.runDir).problems.includes('record "fp-a" did not pass Phase 5'))
})
