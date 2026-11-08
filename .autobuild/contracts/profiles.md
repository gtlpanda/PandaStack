# Contracts: the `quick` and `deep` profiles

One section per feature (`features.json`: P-01 to P-10). Each says exactly what the frozen test of that feature reads: files, exports,
CLI lines, ledger shapes and the strings the tests compare. `SPEC.md` says why, and quotes upstream. Where a test pins a string, the string
is written here exactly; where a section says "free", the tests do not look.

Paths are relative to the repository root. `SKILL` is `graphs/security-audit/skills/security-audit/`, `TESTS` is `graphs/security-audit/tests/`,
`WF` is `graphs/security-audit/workflows/security-audit-flow.js`. The test of each feature is `TESTS/profile-<name>.test.mjs`; run it with
`autobuild test P-0N`.

## Conventions (every feature)

1. **One table, read everywhere.** What a profile does is `profileRules(profile)` (P-01). Code reads a run's rules with `rulesOf(meta)` (tolerant:
   a meta with no profile, an unknown one, `null` or `undefined` reads as `standard`). Branch on a rule key where a key says it (`hunterWaves`, `finalCleanCritic`,
   `mergedValidation`, `sameSourceSecondPass`, `partialPass`, `coarseSubsystem`, `verifiersPerCandidate`); the two places that need the name itself (which `Profile rules` report line,
   and whether `parts.profile` is carried: quick and deep, not standard) may read `rules.profile`. The budget helpers that already exist (`criticReserve`, `validationReserve`) keep their
   own branch and are not touched; P-01's test pins that they agree with the table (`splitByLifecycle` has no code gate: it documents deep, and the prompts and the report carry it).
   `nextStep()` is called by existing tests with a `meta` that has **no** `profile`: it must keep working and mean standard.
2. **Standard does not move.** A run under `standard` (or with no profile) must behave and print exactly as it does today: same `next` lines,
   same ledger bytes, same stage inputs and prompts (a profile adds a key or a paragraph only when the profile is `quick` or `deep`), same
   summaries (a new count in a summary line appears only for the profile that has it). The existing tests are the proof; the editable ones are
   listed in `SPEC.md`, section 7.
3. **Profiles change breadth and redundancy, never the evidence bar.** Nothing here makes `confirmed` reachable, relaxes a validator, the link-check,
   the candidate gate, the independence history or a gate `audit-run.mjs check` makes. A ledger or a findings file still passes both vendored validators
   after every write.
4. **No target code runs, nothing new is written outside the run directory.** The agents' tool lists (`Read, Grep, Glob`) do not change.
5. **Strings are exact.** A reason string, a summary suffix or a report sentence named below is compared character for character. Reason strings that are
   upstream's come from `REASONS` / `QUICK_DEFERRED`, never retyped.
6. **Imports.** `audit-profile.mjs` imports nothing from `SKILL` (so `audit-run.mjs`, `audit-ledger.mjs`, `audit-stage.mjs`, `audit-verdicts.mjs`,
   `audit-findings.mjs` and `audit-report.mjs` can all import it without a cycle).

---

## P-01 The profile rules (`SKILL/audit-profile.mjs`, new)

Test: `TESTS/profile-rules.test.mjs`. Pure, no I/O.

```js
export const PROFILES = Object.freeze(['quick', 'standard', 'deep'])          // upstream's order
export const QUICK_SUBSYSTEM_REF = 'profile/quick/all-in-scope-subsystems'    // RECONNAISSANCE.md "Deterministic coverage ledger"
export const QUICK_DEFERRED = 'quick_profile_final_critic'                    // HUNTING.md "Coverage-critic waves"
export function profileRules(profile)   // a frozen plain object; throws TypeError whose message is exactly `unknown profile ${JSON.stringify(profile)}` for anything not exactly a name in PROFILES
export function rulesOf(meta)           // profileRules(meta.profile) when that is a name in PROFILES, else profileRules('standard'); never throws (the test compares with deepEqual, identity is not required)
```

`profileRules` returns exactly these keys and values (no others):

