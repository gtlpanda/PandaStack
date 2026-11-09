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
- Notes: the facts-script bound is now 61,000 (D15); measured 60,087, so leave the WF alone in later features or measure first. 37e32c9 is on this branch (D11), so the contract's "nothing to change until rebased" no longer holds. For P-09 (untested hypothesis, worked out by hand): with quick's consolidate formula, `--budget 12` skips the grouping at 4 left and then funds all 4 verifiers, so it may end `complete`, not `incomplete` as the contract says; the frozen test (line 89) accepts either. Both REVIEW defects (D10) are still open.

## P-06 — Deep's second pass (2026-11-08)
- What: `audit-ledger.mjs buildCritic`: for a profile with `sameSourceSecondPass` (deep), after the critic's own work every `prior_covered_same_source` unit that is `covered` with no `attempts` is archived by `reassign()` with the exported `SECOND_PASS_REASON` and planned at wave + 1 for a fresh owner; `tally.second_pass` (deep only) ends the summary and reaches the event counts; `applyCritic`'s optional summary suffixes go through one `profileCount` helper.
- Tests: graphs/security-audit/tests/profile-deep.test.mjs passing (8/8); new audit-deep-second-pass.test.mjs (5); regression suite green (`node scripts/test-workflow.mjs`: 1327 passed, 0 failed); `check-existing-tests.mjs` PASS
- Decisions: D16, D17, D18
- Notes: no `nextStep` or WF change (the deep-equals-standard test passed unchanged; the facts-script bound is untouched). No fixture gives a `prior_covered_same_source` unit `prior_leads` (the one checked, a same-source rejected record, leaves none: audit-ledger-carry.test.mjs:56), so "resolved and passed again in one application" is not tested; the sweep runs after the resolution so it should compose (untested hypothesis). Both REVIEW defects (D10) are still open.

REVIEW 2026-11-08: PROPOSED-FEATURE decide what deep's second pass does when the budget cannot fund it — `buildCritic` (audit-ledger.mjs:232-236) reopens every covered `prior_covered_same_source` unit at the first critic application whatever the budget, so under a strict budget `planWave` (audit-ledger.mjs:326-328) can find `waveAllowance` gives 0 hunters and defer the reopened unit with `budget_cannot_reserve_critics_and_validation`. The unit this run covered then ends live `deferred`, with its own covered pass only in `attempts`, so the report lists it as deferred coverage where standard with the same budget lists it covered. Scenario (reasoned from code, not reproduced; ad-hoc scripts were not permitted): deep `--budget 12`, an earlier run covered `keep` on unchanged source; recon+synth spend 5, wave 1 covers `keep` with one hunter, the critic spends 1, no mint; at 5 left `waveAllowance('deep', 5)` keeps 2 critics, 2 minters and 1 validation, so 0 hunters, and `keep` is deferred. No state is stuck and nothing is marked complete without a check, so this is not a defect. But neither the contract (P-06) nor DECISIONS.md (D16-D18 cover the reason, the sweep timing and the tally) decides it. Options: give the second pass only when the budget is unset or the next wave can fund a hunter (and say so in a note), or keep today's behavior and record it as a decision, with a test either way.

## P-07 — What the report says about the profile (2026-11-08)
- What: `audit-report.mjs` reads the profile only through `rulesOf`: a `Profile rules:` line right after `- Run` for quick and deep; the complete-status sentence names quick's merged Phase 3 and Phase 5 (`mergedValidation`); the profile partial-pass reason only on `partialPass`; quick's one critic is final by design (`criticCaveat`, keyed on `finalCleanCritic`); a count of units deferred exactly as `QUICK_DEFERRED` after the gap list; `WHY` keys that reason by the constant.
- Tests: graphs/security-audit/tests/profile-report.test.mjs passing (7/7); new audit-report-profile.test.mjs (5); regression suite green (`node scripts/test-workflow.mjs`: 1347 passed, 0 failed, goldens unchanged); `check-existing-tests.mjs` PASS
- Decisions: D19, D20, D21
- Notes: a meta with no profile or an unknown one is no longer a partial pass of its own (D20). A quick run stopped by `critic_budget_exhausted` still reads "the final-clean critic did not run" (D19, left open). No WF change; the facts-script bound is untouched. The REVIEW items above (D10's two defects, the P-06 budget proposal) are still open.

## P-08 — The docs (2026-11-08)
- What: `SKILL.md`: usage `[--profile quick|standard|deep]`; a `--profile` bullet in section 2 lists the three profiles with their rules, the evidence-bar sentence and `init`'s smallest budget each (8, 10, 10); the not-supported bullet and the closing rule no longer name profiles; the init note says quick has one verifier; section 6 says a `quick` run is a partial pass and to name what it deferred. Graph `README.md`: status paragraph says quick and deep run and the sandbox is the later change; a new `## Profiles` section with the same list; topology and roles rows say what quick does instead. `audit-run.mjs` text needed nothing (P-02 had done it). `audit-readme.test.mjs` drops `other than \`standard\`` (SPEC §7).
- Tests: graphs/security-audit/tests/profile-docs.test.mjs passing (5/5); new audit-docs-profiles.test.mjs (4); regression suite green (`node scripts/test-workflow.mjs`: 1351 passed, 0 failed); `check-existing-tests.mjs` PASS; `scripts/validate.sh` PASS
- Decisions: D22, D23, D24, D25
- Notes: no code change; the facts-script bound is untouched. The README Cost bullet and the skill's "smallest `init` accepts, 10" sentence are standard's (pinned); the profile lists carry quick's 8. The REVIEW items above (D10's two defects, the P-06 budget proposal) are still open.

