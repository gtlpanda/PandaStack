// profile-rules.test.mjs - P-01: the one table of what each run profile does (audit-profile.mjs), read against the vendored upstream text it summarizes.
// Acceptance test of the PR 9 profile contract (retro.md, entry 43), section P-01.
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { PROFILES, QUICK_DEFERRED, QUICK_REF, lazy, vendored } from './profile-support.mjs'

console.log('== P-01: the profile rules')
const squash = text => text.replace(/\s+/g, ' ')
const bullet = (text, profile) => squash(text.split('\n').find(l => l.startsWith(`- **\`${profile}\`**`)) ?? '')

await test('audit-profile.mjs exports the three profiles in upstream\'s order, upstream\'s fixed quick subsystem reference and its deferral reason string', async () => {
  const m = await lazy('audit-profile.mjs')
  assert.deepEqual(m.PROFILES, PROFILES)
  assert.equal(m.QUICK_SUBSYSTEM_REF, QUICK_REF)
  assert.equal(m.QUICK_DEFERRED, QUICK_DEFERRED)
  assert.ok(Object.isFrozen(m.PROFILES), 'the list cannot be edited by an importer')
})
await test('profileRules(profile) is exactly this table, frozen, one row per profile', async () => {
  const { profileRules } = await lazy('audit-profile.mjs')
  const row = (profile, over) => ({ profile, coarseSubsystem: false, splitByLifecycle: false, hunterWaves: null, finalCleanCritic: true, mergedValidation: false, sameSourceSecondPass: false, partialPass: false, verifiersPerCandidate: 2, ...over })
  assert.deepEqual(profileRules('quick'), row('quick', { coarseSubsystem: true, hunterWaves: 1, finalCleanCritic: false, mergedValidation: true, partialPass: true, verifiersPerCandidate: 1 }))
  assert.deepEqual(profileRules('standard'), row('standard', {}))
  assert.deepEqual(profileRules('deep'), row('deep', { splitByLifecycle: true, sameSourceSecondPass: true }))
  for (const p of PROFILES) assert.ok(Object.isFrozen(profileRules(p)), `${p} is frozen`)
})
await test('profileRules refuses anything that is not exactly one of the three profile names: a TypeError naming the value, never a default and never another profile\'s row', async () => {
  const { profileRules } = await lazy('audit-profile.mjs')
  for (const bad of ['Quick', 'DEEP', ' deep', 'quick ', 'fast', '', '__proto__', 'constructor', 'toString', null, undefined, 0, 1, true, {}, [], ['quick'], { toString: () => 'quick' }]) {
    assert.throws(() => profileRules(bad), e => e instanceof TypeError && e.message === `unknown profile ${JSON.stringify(bad)}`, `${String(JSON.stringify(bad))} is not a profile: a TypeError whose message is "unknown profile " and the value as JSON`)
  }
})
await test('the table agrees with the budget code that already exists: critic reserve, verifier cost per candidate, and the profiles init knows', async () => {
  const { profileRules, PROFILES: list } = await lazy('audit-profile.mjs')
  const run = await lazy('audit-run.mjs')
  assert.deepEqual(run.KNOWN_PROFILES, list, 'audit-run.mjs and audit-profile.mjs name the same profiles in the same order')
  for (const p of list) {
    const rules = profileRules(p)
    assert.equal(run.criticReserve(p), rules.finalCleanCritic ? 2 : 1, `${p}: a post-wave critic plus a distinct final-clean one, or the one`)
    assert.equal(run.validationReserve(p, 100, 5), 5 * rules.verifiersPerCandidate, `${p}: verifier calls per expected candidate`)
  }
  assert.equal(run.REASONS.quick, (await lazy('audit-profile.mjs')).QUICK_DEFERRED, 'the reason the ledger code uses is the one the table names')
})
await test('every rule is upstream\'s: the vendored text says what the table says, so a pin that moves fails here', async () => {
  const { profileRules, QUICK_SUBSYSTEM_REF, QUICK_DEFERRED: reason } = await lazy('audit-profile.mjs')
  const skill = vendored('SKILL.md'), recon = vendored('RECONNAISSANCE.md'), hunting = vendored('HUNTING.md'), validation = vendored('VALIDATION-AND-REPORTING.md')
  const quick = bullet(skill, 'quick'), deep = bullet(skill, 'deep'), standard = bullet(skill, 'standard')
  assert.ok(quick && deep && standard, 'the three bullets of "Run profiles and scope" are there')
  // quick
  assert.ok(profileRules('quick').hunterWaves === 1 && quick.includes('exactly one hunter wave followed by exactly one final coverage-critic pass'))
  assert.ok(profileRules('quick').coarseSubsystem && quick.includes('surface × boundary × attack class') && quick.includes(QUICK_SUBSYSTEM_REF) && recon.includes(`Use the fixed canonical value \`${QUICK_SUBSYSTEM_REF}\``))
  assert.ok(profileRules('quick').mergedValidation && quick.includes('one fresh verifier per candidate for both candidate validation and final record verification') && validation.includes('In a `quick` run, Phase 3 and Phase 5 merge'))
  assert.ok(profileRules('quick').finalCleanCritic === false && skill.includes('one final post-wave critic for `quick`'))
  assert.ok(hunting.includes(`mark it \`deferred\` with reason \`${reason}\``) && quick.includes('record the critic\'s accepted discoveries and reassignments as `deferred`'))
  assert.ok(profileRules('quick').partialPass && skill.includes('A scoped or `quick` run must present itself as partial coverage.'))
  // standard
  assert.equal(standard, '- **`standard`** — the workflow as written.')
  assert.ok(profileRules('standard').finalCleanCritic && skill.includes('one post-wave plus one distinct final-clean critic for `standard`/`deep`'))
  // deep
  assert.ok(profileRules('deep').splitByLifecycle && deep.includes('Split ledger units per subsystem and lifecycle mode') && recon.includes('`deep` adds lifecycle modes'))
  assert.ok(deep.includes('run critic waves to a clean pass') && profileRules('deep').finalCleanCritic && profileRules('deep').hunterWaves === null)
  assert.ok(!profileRules('deep').mergedValidation && deep.includes('keep candidate validation and final record verification as separate fresh agents'))
  assert.ok(profileRules('deep').sameSourceSecondPass && deep.includes('give `prior_covered_same_source` units an independent second pass'))
  assert.ok(!profileRules('standard').sameSourceSecondPass && !profileRules('quick').sameSourceSecondPass)
})
await test('rulesOf(meta) is the tolerant reader the stage machine uses: the run\'s profile when it is one of the three, standard for a run that names none or names something else (existing fixtures have no profile)', async () => {
  const { profileRules, rulesOf } = await lazy('audit-profile.mjs')
  for (const p of PROFILES) assert.deepEqual(rulesOf({ profile: p }), profileRules(p), p)
  for (const meta of [{}, { profile: undefined }, { profile: 'fast' }, { profile: 'Quick' }, { profile: null }, { profile: 5 }, null, undefined, 'quick', []]) assert.deepEqual(rulesOf(meta), profileRules('standard'), JSON.stringify(meta))
})
