// profile-support.mjs - shared by the profile acceptance tests (profile-*.test.mjs) of the quick and deep profiles. Not a test file.
// The tests of a feature load modules and exports that feature has yet to add, lazily (lazy()), so a test fails on the
// missing behavior and not on an import. Everything else is built from the fixtures the existing tests share.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolve as resolveBlock } from '../skills/security-audit/blocks.mjs'
import { VENDOR_SKILL_DIR } from '../skills/security-audit/upstream.mjs'
import { advanceState } from '../skills/security-audit/audit-run.mjs'
import { mergeWave, planWave } from '../skills/security-audit/audit-ledger.mjs'
import { assignments, coverAll, refsOf, seeded, unitInput } from './ledger-fixtures.mjs'

// Upstream's fixed canonical value for the quick profile's subsystem dimension (RECONNAISSANCE.md, "Deterministic coverage ledger").
export const QUICK_REF = 'profile/quick/all-in-scope-subsystems'
export const QUICK_DEFERRED = 'quick_profile_final_critic'
// The reassignment_reason of a deep run's second pass over a unit an earlier run covered on unchanged source (contract P-06).
export const SECOND_PASS_REASON = 'the deep profile gives a unit an earlier run covered on unchanged source (prior_covered_same_source) an independent second pass'
export const PROFILES = ['quick', 'standard', 'deep']

// A module of the skill directory, imported when called: a feature that has yet to add it fails the test that needs it, with the import error.
export const lazy = name => import(new URL(`../skills/security-audit/${name}`, import.meta.url).href)
export const vendored = file => readFileSync(join(VENDOR_SKILL_DIR, file), 'utf8')
// The vendored upstream section every profile rule is read from (SKILL.md, "Run profiles and scope"), exactly as blocks.mjs slices it.
export const profilesBlock = () => resolveBlock('SKILL.md#Run profiles and scope').text
export const phase5Block = () => resolveBlock('VALIDATION-AND-REPORTING.md#Phase 5: Verify the final records with fresh eyes').text

// A run made under the default profile, then recorded as `profile` (and with `extra` metadata): what the helpers read is run-metadata.json, so a test of a
// later feature does not depend on `init --profile` accepting it. (The end-to-end tests do go through init.)
export function asProfile(runDir, profile, extra = {}) {
  const file = join(runDir, 'run-metadata.json')
  writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), profile, ...extra }, null, 2)}\n`)
}

// A recon unit in the quick profile's shape: the fixed subsystem reference, no lifecycle.
export const quickUnit = (name, over = {}) => unitInput(name, { canonical_refs: refsOf(name, { subsystem: QUICK_REF }), subsystem: 'All in-scope subsystems', ...over })
// A recon unit that carries a lifecycle mode (the deep profile's extra dimension).
export const lifecycleUnit = (name, lifecycle, over = {}) => unitInput(name, { canonical_refs: refsOf(name, { lifecycle }), lifecycle, ...over })

export const critic = (over = {}) => ({ missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: false, ...over })
export const gap = (surface, over = {}) => ({ surface, boundary: 'b', subsystem: 's', attack_class: 'a', starting_paths: ['src/db.js'], reason: 'a parallel path nobody owns', ...over })

// Seeded (as the default profile; seed's own gates are tested with the profile set first), recorded as `profile`, planned, hunted and merged, with the critic
// result saved and the minter passed: apply-critic is next. `results(assignedByHunter)` is what the hunters returned (every unit covered by default).
export function afterWave(units, { profile, results = coverAll, kind = 'post-wave', opts, extra } = {}) {
  const run = seeded(units, opts)
  asProfile(run.runDir, profile, extra)
  planWave(run.runDir)
  advanceState(run.runDir, 'hunt')
  mergeWave(run.runDir, results(assignments(run.runDir), run.runDir))
  advanceState(run.runDir, 'critic', { critic_kind: kind })
  advanceState(run.runDir, 'mint')
  return run
}
export const nameOf = u => u.canonical_refs.surface.split('#')[1]
export const byName = ledger => Object.fromEntries(ledger.map(u => [nameOf(u), u]))