| key | quick | standard | deep | meaning |
|---|---|---|---|---|
| `profile` | `'quick'` | `'standard'` | `'deep'` | |
| `coarseSubsystem` | `true` | `false` | `false` | every unit's `canonical_refs.subsystem` is `QUICK_SUBSYSTEM_REF` |
| `splitByLifecycle` | `false` | `false` | `true` | recon splits units per subsystem and lifecycle mode |
| `hunterWaves` | `1` | `null` | `null` | `null`: as many as coverage needs |
| `finalCleanCritic` | `false` | `true` | `true` | the distinct final-clean critic exists |
| `mergedValidation` | `true` | `false` | `false` | Phase 3 and Phase 5 are one pass |
| `sameSourceSecondPass` | `false` | `false` | `true` | an independent second pass over `prior_covered_same_source` units |
| `partialPass` | `true` | `false` | `false` | the profile alone makes the report a partial pass |
| `verifiersPerCandidate` | `1` | `2` | `2` | verifier calls budgeted per expected candidate |

`audit-run.mjs` changes in this feature: `export const KNOWN_PROFILES = PROFILES` (same array, same order) and `REASONS.quick = QUICK_DEFERRED`.
`criticReserve` and `validationReserve` already agree with the table (the test checks); do not change them.

## P-02 `init` takes the three profiles (`SKILL/audit-run.mjs`)

Test: `TESTS/profile-init.test.mjs`.

- `SUPPORTED_PROFILES` is `['quick', 'standard', 'deep']` (equal to `KNOWN_PROFILES`).
- `init` no longer refuses a profile: delete the "is not available yet" refusal (the flag parser already makes an unknown name a usage error, exit 2, nothing created).
  `metadataProblems` (so `check`) names the three: `run-metadata.json: profile must be one of quick, standard, deep`.
- The usage text (printed on stderr, exit 2) is `... [--profile quick|standard|deep] ...`; update the header comment of the file the same way, and drop the
  "the others wait for PR 9" comment.
- The budget gate is the one that exists, generalised by `minimumBudget(profile)`: quick 8, standard 10, deep 10. Refusal text is unchanged in form:
  `AUDIT: FAIL budget_cannot_fund_reconnaissance_and_reserves: --budget N cannot fund the M calls profile P needs first (4 reconnaissance, 1 synthesis, C critic(s), C minter(s), 1 verifier); no agent was launched. ...`
  with `C` 1 for quick (`1 critic, 1 minter`) and 2 otherwise (`2 critics, 2 minters`). The run is recorded incomplete with that reason. This already works for the numbers; the test pins it.
- The `note: what runs:` line says `then one verifier per surviving lead` for `quick` and keeps `then one or two verifiers per surviving lead` for the others.
- `init` with no `--profile` is still `standard`.

## P-03 The units a profile asks for (`SKILL/audit-ledger.mjs`, `SKILL/audit-stage.mjs`, `WF`)

Test: `TESTS/profile-granularity.test.mjs`.

**Seed and mint gate (code).** `unitFromInput(input, ctx)` reads `ctx.profile` (a profile name, or absent = no profile gate). `buildSeed` and `buildCritic` put
`run.meta.profile` into their `ctx`. For `ctx.profile === 'quick'` (use `rules.coarseSubsystem`) a unit is refused, with these problems (several may apply, each is one string
in `problems`):

- `canonical_refs.subsystem` is not exactly `QUICK_SUBSYSTEM_REF`:
  `the quick profile coarsens every unit to one subsystem: canonical_refs.subsystem must be "profile/quick/all-in-scope-subsystems", not "<JSON.stringify of the value>"`