## P-09 — End to end, quick (2026-11-08)
- What: no source change (contract: fixtures frozen; P-02 to P-05 and P-07 make it pass). The frozen e2e passed at session start. One new test file pins the strict-budget outcomes the frozen test leaves open: quick at `--budget 12` and `11`.
- Tests: graphs/security-audit/tests/profile-e2e-quick.test.mjs passing (9/9); new audit-e2e-quick-budget.test.mjs (2); regression suite green (`node scripts/test-workflow.mjs`: 1358 passed, 0 failed)
- Decisions: D26
- Notes: P-05's untested hypothesis about `--budget 12` is now measured: 12 ends `complete` with 12 agents (grouping skipped, four verifiers), not `incomplete` as features.json and the contract's note say; 11 is the first `incomplete` (`validation_budget_exhausted`, three of four funded). The frozen test accepts either outcome (D26). The REVIEW items above (D10's two defects, the P-06 budget proposal) are still open.

REVIEW 2026-11-09: PROPOSED-FEATURE make the report's `Profile rules` line say what the run did, not what the profile would do — `runSection` (audit-report.mjs:216) prints `PROFILE_RULES_LINE[rules.profile]` for every quick and deep run whatever happened, and the strings are past tense: "quick ran one hunter wave and one final critic pass", "deep ... ran critic waves to a clean pass, ... and gave units an earlier run covered on unchanged source an independent second pass". Scenarios (reasoned from code, not reproduced): (a) quick at `--budget 8`, the smallest `init` accepts, funds no hunter (SPEC §2), but the report still says it "ran one hunter wave"; (b) a deep run stopped with `critic_budget_exhausted` says "ran critic waves to a clean pass" two sections above `### Final critic`, which says "The final-clean critic did not run ... No clean-coverage claim is made", the clean-coverage claim upstream forbids then (SKILL.md:132, VALIDATION-AND-REPORTING.md:159); (c) a first deep run with no earlier run, or one where the second pass was deferred for budget (the open P-06 proposal), says it "gave ... an independent second pass" to units that do not exist or were never hunted again. Not a defect: P-07's contract and its frozen test pin the line exactly, and only for complete runs (profile-report.test.mjs:17-18; the incomplete deep case at :49 checks only the partial-pass reason). Options: word the line as the profile's rules ("the quick profile runs ..."), which needs the contract and frozen test changed by the owner; or keep the pinned line for complete runs and, for an incomplete run, drop the claims that did not hold (the clean pass, the wave, the second pass). Add a test in a new audit-*.test.mjs and log the choice in DECISIONS.md either way.

## P-10 — End to end, deep (2026-11-08)
- What: no source change (contract: none; P-02, P-03, P-06 and P-07 make it pass). The frozen e2e passed at session start. One new test file drives a standard audit beside the deep one with the same scripted agents, twice each.
- Tests: graphs/security-audit/tests/profile-e2e-deep.test.mjs passing (9/9); new audit-e2e-deep-vs-standard.test.mjs (4); regression suite green (`node scripts/test-workflow.mjs`: 1371 passed, 0 failed)
- Decisions: D27
- Notes: measured, not inferred: a first deep audit equals a standard one (path, 22 agents, ledger, verdicts). A second audit of the same commit costs deep 22 agents to standard's 19: the second pass adds `h2-01`, `h2-02` and a post-wave critic `c2`. Nothing else differs. This was the last feature. The REVIEW items above are still open: D10's two defects, the P-06 budget proposal and the P-07 rules-line proposal.
