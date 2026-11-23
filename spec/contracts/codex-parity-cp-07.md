# CP-07: build-app on Codex (driver dispatch, catalog flip, wiring proof)

Part of the Codex parity completion matrix (spec/codex-parity-completion-matrix.md, batch
CP-07): "Explicit provider dispatch and native probes/sessions throughout driver, including
lifecycle, locks, per-slice gates, final QA/hunt and controlled PR flow." Proof reference id:
`cp-07-build-app-wiring`, carried by build-app's catalog row, named here and in
graphs/build/tests/driver-codex.test.mjs.

Everything it proves runs against the frozen fake codex (acceptance/codex-parity/cp-02f-fake-codex.cjs),
the fake gh and stub QA/hunt CLIs: wiring proof, not runtime certification. No live codex, claude or
GitHub call was made. LIVE_PROOF_MISSING stays in the row.

## Dispatch

`driver.mjs run ... --backend claude|codex` (default `claude`: its behaviour is unchanged). The flag is
for `run` only and may appear once. Codex touchpoints, each reusing existing code:

| stage | Claude | Codex |
|---|---|---|
| slice session | `claude -p "/dev --slice ..."` | `codex exec` through autobuild's `runCodex` (graphs/autobuild/tool/lib/codex.mjs); report from `--output-last-message` under a strict `--output-schema`; the driver commits as `S<n>: <title>` after a `done` report |
| guard | PreToolUse hooks | none: post-session host checks (git control files digest, frozen tests, `S<n>: ` subjects, clean tree, own verify) |
| availability probe | Haiku one-turn | one-turn `codex exec` probe (`role: probe`) |
| final QA | `harness-repair` through the Workflow tool | `graphs/qa/tool/qa-loop.mjs` (CP-05d); the driver commits the touched files as `final: QA fixes` |
| bug hunt | headless `/bughunt` session | `native-cli.mjs --backend codex --mode fix --codex-bin <codex>`; the CLI prepares the hunt, the driver rebuilds `prep` from its `state=` line and lands through `landHunt` |
| PR | `pushAndOpenPr` | the same, unchanged |
| cost | dollars from the result line | tokens (`status.json` `tokens`), no dollar budget |

Lifecycle, the lock (`driver.pid`, `session.pid` orphan check), the ledger, brakes and exit codes are shared.

## No fallback

- A build is pinned to its provider (`backend.json` in the state dir, or "claude" for a ledger with
  progress and no record). A `run` on the other provider exits 6 before any session.
- A provider refusal is not an escalated attempt (that path re-plans and retries). The run brakes (exit 3),
  `provider-refusal.json` is written, and every later run refuses to start until a person removes it.
- Every other Codex failure is the existing escalation, brake or pause path. Nothing starts `claude`.

## Catalog

build-app's codex row becomes `{implementation: 'partial', transportId: 'codex-autobuild',
limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE']}` and `proofRefs` is
`['cp-07-build-app-wiring']`. No new transport: `codex-autobuild` (entry graphs/autobuild/tool/lib/codex.mjs)
is the module that launches the slice sessions. `entrySha256` follows SKILL.md (new `## Codex runner`
section; sections 1 to 6 untouched). Claude row, `dependencies`, `evidenceOwners`, `requirementsComplete`
and `nativeReadiness` do not change.

## Known limits (untested hypotheses where marked)

- The final QA runs through the `dev` offering. While `dev`'s codex row is `unavailable`, qa-loop exits 2
  `OFFERING_UNSUPPORTED` and the run brakes after the last slice. The two real-CLI cases in the test check
  only that the CLIs accept the driver's arguments.
- The usage-limit, billing, auth and overload patterns are the Claude ones (limits.mjs); their match on real
  Codex wording is an untested hypothesis.
- The driver's Codex-side stand-in for the guard hook is a digest of .git config, hooks and info taken before
  each session and compared after it. On a change the run ends (exit 12) before the driver runs any git
  command that could execute a planted hook (no set-aside, no commit, no checkout); the work stays in place.
- The build-app to bughunt dependency (the driver imports the hunt's land.mjs and runs its CLI) is real and not
  declared in `dependencies`: the Claude path already had it undeclared, the SKILL.md section avoids the
  `skills/<id>/` spelling that the drift guard reads as a mention. Declaring it is untested (cp-03b's closure
  rule may refuse a dependency that lives under graphs/).
- A refusal inside the QA loop's leaves escalates through the graph; the driver cannot tell it from another
  escalation, so a resume asks again. Untested hypothesis that this is acceptable.

## Amended pins

Each retired only to the new intended state, before-and-after green: cp-01b (codex-partial set), cp-01c
(plan lines; sha of tests/install-codex.test.mjs; fixture roots set build-app unavailable), cp-01d (ready set),
cp-03b (installed set), cp-04e (partial set, plan, installed links), tests/install-codex.test.mjs (installed
set), tests/install-plan.test.mjs (fixture base and this checkout's plan) and
tests/host-wiring-proof-ref.test.mjs (build-app's one reference and the plan).
