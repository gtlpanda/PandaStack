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
