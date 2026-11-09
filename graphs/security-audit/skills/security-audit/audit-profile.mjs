// audit-profile.mjs - what each run profile does, in one table every stage of the security-audit workflow reads (upstream SKILL.md,
// "Run profiles and scope"; tests/profile-rules.test.mjs reads each rule back out of the vendored text). Pure, no I/O, and it imports
// nothing from this directory, so audit-run.mjs, audit-ledger.mjs, audit-stage.mjs, audit-verdicts.mjs, audit-findings.mjs and
// audit-report.mjs can all import it without a cycle.

// Upstream's three profiles, in upstream's order.
export const PROFILES = Object.freeze(['quick', 'standard', 'deep'])
// The fixed canonical value of a quick unit's subsystem dimension (RECONNAISSANCE.md, "Deterministic coverage ledger").
export const QUICK_SUBSYSTEM_REF = 'profile/quick/all-in-scope-subsystems'
// The reason a quick run defers what its one critic found or reopened (HUNTING.md, "Coverage-critic waves").
export const QUICK_DEFERRED = 'quick_profile_final_critic'

// One frozen row per profile. Keys:
//   coarseSubsystem       every unit's canonical_refs.subsystem is QUICK_SUBSYSTEM_REF
//   splitByLifecycle      recon splits units per subsystem and lifecycle mode (no code gate: the prompts and the report carry it)
//   hunterWaves           1 for exactly one wave; null for as many as coverage needs
//   finalCleanCritic      the distinct final-clean critic exists
//   mergedValidation      Phase 3 and Phase 5 are one pass
//   sameSourceSecondPass  an independent second pass over prior_covered_same_source units
//   partialPass           the profile alone makes the report a partial pass
//   verifiersPerCandidate verifier calls budgeted per expected candidate
const STANDARD = { profile: 'standard', coarseSubsystem: false, splitByLifecycle: false, hunterWaves: null, finalCleanCritic: true, mergedValidation: false, sameSourceSecondPass: false, partialPass: false, verifiersPerCandidate: 2 }
const RULES = Object.freeze({
  quick: Object.freeze({ ...STANDARD, profile: 'quick', coarseSubsystem: true, hunterWaves: 1, finalCleanCritic: false, mergedValidation: true, partialPass: true, verifiersPerCandidate: 1 }),
  standard: Object.freeze({ ...STANDARD }),
  deep: Object.freeze({ ...STANDARD, profile: 'deep', splitByLifecycle: true, sameSourceSecondPass: true }),
})

// Exactly a profile name: a string in PROFILES (not a key RULES inherits, not something that merely prints as a name).
const isProfile = value => typeof value === 'string' && PROFILES.includes(value)

// The rules of `profile`. Anything that is not exactly a profile name is a TypeError naming the value: never a default, never another row.
export function profileRules(profile) {
  if (!isProfile(profile)) throw new TypeError(`unknown profile ${JSON.stringify(profile)}`)
  return RULES[profile]
}

// The rules of a run, from its run-metadata.json: its profile when that is a profile name, else standard (a meta with no profile, an unknown
// one, null or undefined; existing callers and fixtures pass a meta with no profile). Never throws.
export function rulesOf(meta) {
  const profile = typeof meta === 'object' && meta !== null ? meta.profile : undefined
  return isProfile(profile) ? RULES[profile] : RULES.standard
}
