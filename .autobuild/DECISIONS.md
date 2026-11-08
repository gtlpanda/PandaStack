# DECISIONS: the decision log of the PR 9 (profiles) build

One line per decision, `D<n> — what — why`, appended by whoever makes it (setup, then loop sessions). `O` rows are the owner's binding decisions; `S` rows are setup decisions; `D` rows are the loop's.
Index first, then the entries. Keep this file's formats exact: it is read by people.

| id | decision | feature |
|---|---|---|
| O1 | Scope is PR 9 only: no sandbox, no `confirmed` (plan D1 A stays, source-only) | all |
| O2 | The audit's agents stay sonnet / effort high (plan D9) | all |
| O3 | Total spend cap `limits.totalBudgetUsd: 200`; per-session caps are the tool's defaults | harness |
| O4 | Harness files are temporary (`autobuild.json` and `.autobuild/`, plus one patched script); the owner removes them in a final commit | harness |
| S1 | Frozen acceptance tests live at `graphs/security-audit/tests/profile-*.test.mjs` as asked, and `scripts/test-workflow.mjs` skips the file of a feature not built yet, so `scripts/test.sh` is a usable gate | harness |
| S2 | Quick's one critic is kind `post-wave`, wave 1, ID `c1`; no new `critic_kind` value | P-04 |
| S3 | Quick defers every untouched unit with `quick_profile_final_critic` (a reading of the early-stop rule) | P-04 |
| S4 | Deep adds nothing to standard's critic loop or verification passes (upstream gives them to both); deep adds lifecycle units and the second pass | P-06 |
| S5 | The second pass is an archive-and-replan of `prior_covered_same_source` units, once, at the first critic application (an untested reading of one upstream clause) | P-06 |
| S6 | Quick's merged Phase 3+5 is marked `phase5: { state: 'merged', verifier_id }`, accepted by `complete-check` only in quick and only for the entry's own Phase 3 verifier | P-05 |
| S7 | Seed and mint refuse (not rewrite) a quick unit whose subsystem reference is not the fixed one; an earlier run's units are exempt | P-03 |
| S8 | `parts.profile` is upstream's "Run profiles and scope" section verbatim, only for quick and deep; standard's stage inputs and prompts are unchanged | P-03 |
| S9 | Only quick is a partial pass because of its profile (upstream `SKILL.md:115`); the report's existing sentence for it is kept | P-07 |
| S10 | Existing tests may only grow, except four files named in the spec; enforced by a gate step | harness |
| S11 | Quick funds validation at one agent per candidate (`validateInput` assumed a Phase 5 verifier each) | P-05 |
| S12 | Quick falls through to its one `post-wave` critic wherever standard asks `final-clean` | P-04 |
| S13 | The deep report line says deep "asked for" units split by lifecycle mode (nothing checks that recon produced any) | P-07 |
| D1 | `init()` keeps a profile guard for direct callers, worded `profile must be one of quick, standard, deep, not <JSON>` | P-02 |
| D2 | P-02 leaves SKILL.md and the graph README untouched; their "init refuses quick/deep" sentences are P-08's | P-02 |
| D3 | `forceAdd` exempts an earlier run's unit by passing `profile: undefined` in its `ctx` (the gate reads `rulesOf({ profile })`) | P-03 |
| D4 | The profile text sits right before the first method section of each prompt, inside "upstream text verbatim" | P-03 |
| D5 | `profilePart(meta)` lives in `audit-inputs.mjs`, the module every stage input is built from | P-03 |
| D6 | Quick's deferral is one sweep at the end of `buildCritic` over `isHunterWork(u) \|\| in_progress`, after the critic's own work | P-04 |
| D7 | `deferred` joins apply-critic's tally (so the summary and the event counts) for quick only | P-04 |
| D8 | `deferUnit(u, reason)` replaces the three copies of the deferred-unit literal (deferHunting, planWave, quick) | P-04 |
| D9 | `nextStep`'s quick exit after apply-critic sits after the `in_progress → hunt` check; that state is unreachable in quick and not pinned | P-04 |
| D10 | The two REVIEW defects of 2026-11-08 (critic input lacks `profile`; quick same-ID mint collision) stay open: not in P-04's contract | P-04 |
| D11 | `consolidateInput`'s funding formula divides by `verifiersPerCandidate`; the `left < 2` guard stays for every profile | P-05 |
| D12 | The merged Phase 5 text is an unnumbered section after the schema branches, and tells the verifier to return the Phase 3 object | P-05 |
| D13 | Quick's validate refusal says `with one verifier each, which is also its final record check` | P-05 |
| D14 | `writeFindings` calls `finishRun` once: the quick branch is an `else if` after the no-Phase-5 branch | P-05 |
| D15 | The facts-script bound in `audit-stage.test.mjs` is raised from 60,000 to 61,000 (measured 60,087) | P-05 |
| D16 | `SECOND_PASS_REASON` is exported from `audit-ledger.mjs`, next to `reassign()`, not from `audit-profile.mjs` | P-06 |
| D17 | The second pass is one sweep over the post-critic `next` ledger (status/attempts test), not a check against `patched` | P-06 |
| D18 | `tally.second_pass` is set only for deep; the summary suffix and event counts key on it, like quick's `deferred` | P-06 |

