# SPEC: the `quick` and `deep` audit profiles (security-audit PR 9)

Frozen. This is the source of truth for the build; `contracts/profiles.md` is the precise half (files, exports, strings), `features.json` the order, `RULES.md` how a loop session works.
Upstream below means the vendored Cloudflare skill, `graphs/security-audit/vendor/cloudflare-security-audit/skills/security-audit/` (cited `SKILL.md:107`, `HUNTING.md:249`, ...; in sections 1 to 5 a bare file name with a line number is upstream's, in section 6 `SKILL.md` and `README.md` are PandaStack's own, in `graphs/security-audit/`). Where the plan
(`tasks/plan-security-audit.md`, sections 1.3, 4.7, 9 row 9) and upstream differ, upstream wins; each difference is in section 5.

## 1. Scope

**Build:** `init --profile quick` and `--profile deep`, the quick and deep behavior of the stage machine, the report's statement of the profile, the docs, and an offline end-to-end audit of each profile.
**Do not build:** the sandbox, promotion of local artifacts, or anything that makes `confirmed` reachable (plan D1 A stays: this graph is source-only; `CONFIRMED_REACHABLE` stays `false`); new agents, new agent
tool lists, or a change to any agent's model (D9: sonnet, effort high); `--changed`, `--model`, `--limits`, `--fresh`, `--resume`; a change to anything under `vendor/`, `scripts/`, `graphs/autobuild/`,
`CLAUDE.md`, `retro.md`, the top-level `README.md`. A profile never changes the evidence bar (`SKILL.md:117`): the candidate gate, the source/local boundary, `needs_validation` discipline, schema
validation and independent verification stay as they are for all three profiles.

## 2. What upstream says each profile does (the authority)

| Field | `quick` | `standard` | `deep` |
|---|---|---|---|
| Purpose (`SKILL.md:111,113`) | a bounded pass for small targets, re-runs or a fast first look | the workflow as written | high-stakes or large targets |
| Ledger units (`SKILL.md:111`; `RECONNAISSANCE.md:92,102`) | coarsened to surface × boundary × attack class; the subsystem dimension is the fixed canonical value `profile/quick/all-in-scope-subsystems` | surface × boundary × subsystem × attack class | split per subsystem **and lifecycle mode** (`canonical_refs.lifecycle` plus a `lifecycle` label, `RECONNAISSANCE.md:135`) |
| Hunter waves (`HUNTING.md:249`) | **exactly one** | as many as coverage needs | as many as coverage needs |
| Critics (`HUNTING.md:247,249`; `SKILL.md:123,128`) | **exactly one**, the final post-wave critic; no second wave, no final-clean critic | a post-wave critic after each wave, then a distinct final-clean critic that must also accept nothing, else repeat | the same loop as standard ("critic waves to a clean pass", `SKILL.md:113`) |
| What the critic finds (`HUNTING.md:249`) | each accepted `missing_unit` is added `deferred` with reason **`quick_profile_final_critic`**; each legitimate evidence-bearing `reassign_id` is archived in `attempts`, `wave` incremented, live state unassigned `deferred`, empty evidence, same reason; in a scoped run, out-of-scope gaps are recorded `out_of_scope` | queued and hunted | queued and hunted |
| Phase 3 / Phase 5 (`SKILL.md:111`; `VALIDATION-AND-REPORTING.md:124`) | **merged**: one fresh verifier per candidate does candidate validation and the final record checks and returns the final record; "never skip independent review of a `confirmed` record in any profile" | two separate fresh passes | two separate fresh passes (`SKILL.md:113`) |
| Same-source prior coverage (`SKILL.md:113`; `RECONNAISSANCE.md:137`) | (as standard) | a `prior_covered_same_source` unit stays visible; changed source and gaps first; the critic decides whether it needs another pass | an **independent second pass** for those units |
| Report (`SKILL.md:115`; `VALIDATION-AND-REPORTING.md:159`) | "a scoped or `quick` run must present itself as partial coverage"; states plainly that it is a partial pass | | |
| Budget reserves (`SKILL.md:121-134`) | one final post-wave critic; verifier cost 1 per expected candidate | one post-wave plus one distinct final-clean critic; 2 per candidate | as standard |

PandaStack's reserve arithmetic (already in `audit-run.mjs`, tested, **not** changed here): `minimumBudget(p) = 4 reconnaissance + 1 synthesis + criticReserve(p) × (1 critic + 1 minter) + 1 verifier`,
so quick 8, standard 10, deep 10. `init --budget` below the minimum is refused with `budget_cannot_fund_reconnaissance_and_reserves` and the run is recorded incomplete (P-02 pins it for each profile).
The smallest budget `init` accepts funds no hunter for any profile (quick 8: after the 5 recon calls 3 remain, taken by the critic, its minter and one verifier). Say so only where the docs already do (standard).

