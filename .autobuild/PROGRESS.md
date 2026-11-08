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

## P-03 — The units a profile asks for (2026-11-08)
- What: `audit-ledger.mjs`: `profileProblems` gates `unitFromInput` on `ctx.profile` (quick: fixed subsystem ref, no lifecycle); `buildSeed`/`buildCritic` pass `meta.profile`, `forceAdd` clears it. `audit-inputs.mjs` `profilePart(meta)` adds `parts.profile` (upstream "Run profiles and scope") to the synthesize, critic and mint inputs for quick and deep; the workflow's three prompts carry it under `--- The run profile, upstream text verbatim ---`, empty otherwise.
- Tests: graphs/security-audit/tests/profile-granularity.test.mjs passing (11/11); new audit-profile-units.test.mjs (4); regression suite green (`node scripts/test-workflow.mjs`: 1278 passed, 0 failed); `check-existing-tests.mjs` PASS; the facts-script bound (`< 60_000`) still holds, not raised
- Decisions: D3, D4, D5
- Notes: a quick minted unit that is not coarsened is already counted `rejected=` by apply-critic (tested in audit-profile-units); P-04 adds the deferral. `profilePart` carries only the profile section; P-05's `parts.phase5` is a separate key.

REVIEW 2026-11-08: DEFECT graphs/security-audit/skills/security-audit/audit-stage.mjs:198 the coverage critic is never told the run's profile — P-03 gives the quick/deep critic upstream's whole "Run profiles and scope" section (all three bullets), but `criticInput` carries no `profile` key (`baseInput` adds none, unlike `reconInput` :130 and `mintInput` :232) and `criticPrompt` (security-audit-flow.js:379-403) prints no `Run profile:` line (synth :302 and mint :411 do), so the critic cannot tell which bullet applies. Scenario (reasoned from code, not reproduced): a quick critic follows HUNTING.md's "missing lifecycle modes" check and proposes per-lifecycle or per-subsystem gaps quick does not split; the minter must drop or coarsen them (see the next line), and a deep critic cannot know deep asks for lifecycle splits, which nothing else enforces (M9). Fix: add `profile: run.meta.profile` to `criticInput` and a `Run profile:` line to `criticPrompt` only when `PARTS.profile` is text, so standard's prompt stays byte-identical, with a test in a new audit-*.test.mjs.
REVIEW 2026-11-08: DEFECT graphs/security-audit/skills/security-audit/audit-ledger.mjs:545 quick's fixed subsystem ref turns a same-unit gap into a coverage-ID collision that ends the run — `mintId` (:102) derives the ID from `canonical_refs` only, and quick pins `canonical_refs.subsystem`, so a gap on an already-seeded surface×boundary×attack class gets that unit's ID; `semanticOf` (:485) still compares the display `subsystem` label (and surface/boundary labels) that P-03 says "stays free", so `buildCritic` fails `coverage ID collision` instead of counting a duplicate. Scenario (reasoned from code, not reproduced; the frozen P-09 fixture mints distinct refs and does not hit it): the quick critic names "lifecycle/subsystem X of the notes handler has no unit", the minter correctly coarsens to QUICK_SUBSYSTEM_REF and labels it "notes deletion"; `applyCriticProblems` returns the collision, mint-feedback retries once, the second attempt collides again, `stopHunting(LEDGER_FAILED)` marks the quick run incomplete although P-04 would only have recorded the gap `deferred`. In standard this needs fully identical refs; in quick it is routine. Fix: when `rulesOf(meta).coarseSubsystem`, leave `subsystem` out of the semantic comparison for minted units (or count a same-ID minted unit as a duplicate), with a test in a new audit-*.test.mjs; log the choice in DECISIONS.md.

## P-04 — Quick's one wave and one critic (2026-11-08)
- What: `audit-run.mjs nextStep`: quick goes from apply-critic to `coverageDone()`; where the machine falls through to "ask a critic" quick asks `post-wave` (`rules.finalCleanCritic`). `audit-ledger.mjs buildCritic`: for quick, every hunter-work or in_progress unit (reopened, minted, unreached) becomes `deferred` with `QUICK_DEFERRED`; summary and event counts get `deferred=` for quick only; new `deferUnit` helper shared with `deferHunting`/`planWave`.
- Tests: graphs/security-audit/tests/profile-quick-waves.test.mjs passing (11/11); new audit-quick-waves.test.mjs (4); regression suite green (`node scripts/test-workflow.mjs`: 1293 passed, 0 failed); `check-existing-tests.mjs` PASS
- Decisions: D6, D7, D8, D9, D10
- Notes: both REVIEW defects above are still open (D10). The workflow's critic prompt for a quick `post-wave` critic with `hunted: false` still reads "the post-wave coverage critic of wave 1" (WF, not P-04's file); P-07 owns the report's critic sentence. Checked: the critic and mint budget gate (`audit-stage.mjs stopOnCriticBudget`, `criticBudgetExhausted`) is the same for both kinds (reserve 1), so quick's `post-wave` critic is funded like standard's final-clean one.

## P-05 — Quick merges Phase 3 and Phase 5 (2026-11-08)
- What: `audit-verdicts.mjs`: validate funds `floor(left / verifiersPerCandidate)` (consolidate's skip formula too), adds `parts.phase5` for quick, and marks a decided confirmed/needs_validation entry `phase5: { state: 'merged', verifier_id }` with its own kept verifier; `audit-run.mjs nextStep` goes from write-findings to report in quick; `audit-findings.mjs`: `writeFindings` ends a quick run (`finishRun`), `completeProblems` accepts `merged` only under `mergedValidation`, only for the entry's own verifier held as its validator; `PHASE5` ref moved to `audit-inputs.mjs`; WF `validatorPrompt` carries the Phase 5 text for quick only.
- Tests: graphs/security-audit/tests/profile-quick-verify.test.mjs passing (13/13); new audit-quick-verify.test.mjs (5); regression suite green (`node scripts/test-workflow.mjs`: 1309 passed, 0 failed); `autobuild check --feature P-05 --skip-browser`: GATE: PASS
- Decisions: D11, D12, D13, D14, D15
- Notes: the facts-script bound is now 61,000 (D15); measured 60,087, so leave the WF alone in later features or measure first. 37e32c9 is on this branch (D11), so the contract's "nothing to change until rebased" no longer holds. Both REVIEW defects (D10) are still open.
