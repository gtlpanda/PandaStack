// audit-profile.test.mjs - audit-profile.mjs is the one place the profile names and quick's reason string live: audit-run.mjs re-exports
// them by identity (not a copy that could drift), the budget gate's profile check still refuses a non-profile, and rulesOf reads a
// run-metadata.json as it is written to disk. The table itself is pinned by the acceptance test, profile-rules.test.mjs.
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { PROFILES, QUICK_DEFERRED, profileRules, rulesOf } from '../skills/security-audit/audit-profile.mjs'
import { KNOWN_PROFILES, REASONS, budgetGate, criticReserve } from '../skills/security-audit/audit-run.mjs'

await test('audit-run.mjs takes its profile list and quick\'s reason from audit-profile.mjs, the same values, not retyped copies', () => {
  assert.equal(KNOWN_PROFILES, PROFILES, 'the same frozen array')
  assert.equal(REASONS.quick, QUICK_DEFERRED)
  assert.ok(Object.isFrozen(REASONS), 'REASONS stays frozen')
})

await test('the budget code still refuses anything that is not exactly a profile name, now that its list is the frozen table\'s', () => {
  for (const bad of ['Quick', 'fast', '', null, undefined, ['quick']]) {
    assert.throws(() => criticReserve(bad), e => e instanceof TypeError && e.message === `unknown profile ${JSON.stringify(bad)}`, String(JSON.stringify(bad)))
  }
  assert.deepEqual(PROFILES.map(p => budgetGate(p, null).minimum), [8, 10, 10], 'quick 8, standard 10, deep 10, unchanged')
})

await test('rulesOf reads a whole run-metadata.json parsed from disk, and a row cannot be changed by the code that reads it', () => {
  const meta = JSON.parse(JSON.stringify({ schema_version: 1, profile: 'deep', budget: null, limits: { max_parallel: 8 }, incomplete_reason: null }))
  assert.equal(rulesOf(meta), profileRules('deep'))
  assert.equal(rulesOf({ ...meta, profile: 'standard ' }).profile, 'standard', 'a near miss reads as standard, never as another profile')
  assert.throws(() => { rulesOf(meta).hunterWaves = 1 }, TypeError, 'modules are strict: writing a frozen row throws')
  assert.equal(profileRules('deep').hunterWaves, null)
})