Reason strings are upstream's, character for character, and live in one place each: `quick_profile_final_critic` (`REASONS.quick`, `QUICK_DEFERRED`), `budget_cannot_reserve_critics_and_validation`,
`critic_budget_exhausted`, `validation_budget_exhausted`, `budget_cannot_fund_reconnaissance_and_reserves`. Do not retype them; do not invent new upstream-looking strings.

## 3. How this repo builds it (summary; the contract has the detail)

- **One table.** `audit-profile.mjs` holds `profileRules(profile)` and the tolerant `rulesOf(meta)`; every branch below reads a rule key (P-01).
- **init** takes all three profiles (P-02). **Seed and mint** refuse a quick unit that is not coarsened or that carries a lifecycle (P-03); quick and deep stage inputs and prompts carry upstream's
  "Run profiles and scope" section verbatim; standard's are untouched (P-03).
- **Quick's loop** (P-04): after the one critic's result is applied the run goes to validation; the critic's findings, the units it reopened and the units no hunter reached are `deferred` with
  `quick_profile_final_critic`. **Quick's verification** (P-05): the validate stage also carries the Phase 5 checks; each decided lead is marked `phase5: { state: 'merged', verifier_id }`;
  `next` skips `verify`; `write-findings` ends the run; `complete-check` accepts the marker only in quick and only when it names the entry's own Phase 3 verifier.
- **Deep** (P-06): standard's machine, plus the second pass over `prior_covered_same_source` units (archived in `attempts`, hunted again by a fresh owner, once).
- **Report** (P-07): a Run line per profile, partial pass for quick only, a sentence for the one critic, a count of units deferred as quick. **Docs** (P-08).

## 4. The vocabulary a session needs

`coverage-ledger.json` units have the eight states of upstream's table (`planned`, `in_progress`, `covered`, `candidate`, `blocked`, `deferred`, `out_of_scope`, `not_applicable`; `RECONNAISSANCE.md:141-150`);
the vendored validator judges every write (`deferred`: no owner, empty evidence, a non-empty reason). `attempts[]` archives a terminal state when a critic reopens a unit. `stage-state.json` is
`{ last, wave, critic_kind: null | 'post-wave' | 'final-clean' }`; quick's one critic is `post-wave` of wave 1 (agent ID `c1`), by decision (section 5, M5). `decisions.json` holds each candidate's verdict, its
verifier and its Phase 5 state; the independence history (`agent-history.json`) says which agent played which role. `next` (`audit-run.mjs nextStep`) is the only scheduler; the helpers refuse out-of-order steps.

## 5. Where this build departs from the plan or reads upstream (each is a decision, logged in `DECISIONS.md`)

- **M1 Deep adds nothing to the critic loop or to the verification passes.** The plan lists "critics to a clean pass, separate Phase 3/5 verifiers" as deep's. Upstream gives the same loop to `standard` and
  `deep` (`HUNTING.md:247`: "In `standard` and `deep`, ...") and the same two passes to "every other profile" than quick (`VALIDATION-AND-REPORTING.md:124`), so in code they are standard's and a test pins
  that `next` is the same line for deep and standard in every state (P-06). What deep adds: lifecycle units (model-side, via the prompts and the seed accepting `lifecycle`) and the second pass.
- **M2 The second pass is a reading, not upstream's text.** Upstream has one clause: "give `prior_covered_same_source` units an independent second pass" (`SKILL.md:113`). Today every profile hunts such a unit, last
  (`HUNTING.md:7`: "same-source re-passes"; `audit-ledger.mjs priorRank`). I read "second pass" as: after this run's own pass covered the unit, archive that pass and plan it again for a fresh owner, once, at the
  first critic application (P-06). This is an **untested hypothesis about upstream's intent**; the mechanism (`attempts`, `wave` + 1, a fresh owner) is upstream's own reopening mechanism (`HUNTING.md:247`).
- **M3 Quick defers every untouched unit, with upstream's one reason string.** `HUNTING.md:249` gives `quick_profile_final_critic` to what the critic found and reopened, and says quick "is a pre-declared early stop"
  whose rule is "mark every untouched unit `deferred`, preserve the critic's reason" (`HUNTING.md:247`). For a unit no critic mentioned (a hunter's result failed and the unit went back to `planned`, or a unit a
  hunter never got) there is no critic reason; I use `quick_profile_final_critic` for it too, so no `planned` unit survives a finished quick run. Reading, not upstream text.
- **M4 Quick's critic when nothing is huntable.** Upstream: "exactly one hunter wave followed by exactly one final critic pass". With no huntable unit no wave runs; the one critic still does (`next` says
  `critic kind=post-wave wave=1`, with `hunted: false` in its input, as the final-clean critic already does in that case for standard). Reading.
