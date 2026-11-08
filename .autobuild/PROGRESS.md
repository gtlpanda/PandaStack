# PROGRESS.md: autonomous build log

One entry per completed feature, newest last. The loop reads this file, so keep the formats exact.

**A completed feature** (appended in the same commit as `feat(<ID>): …`):

```
## <ID> — <title> (YYYY-MM-DD)
- What: <one or two lines>
- Tests: <feature test file> passing; regression suite green
- Decisions: <decision ids added, or "none">
- Notes: <anything the next session must know, or "none">
```

**A blocker** (one line):

```
BLOCKER <ID>: <why the frozen test or contract cannot be satisfied, with the exact failing assertion>
```

**A review finding** (written by the review session every few features):

```
REVIEW <YYYY-MM-DD>: PROPOSED-FEATURE <title> — <why>
REVIEW <YYYY-MM-DD>: DEFECT <file:line> <title> — <failure scenario; suggested fix>
```

---

<!-- Entries start below. -->

## P-01 — The profile rules table (2026-11-08)
- What: new `audit-profile.mjs` (PROFILES, QUICK_SUBSYSTEM_REF, QUICK_DEFERRED, frozen `profileRules`, tolerant `rulesOf`); `audit-run.mjs` takes `KNOWN_PROFILES` (same array) and `REASONS.quick` from it.
- Tests: graphs/security-audit/tests/profile-rules.test.mjs passing (6/6); new audit-profile.test.mjs (3); regression suite green (`node scripts/test-workflow.mjs`: 1254 passed, 0 failed)
- Decisions: none
- Notes: `audit-report.mjs` WHY still has the literal key `quick_profile_final_critic`; P-07 can key it `[QUICK_DEFERRED]` when it imports audit-profile.mjs. `criticReserve`/`validationReserve` untouched, as the contract asks.

## P-02 — init takes quick and deep (2026-11-08)
- What: `audit-run.mjs`: `SUPPORTED_PROFILES = KNOWN_PROFILES`; the "not available yet" refusal is gone (a neutral guard for direct `init()` callers stays); usage and header say `[--profile quick|standard|deep]`; the what-runs note reads `rulesOf(metadata).verifiersPerCandidate`. Existing tests edited per SPEC §7 (audit-run-init, audit-run-state).
- Tests: graphs/security-audit/tests/profile-init.test.mjs passing (11/11); new audit-init-profiles.test.mjs (3); regression suite green (`node scripts/test-workflow.mjs`: 1263 passed, 0 failed); `check-existing-tests.mjs` PASS
- Decisions: D1, D2
- Notes: SKILL.md and graph README still say init refuses quick/deep (D2): P-08 fixes them and drops `other than \`standard\`` from audit-readme.test.mjs. `budgetGate`/refusal text needed no change (already per profile).