- the unit has `lifecycle` or `canonical_refs.lifecycle` (either one alone, or both; the vendored validator would also refuse a lone one, but quick's message must be there):
  `the quick profile does not split units by lifecycle mode: leave out lifecycle and canonical_refs.lifecycle`

The display `subsystem` label stays free. Refusals go through the paths that exist: `seed` throws `seed refused: ...` with the problems (the ledger file is not written, the step is
not saved), `seedProblems()` returns them (the stage code sends them back to the synthesizer once), and a refused minted unit in `apply-critic` is counted as rejected and not added
(`rejected=` in the summary; `applyCriticProblems()` lists it). **Exempt:** `forceAdd` (a unit an earlier run held that this run's recon did not seed keeps its own references: pass
no profile, or an explicit bypass, in its `ctx`; an earlier run's evidence is never coarsened and no prior lead may vanish). For `standard` and `deep` nothing is gated, and a
`ctx` with no `profile` (existing callers) is not gated.

**Upstream's text reaches the agents (stage inputs and prompts).** For `quick` and `deep` only, the stage inputs built by `reconInput(... 'synthesize')`, `criticInput` and `mintInput`
carry `parts.profile`, the text of `blockText('SKILL.md#Run profiles and scope')` (the vendored section, byte for byte; `blocks.mjs` already resolves it). For `standard` the key is absent.
The workflow's synthesizer prompt (`synthPrompt`), critic prompt and `mintPrompt` include it verbatim when `PARTS.profile` is non-empty text, under a heading
`--- The run profile, upstream text verbatim ---`; when it is absent the prompts are byte for byte what they are now. `parts.profile` is optional: the workflow must not escalate when it is
missing (standard has none). **Script size:** `audit-stage.test.mjs` pins the facts-part `run.js` under 60,000 bytes (the workflow file is in every script; the baseline is about 59,500), so keep
the profile wiring in `WF` to a few hundred bytes in all (the text itself arrives as data in `parts`); if it cannot fit, raise that one bound as `SPEC.md` section 7 allows.

## P-04 Quick's one wave and one critic (`SKILL/audit-run.mjs`, `SKILL/audit-ledger.mjs`)

Test: `TESTS/profile-quick-waves.test.mjs`.

**`nextStep`** (use `rulesOf(meta).hunterWaves === 1`; `meta` may have no profile):

| state | quick | standard / deep / no profile |
|---|---|---|
| `merge-wave` | `critic kind=post-wave wave=N` | same |
| `apply-critic` | go to validation: what `coverageDone()` returns (`write-findings`, `validate` for one record, `consolidate` for several), whatever planned units remain | `plan-wave` while a unit is planned, else the final-clean critic, as now |
| `seed`, nothing huntable (every unit deferred, out of scope, not applicable or carried) | `{ step: 'critic', kind: 'post-wave', wave: 1, hunted: false }` (the one critic still runs) | `{ step: 'critic', kind: 'final-clean', wave: 1, hunted: false }` |
| `plan-wave` that assigned nothing (the budget deferred every unit), no unit planned | `{ step: 'critic', kind: 'post-wave', wave: N }`, N = `max(state.wave, 1)`, no `hunted` key | `{ step: 'critic', kind: 'final-clean', wave: N }` |
| `seed` with a huntable unit, `plan-wave` that assigned units, `hunt`, an incomplete run | unchanged | unchanged |

(In general: wherever the machine falls through to "nothing left to hunt, ask a critic", quick asks its one `post-wave` critic and never `final-clean`, as `rules.finalCleanCritic` says.)

So a quick run's `next` line is: `recon, recon, seed, plan-wave, hunt, merge-wave, critic kind=post-wave, mint, apply-critic`, then validation. There is no `plan-wave` or `critic kind=final-clean`
after `apply-critic`, and the helpers refuse them (`... is not the next step of this run: NEXT: ...`, which `expectStep` already does).

**`applyCritic` for quick** (`rules.hunterWaves === 1`). After the critic's own work (reassigning, minting, resolving prior leads) as today, then:

1. A unit the critic reassigns (`reassign_ids`, a legitimate one with live `covered`/`blocked`/`candidate` evidence) is archived into `attempts` exactly as `reassign()` does (same fields,
   same `reassignment_reason`), `wave` is incremented, and its live state is **`deferred`**: `agent_id: null`, empty `reviewed_paths`, `local_checks`, `result_fingerprints`, and
   `unresolved: [QUICK_DEFERRED]`.
2. A minted unit that is accepted as in-scope work (it would be `planned`) is added with status **`deferred`**, `unresolved: [QUICK_DEFERRED]`, no owner, empty evidence. A minted unit outside a
   scoped run's scope stays `out_of_scope` (existing behavior; upstream: "records them as `out_of_scope`"). Minted entries still must have no explicit non-planned `status` (existing rule).
3. Every other unit that is hunter work (`isHunterWork`: `planned`, not carried to a verifier) and any `in_progress` one becomes `deferred` with `unresolved: [QUICK_DEFERRED]`: the one wave
   is over, nothing is left planned. (This includes a unit whose hunter result failed once and went back to `planned`.) Units a verifier owns (a carried prior record) stay planned.
4. `candidate`, `covered`, `blocked`, `out_of_scope`, `not_applicable` units (not reassigned) are untouched.
5. The summary line gets a final field: `... rejected=N deferred=D`, where `D` counts the units set to `deferred` by 1, 2 and 3. For `standard` and `deep` the summary has **no** `deferred=` field.
6. The ledger passes the vendored validator (deferred state table: no owner, empty evidence, non-empty reason).

## P-05 Quick merges Phase 3 and Phase 5 (`SKILL/audit-verdicts.mjs`, `SKILL/audit-findings.mjs`, `SKILL/audit-run.mjs`, `WF`)

Test: `TESTS/profile-quick-verify.test.mjs`.

- **Input.** The validate stage input has `parts.phase5` (the vendored Phase 5 section `VALIDATION-AND-REPORTING.md#Phase 5: Verify the final records with fresh eyes`, via `blockText`; the ref
  constant exists in `audit-verify.mjs` and is not exported: move it to `audit-inputs.mjs` and import it from both, do not retype it; `audit-verdicts.mjs` cannot import `audit-verify.mjs`, a cycle)
  **only for a profile with `mergedValidation`**; absent for the others.
- **Prompt.** When `PARTS.phase5` is non-empty text, the validator's prompt (`validatorPrompt` in `WF`) contains it verbatim, in a section whose heading includes
  `Phase 5 record checks, merged into this pass`, and says in words containing `no later Phase 5 pass` that the record the verifier returns is the final one. The other profiles' prompts are unchanged.
- **Budget.** `validateInput` funds candidates from what the budget has left in units of `rules.verifiersPerCandidate` agents each: `Math.floor(left / rulesOf(run.meta).verifiersPerCandidate)`
  (today a constant 2, which keeps one agent for a Phase 5 verifier; quick has none, so under a strict budget it would leave candidates unvalidated for a pass that never runs). Quick with two agents
  left funds two candidates; standard and deep fund one and end `incomplete` with `validation_budget_exhausted`, as now. Every place that assumes two agents per candidate takes the profile's number:
  if `consolidateInput` has a funding formula of that kind (`Math.floor(left / 2)`, `Math.floor((left - 1) / 2)`: the base branch `feat/security-audit-9-skill` got one after this branch was cut, in
  commit 37e32c9, which is not on this branch yet), it divides by `verifiersPerCandidate` too; this branch does not have it, so there is nothing to change until it is rebased. The refusal text may say "Phase 5 verifier" only for the profiles that have one.
- **Decisions.** When a quick run's validate stage decides an entry whose final record is `confirmed` or `needs_validation` (`needsPhase5`), the entry's `phase5` is
  `{ state: 'merged', verifier_id: <the entry's own verifier_id> }`. A `rejected` entry keeps `phase5: null`. (`decisions.json` entries already allow any object here.)
- **`nextStep`.** After `write-findings`, a quick run goes to `report` (never `verify`), whatever the records (`{ step: 'report', reason }` with the reason only for an incomplete run, as today).
  Standard, deep and no-profile runs keep going to `verify` when a record is `confirmed` or `needs_validation`.
- **`writeFindings`** in a quick run ends the run as the existing "no record needs Phase 5" case does: after the successful write it calls `finishRun(runDir)` and puts a note on the result
  (free text; say it is the quick profile's merged pass). It must not throw when `finishRun` finds problems (it marks the run incomplete with `complete_check_failed`).
- A candidate whose first verifier's result was discarded and retried (`v01`, then `v01-t2`) is marked with the ID of the result that was kept (`v01-t2`); the marker naming the discarded attempt is refused
  by `completeProblems` although that ID is also a validator of the fingerprint in the history (hence `verifier_id === entry.verifier_id`, not only a history lookup).
- **`completeProblems`** (so `complete-check`, `finishRun`): for a record that needs Phase 5, a profile with `mergedValidation` accepts `phase5.state === 'merged'` **if and only if**
  `phase5.verifier_id === entry.verifier_id` and the independence history holds that ID as role `validator` for the fingerprint. For every other profile, `merged` never satisfies it; the
  existing `verified` branch is unchanged for all profiles. A quick record with `phase5: null`, a different `verifier_id`, or a `verified` state with no Phase 5 verifier in the history
  fails with the existing text `record <fp> did not pass Phase 5`.

## P-06 Deep's second pass (`SKILL/audit-ledger.mjs`)

Test: `TESTS/profile-deep.test.mjs`. Deep's critics, waves, final-clean critic and two verification passes are standard's code (rule keys say so); this feature adds one thing.

In `applyCritic` (`buildCritic`), for a profile with `sameSourceSecondPass`, after the critic's own reassignments: every ledger unit with `prior_status === 'prior_covered_same_source'`, live
`status === 'covered'`, `attempts.length === 0`, and not already reassigned in this same application, is reassigned exactly as `reassign()` does (its terminal state archived in `attempts`,
`wave` + 1, live state `planned`, unassigned, empty evidence), with `reassignment_reason` exactly:

`the deep profile gives a unit an earlier run covered on unchanged source (prior_covered_same_source) an independent second pass`

It happens at the first critic application after the unit is `covered`, and only once (the archive is why: `attempts.length === 0`). The unit is then hunted in the next wave by a fresh
owner (`plan-wave` already names hunters by wave). The summary line gets a final field `second_pass=K` (K = units archived this way, 0 when none) **for the profile with the rule only**; standard
and quick summaries have no `second_pass` field. `candidate` and `blocked` units, and `prior_covered_changed_source` units, are not given a second pass.

Also pinned (nothing to build, the test guards it): for every state of the stage machine `nextStep` is the same line for deep as for standard, and after `write-findings` deep goes to `verify`.

## P-07 What the report says (`SKILL/audit-report.mjs`)

Test: `TESTS/profile-report.test.mjs`. `REPORT.md` only.

- **Run section**, one extra line (compared exactly as a whole line) after the `- Run ...` line, for quick and deep only (none for standard):
  - quick: `- Profile rules: quick ran one hunter wave and one final critic pass, with one fresh verifier per candidate doing both the candidate validation and the final record check; what the critic found and what it reopened are deferred, not hunted.`
  - deep: `- Profile rules: deep asked for units split per subsystem and lifecycle mode, ran critic waves to a clean pass, kept candidate validation and final record verification as separate fresh agents, and gave units an earlier run covered on unchanged source an independent second pass.`
  The line is the very next line after the `- Run ...` line.
- **Status.** For a profile with `mergedValidation` the complete-run sentence reads `The run is **complete**: every candidate has an independent final disposition and every retained record passed the quick profile's merged Phase 3 and Phase 5 verification. Complete is not clean: see the coverage summary and the limits below.`
  Standard and deep keep `... every retained record passed Phase 5 verification. ...` exactly as now (an incomplete run's status line is unchanged for all).
- **Partial pass.** The reason `the <profile> profile does not run the full method` is added only when `rulesOf(meta).partialPass` (quick). Deep and standard add no profile reason. The other reasons
  (incomplete, scope, strict budget, deferred coverage) and their order (`incomplete; scope; profile; budget; deferred`) are unchanged.
- **Final critic.** For a quick run whose last critic was the `post-wave` critic (its one), the section's sentence ends `... and said stop <bool>. It was the one final critic the quick profile runs, so no final-clean critic ran, by design: coverage is not claimed to be clean.`
  in place of `It was not the final-clean critic: coverage is not claimed to be clean.` Standard and deep keep the existing sentences.
- **Deferred as quick.** When at least one unit has `status === 'deferred'` and an `unresolved` array with an element exactly equal to `QUICK_DEFERRED` (a blocked unit's text, or a deferred unit's text that merely contains the string, is a hunter's words and is not counted), the coverage summary has, as its own line after the gap list and before the `### Final critic` heading, with `N` the number of such units:
  ``Units deferred as `quick_profile_final_critic` (found by the one critic, reopened by it, or not reached by the one wave): N. The quick profile does not hunt them.``
  (Any profile; the string only ever arises in a quick run.) (The units themselves are already listed as `- deferred: <label>: quick\_profile\_final\_critic`; quoted text is escaped, so underscores carry a backslash there.) No such line without such units.

`FINDINGS-DETAIL.md`, `NEEDS-VALIDATION.md`, the golden files and every standard report are unchanged.

## P-08 The docs (`SKILL/SKILL.md`, `graphs/security-audit/README.md`, `SKILL/audit-run.mjs` text)

Test: `TESTS/profile-docs.test.mjs`. Both documents get the same profile list, as list items that start with the profile name in code (`- \`quick\``, indented or not), wrapped lines allowed.
Each item must contain these phrases, and for each profile the budget sentence ``\`init\` accepts a \`--budget\` of N or more`` with `N = minimumBudget(profile)` (8, 10, 10), written
from the code's number (the test reads `minimumBudget`):

- `quick`: `one hunter wave`, `one final critic`, `one verifier per lead`, `quick_profile_final_critic`, `A partial pass`
- `standard`: `(the default)`, `the whole method`
- `deep`: `subsystem and lifecycle mode`, `critics until a clean pass`, `two separate verification passes`, `independent second pass`, `an earlier run covered on unchanged source`

And the sentence `Each profile keeps the same evidence bar` near the list. Other required changes (every one is read by the test):

- `SKILL.md` usage block: `[--profile quick|standard|deep]` (the flags in the block must still equal `INIT_FLAGS` plus `--unattended`/`--guidance`; `audit-skill.test.mjs` also checks this).
- `SKILL.md` "Not supported" bullet becomes exactly `Not supported in this version: \`--changed\`, \`--model\`, \`--limits\`, \`--fresh\`, \`--resume\`.` followed by its existing sentences ("Do not pass them ..."); it
  no longer names profiles. The last rule becomes `Do not set a model or limit this version does not take, ...` (the word `profile` removed from it).
- `SKILL.md` section 6 (finish) has a bullet that says `a \`quick\` run is a partial pass` and `name what it deferred` (both phrases).
- README status paragraph: no `other than \`standard\`` and no `profiles \`quick\` and \`deep\` and the hardened sandbox are later changes`; it says `the hardened sandbox is a later change` (those words) and
  names `--profile quick` and `--profile deep` as supported.
- `audit-run.mjs`: no `wait for PR 9`, no `is not available yet`, no `[--profile standard]`; the usage string has `[--profile quick|standard|deep]`.
- Keep: every sentence the existing tests pin (`audit-readme.test.mjs` except the one phrase `other than \`standard\``, which the contract above removes and `SPEC.md` section 7 lets that test drop; `audit-skill.test.mjs`; `scripts/validate.sh` pins). The README sentence `(the smallest it accepts, 10, funds no hunter)` and the
  skill's ``the smallest `init` accepts, 10, funds no hunter`` are about standard and stay.

Do not edit `CLAUDE.md`, `retro.md`, the top-level `README.md` or `scripts/` (the owner writes the retro entry after the run).

## P-09 End to end, quick (no source change; fixtures are frozen)

Test: `TESTS/profile-e2e-quick.test.mjs` with `TESTS/profile-e2e-support.mjs`. A whole quick audit of the toy repository through `driveAudit({ initArgs: ['--profile', 'quick', ...] })`, the commands
taken from `SKILL.md`. It passes when P-02 to P-05 and P-07 are right and fails on the first thing they got wrong. Expected, for the builder who debugs it: 13 agents
(`recon-1a..1d`, `synth-recon`, `h1-01` owning all four units, `c1`, `synth-mint1`, `synth-cons`, `v01..v04`), the path `recon recon seed plan-wave hunt merge-wave critic:post-wave mint
apply-critic consolidate validate write-findings report done`, six units (four candidates, two deferred as `quick_profile_final_critic`), run `complete`, the three leads and one rejected claim.
It also drives quick under `--budget 13` (exactly what it spends: complete, 13 agents) and `--budget 12` (incomplete, `validation_budget_exhausted`, never more than 12): the P-05 budget sentence is what makes 13 enough.
If a frozen test here looks wrong, that is a BLOCKER (README of autobuild): do not change it.

## P-10 End to end, deep (no source change)

Test: `TESTS/profile-e2e-deep.test.mjs`. As P-09 with `--profile deep`: standard's path and 22 agents, seven units (the toy's four, two minted, one `lifecycle: delete` unit riding with
its subsystem's hunter), Phase 5 by `r` verifiers, no partial pass, `Profile rules: deep ...` in the report. It then runs a **second deep audit of the same commit** (the first is its earlier run): the two units
the first run covered (`src/server.js#server`, `src/auth.js#currentUser`, minted gaps hunted in wave 2) return as `prior_covered_same_source` and each carries exactly one archived second pass
(`wave` 2, an `h2-` owner); no other unit has an attempt.