- **M5 Quick's critic is `post-wave`, wave 1, `c1`.** Upstream calls it "its one post-wave final critic" (`SKILL.md:128`) and "one final critic pass" (`HUNTING.md:249`). Keeping the existing `critic_kind` values means
  `stage-state.json`, the critic input and the report need no new enum; the report says it was the final one by design (P-07).
- **M6 Phase 3 and Phase 5 merged, mechanism ours.** Upstream describes the effect (the Phase 3 verifier also performs the Phase 5 checks and returns the final record, `VALIDATION-AND-REPORTING.md:124`) and has no
  record of verification state. `phase5: { state: 'merged', verifier_id }` in `decisions.json` and the `complete-check` branch are PandaStack's, kept narrow: quick only, and only the entry's own Phase 3 verifier.
- **M7 Partial pass.** `audit-report.mjs:140` marks any profile other than standard a partial pass; upstream says scoped or quick (`SKILL.md:115`). Deep is not a partial pass because of its profile.
- **M8 Earlier runs' units are never coarsened.** A quick run force-adds an earlier run's unit that this run's recon did not seed, with that run's own references (`RECONNAISSANCE.md:137`; no prior lead vanishes).
  A prior quick or scoped ledger "contributes only its recorded evidence and gaps" (`SKILL.md:103`): nothing changes there, `carryForward` already treats it so.
- **M9 Lifecycle is allowed in every profile except quick, required in none.** `RECONNAISSANCE.md:135`: "When `lifecycle` is material, add both ...". Deep is where recon is told to split by it; the code
  does not insist (a deep target with nothing lifecycle-shaped is legitimate). Quick refuses it (its subsystem identity is coarsened; `RECONNAISSANCE.md:92`: "deep adds lifecycle modes").
- **M10a Quick's validation budget is one agent per candidate.** `audit-verdicts.mjs validateInput` funds `Math.floor(left / 2)` candidates, keeping one agent for each Phase 5 verifier; quick has none (Phase 3 and 5 are one pass,
  `VALIDATION-AND-REPORTING.md:124`; `SKILL.md:128`: "about 1 or 2 agents per expected candidate" depending on profile), so under a strict budget a quick run was ended `incomplete` with agents to spare (measured on the toy repository:
  budgets 13, 14 and 16 incomplete after 11 or 12 agents, though the run spends 13). It funds `left / verifiersPerCandidate` now (P-05; P-09 drives `--budget 13` and `12`).
- **M10b Where the machine asks a critic.** Wherever it falls through to "nothing left to hunt", quick asks its one `post-wave` critic, never `final-clean` (a `plan-wave` the budget deferred entirely, as well as an empty seed): P-04.
- **M10c The base branch moved after this branch was cut.** `feat/security-audit-9-skill` had `a503e8d` when this branch started; it has two more commits now (37e32c9: `consolidateInput` skips the grouping when its agent would
  leave validation funding fewer candidates, a formula that assumes two agents per candidate; 2de2d19: `verify` rebuilds a lagging findings.json). Nothing here depends on them: the prototype of this contract applies to the new tip
  with offsets only, no conflicts. `.autobuild/check-existing-tests.mjs` measures against the merge base, so a rebase does not trip it. If you rebase, P-05's budget sentence also covers 37e32c9's formula (contract P-05).
- **M10 Plan 4.7 row "Profiles quick/standard/deep ... others refused": staged.** After this build nothing is refused. The plan's row 9 estimate is ~250 lines; this build is larger because of the tests and docs.
- **M11 No retro entry from the loop.** The retro entry and the plan's status are the owner's, after the run.

## 6. Every sentence that must change (current location at the branch point, what it says, what it becomes)

Code, text the helpers print or read:

| Where | Today | Becomes |
|---|---|---|
| `audit-run.mjs:6` (header) and `:703` (`USAGE`) | `[--profile standard]` | `[--profile quick\|standard\|deep]` |
| `audit-run.mjs:13` (header) | "profile supported" gate | says the three are supported |
| `audit-run.mjs:49` | `SUPPORTED_PROFILES = ['standard']  // ... the others wait for PR 9` | all three, no PR 9 comment |
| `audit-run.mjs:595` (`check`) | `profile must be one of standard` | `profile must be one of quick, standard, deep` |
| `audit-run.mjs:663` (`init`) | refuses with `profile X is not available yet (only standard); it is never run as a different profile` | the refusal is gone |
| `audit-run.mjs:753` (the `note: what runs` line) | `then one or two verifiers per surviving lead` | the same for standard and deep; `then one verifier per surviving lead` for quick |
| `audit-report.mjs:140` | any profile other than standard: `the <p> profile does not run the full method` | quick only (`rulesOf(meta).partialPass`) |
| `audit-report.mjs:227` (final critic) | `It was not the final-clean critic: coverage is not claimed to be clean.` after any non-final critic | for quick's one critic: `It was the one final critic the quick profile runs, so no final-clean critic ran, by design: coverage is not claimed to be clean.` |
| `audit-report.mjs` Run section and coverage section | nothing about the profile | the `Profile rules` line and the `Units deferred as ...` line (contract P-07) |