## Entries

- **O1** Scope is PR 9 only — the owner's decision at setup; the plan's D1 A (source-only, `confirmed` unreachable) stands.
- **O2** The agents stay sonnet / high — plan D9, unchanged.
- **O3** `limits.totalBudgetUsd: 200` — the owner's cap for the run; builder, review and bug-hunt sessions keep the tool's per-session defaults (the `autobuild` on PATH is the main checkout's, whose defaults are $50, $25 and $100).
- **O4** Harness files are temporary — `autobuild.json` (repo root, where the tool looks) and `.autobuild/` hold everything; `scripts/test-workflow.mjs` carries a marked patch; a final commit removes all three.
- **S1** The acceptance tests keep the location and `profile-*.test.mjs` names the owner asked for. `scripts/test-workflow.mjs` collects every `graphs/*/tests/*.test.mjs`, so ten failing files would make `scripts/test.sh` fail on every Stop attempt; the patch skips a file while its feature's `passes` is not `true` (read from `.autobuild/features.json`), and does nothing once that file is gone.
- **S2** Quick's critic is `post-wave`, wave 1 — upstream calls it the final post-wave critic (`SKILL.md:128`); no enum change.
- **S3** Quick defers units no critic mentioned with the same string — `HUNTING.md:247,249`: quick is a pre-declared early stop; no planned unit may survive it.
- **S4** Deep = standard + lifecycle units + second pass — `HUNTING.md:247` and `VALIDATION-AND-REPORTING.md:124` give the loop and the two passes to both.
- **S5** Second pass by archive-and-replan — upstream's own reopening mechanism (`attempts`, wave + 1, fresh owner); one clause of upstream, so a hypothesis.
- **S6** `merged` marker — upstream has no verification-state record; narrow by construction (profile and verifier identity both checked).
- **S7** Refuse, not rewrite — keeps "fail on duplicate ID" and "never silently merge" (`RECONNAISSANCE.md:102`) intact; the synthesizer is told once, like any seed problem.
- **S8** Verbatim section — the graph's rule is upstream text verbatim in prompts; standard stays byte-identical.
- **S9** Quick only — `SKILL.md:115`; `audit-report.mjs:140` treated every non-standard profile as partial.
- **S10** Existing tests grow-only — a loop session must not weaken a test about standard behavior to get a new profile through; the exceptions are the tests that assert the refusal this build removes and one that pins a script size.
- **S11** One agent per quick candidate — measured: quick budgets 13, 14 and 16 ended `incomplete` after 11 or 12 agents although the run spends 13, because `validateInput` kept an agent per candidate for a Phase 5 verifier quick does not have.
- **S12** `post-wave`, never `final-clean`, in quick — the rule key `finalCleanCritic: false`; the report sentence about quick's critic keys on it.
- **S13** "asked for" — the profile directs recon (prompt text) and code accepts lifecycle units; no code can require a target to have lifecycle modes.
- **D1** Guard kept in `init()` — the contract deletes the "not available yet" refusal and the CLI parser already stops unknown names (exit 2), but `init()` is exported; without a guard a direct caller with a bad profile would claim a run directory, then throw a TypeError from `criticReserve` and delete it. Refusing first keeps "a refusal creates nothing"; the new wording matches `check`'s and no longer says "not available yet" (tested in `audit-init-profiles.test.mjs`).
- **D2** Docs wait for P-08 — one feature per session, and `features.json` gives the SKILL.md/README sentences to P-08 (its test pins them). Until P-08 lands, those two docs still say init refuses quick and deep; `audit-readme.test.mjs`'s `other than \`standard\`` phrase is dropped there too.
- **D3** `profile: undefined` for `forceAdd` — `buildSeed` puts the run's profile in the `ctx` it hands to `carryForward`, and `forceAdd` spreads that `ctx`; clearing the one key there (with a comment) keeps the exemption in the one function the contract names, and `rulesOf` reads an undefined profile as standard (no gate). Tested by profile-granularity's prior-unit test.
- **D4** Placement — `synthPrompt` and `mintPrompt`: before `--- How units are ranked ---` / `--- Deterministic coverage ledger ---`; `criticPrompt`: before the critic section. The helper returns `''` when `PARTS.profile` is not text, so standard's prompts are byte for byte as before (the stage test's one-line-seam check and profile-granularity's standard test pass).
- **D5** `audit-inputs.mjs` — the module `audit-stage.mjs` and `audit-verdicts.mjs` already build inputs from, so the profile name check and the section reference live once; it reads `rulesOf(meta).profile`, as the contract allows for this one place.
- **D6** One sweep in `buildCritic` — `applyCriticProblems` (the mint stage's dry run) validates the same deferred ledger the write makes (tested in `audit-quick-waves.test.mjs`). A reassigned unit is `planned` after `reassign()` and a minted one is `planned` from `unitFromInput`, so the one `isHunterWork || in_progress` test covers contract items 1 to 3; a carried unit (a verifier's) is not hunter work and stays planned, so no prior lead leaves validation.
- **D7** Quick-only tally key — convention 2: standard's summary and event counts do not move; `tally.deferred` is set only on the quick branch, and the summary suffix keys on it (tested for the event counts of all three profiles).
- **D8** `deferUnit` — the literal `{ ...u, status: 'deferred', agent_id: null, unresolved: [reason] }` was in two places and P-04 needed a third; every caller hands it a unit with no live evidence (planned, in_progress, or reopened by `reassign()`, which empties it).
- **D9** Placement of the quick exit — before the `huntable`/`plan-wave` lines (the frozen test leaves a unit planned after quick's apply-critic and wants validation) and after `in_progress → hunt`, so standard's lines and order are untouched. Quick's apply-critic defers every in_progress unit and `plan-wave` is refused after it, so an in_progress unit there is unreachable; no test pins what `next` says for it.
- **D10** REVIEW defects left open — the critic-input fix is P-03's territory (`audit-stage.mjs`, `WF`); the collision fix would read against `RECONNAISSANCE.md:102` ("If duplicate IDs have different semantic fields, treat that as a canonical identity collision"), so it is a decision for its own session or the owner, not a side edit in P-04. Neither is exercised by P-04's frozen test.
- **D11** Consolidation funding per profile — the contract says 37e32c9 "is not on this branch yet"; `git log` shows it is (the branch was rebased), and `audit-verdicts.mjs consolidateInput` had `Math.floor((left - 1) / 2) < Math.min(pool, Math.floor(left / 2))`. The contract's own clause ("it divides by `verifiersPerCandidate` too") applies. `left < 2` stays: at one agent left the grouping would take the only verifier in every profile. Tested in `audit-quick-verify.test.mjs` (4 left: quick groups, standard and deep skip; 2 left: quick skips too).
- **D12** Placement and wording — after `The rejected branch:` and before the parent's retry note, so sections 1-11 keep their numbers and standard's prompt is byte for byte unchanged (the whole conditional is `''` without `parts.phase5`). Upstream's Phase 5 text tells its verifier to return `{"decision":"verified"...}` or `"replace"`, which `judgeValidator` discards as malformed, so the wrapper sentence says to return the object named at the end instead.
- **D13** Refusal wording — the contract allows "Phase 5 verifier" only for profiles that have one; quick's says one verifier per candidate, which is also its final record check. Standard and deep keep `with a Phase 5 verifier each` exactly.
- **D14** One `finishRun` — a quick run with no needs-Phase-5 record takes the existing branch (its note is accurate there too); one with such a record gets the merged-pass note. `finishRun` returns its problems and does not throw, so a bad marker leaves the run `incomplete` with `complete_check_failed` (frozen tamper tests).
- **D15** Facts-script bound — the validator prompt's merged section is in the workflow file, which every script carries. It measured 60,120 bytes and 60,087 after the sentence was cut down; cutting further would drop the return-shape instruction (D12). SPEC §7 allows up to 62,000, and 61,000 is the smallest round bound that fits.
- **D16** Reason location — the contract names only `audit-ledger.mjs` for P-06, and the string is PandaStack's reading (SPEC M2), not an upstream reason, so convention 5's "reason strings that are upstream's" does not pull it into `audit-profile.mjs`; it lives once, beside the `reassign()` it is passed to, exported for tests (`audit-deep-second-pass.test.mjs` imports it).
- **D17** Sweep on `next` — a unit the critic reopened in the same application is already `planned` with one attempt after `reassign()`, so `status === 'covered' && attempts.length === 0` alone implements "not already reassigned"; `patched` also holds units whose prior lead was resolved this application (still covered), and those must keep their second pass, so a `patched.has` guard would be wrong. Seed never writes `covered`, so a covered unit with no attempts is this run's own pass.
- **D18** Deep-only key — convention 2: standard's summary and event counts do not move, and quick has no second pass (tested: `audit-deep-second-pass.test.mjs` checks the event counts of all three profiles). The summary builds both optional suffixes through one `profileCount(key)` helper, `deferred` first; the two never occur together (quick and deep are exclusive).