Docs:

| Where | Today | Becomes |
|---|---|---|
| `SKILL.md:43` (usage block) | `[--profile standard]` | `[--profile quick\|standard\|deep]` |
| `SKILL.md:55-57` ("Not supported in this version") | `--profile quick` and `deep` (init refuses them; they are a later change), `--changed`, `--model`, `--limits`, `--fresh`, `--resume` | `--changed`, `--model`, `--limits`, `--fresh`, `--resume` |
| `SKILL.md` section 2, after the `--scope` bullet | nothing about profiles | the profile list (contract P-08), each with its rules and `init` accepts a `--budget` of N or more |
| `SKILL.md:86` (section 3, the init notes) | `then one or two verifiers per surviving lead` | says quick is one |
| `SKILL.md` section 6 (finish) | | a bullet: a `quick` run is a partial pass; name what it deferred |
| `SKILL.md:234` (closing rule) | `Do not set a profile, model or limit this version does not take` | `Do not set a model or limit this version does not take` |
| `README.md:15-16` (graph README status) | `The profiles quick and deep and the hardened sandbox are later changes; init refuses a profile other than standard ...` | the sandbox is the later change; `--profile quick` and `--profile deep` are supported |
| `README.md` after the status paragraph or in the topology section | | the same profile list as the skill (contract P-08); the `critic N` rows say quick has one |
| `README.md:135-139` (Cost) | standard's numbers (`the smallest it accepts, 10, funds no hunter`) | unchanged; the profile list carries the quick and deep numbers |

Unchanged on purpose: `scripts/validate.sh` pins, the top-level `README.md`, `CLAUDE.md`, `retro.md` (the owner adds entry 43), the golden reports, every agent file.

## 7. Existing tests

The existing suite stays green (`scripts/test.sh` is the gate). Standard behavior must not move, so existing tests should not need edits except those that assert what this build ends:

- `graphs/security-audit/tests/audit-run-init.test.mjs` (the test "init refuses profiles quick and deep ...", about lines 56-64): replace the refusal assertions by acceptance; keep the usage-error assertions for `fast` and `Standard`.
- `graphs/security-audit/tests/audit-run-state.test.mjs` (`SUPPORTED_PROFILES` equals `['standard']`, about line 67; `profile must be one of standard` for a `quick` metadata, about line 450): expect the three profiles
  and `profile must be one of quick, standard, deep` (use an unknown profile such as `fast` for the negative).
- `graphs/security-audit/tests/audit-readme.test.mjs` (the README must say `other than \`standard\``): drop that phrase from the list of required sentences.
- `graphs/security-audit/tests/audit-stage.test.mjs` (the facts-part script is pinned `< 60_000` bytes, about line 142; the workflow file is in every script, the baseline is about 59,500, and the
  profile prompts add some): raise that one bound to at most `62_000` if (and only if) the script no longer fits (the gate step allows one changed line in this file), keep the wiring in `WF` small first, and log the number in `DECISIONS.md`.
- Any other existing test: only if a behavior it asserts was really ended by the contract, and then add to it, never delete a line of it (`.autobuild/check-existing-tests.mjs` is a gate step: an existing test file
  may only grow, except the four above; a file it flags is a decision to log or a BLOCKER, not a thing to route around).

New tests you write for your own edge cases go in new files named `graphs/security-audit/tests/audit-<topic>.test.mjs` (not `profile-*`: those are the frozen acceptance files and their support modules).

## 8. The harness (for the curious; none of it is yours to change)

- Acceptance tests run through `.autobuild/run-acceptance.mjs` (`autobuild test P-0N`). `scripts/test-workflow.mjs` carries a small patch (revert it with `.autobuild/`) that skips the test file of a feature whose
  `passes` is not `true`, so `scripts/test.sh` stays green while the loop builds; a file's tests join the regular suite the moment its feature is marked passing.
- The gate (`autobuild check`): frozen files unchanged; the current feature's test; `.autobuild/check-existing-tests.mjs`; `scripts/test.sh` (validate, install, secrets, workflow, autobuild: about 5 minutes);
  then every passing feature's test again.
- State and logs are in `.autobuild/state` and `.autobuild/logs`, ignored by `.autobuild/.gitignore`.
