# CP-08: /release-pr on Codex (release-controlled profile, release CLI, catalog flip)

Part of the Codex parity completion matrix (spec/codex-parity-completion-matrix.json, batch
CP-08: "Exact-head docs/readiness/approval/merge/deploy state machine through native leaves;
offline remote adapters for proof"). Pattern: CP-04c/CP-04e (blueprint's Codex port).

Everything it proves runs against the frozen fake codex and recording `gh` and `claude` stubs:
wiring proof, not runtime certification. Whether a real Codex `workspace-write` sandbox with
`network_access=true` lets `gh` reach GitHub is an untested hypothesis (no codex was run).

## 1. The `release-controlled` profile (CP-02a/b/c amended)

CP-02b refused `release-controlled` with `PROFILE_UNSUPPORTED`. It now runs as:

    --sandbox workspace-write  -c sandbox_workspace_write.network_access=true

(and every flag a leaf already gets: `--ignore-user-config`, `approval_policy="never"`).

Why this is the minimum: the release leaves run `gh` (readiness reads, the merge) and health
checks, so they need network. Codex's network switch is a `workspace-write` setting;
`read-only` has none, and `danger-full-access` (no sandbox) is not offered by
`codexExecArgs`. Nothing narrower than `workspace-write` plus the switch gives network.

- `codexExecArgs` gains `networkAccess` (boolean, default false). `true` is legal only with
  `sandbox: 'workspace-write'`; anything else is `INVALID_CODEX_EXEC_INPUT`. The sandbox
  closed set is unchanged.
- codex-provider.mjs maps `release-controlled` to `workspace-write` and passes
  `networkAccess: true` for that profile only. `source-review`, `build-workspace` and the
  refused `audit-source-only` are unchanged. `sandboxForProfile` keeps its signature and the
  provider keeps exactly four exports.
- codex-selection.mjs: `CODEX_REFUSED_WORKFLOWS` becomes `['security-audit-flow']`.
  `release-controlled` is selected only for a leaf whose `workflowId` is `release-flow` and
  whose path is exactly `['release-flow']`; elsewhere it is still `INVALID_SELECTION` (the
  runtime also refuses it outside release-flow: `PROFILE_REFUSED`).
- Per role (ROLE_PROFILES, unchanged): `release-checker`, `merger`, `deploy-watcher` get the
  network. `scribe` (build-workspace) gets `workspace-write` without network; `advisor`
  (source-review) gets `read-only`.

## 2. The CLI: graphs/release/skills/release-pr/release-native.mjs

    node release-native.mjs <docs|ready|approve|land|verify> --args-file <absolute path>

Runs one release-flow stage through the CP-02e graph host and the CP-02b provider, saves the
ledger to `<git-dir>/harness-release/<pr>/ledger.json` (the SKILL.md Setup directory), and
prints `{status, file, stateDir, invocationId}` (`approve` prints `{approved, head}`). Exit 0
done (any ledger status), 1 bad input, 2 refusal, 3 failure, 4 busy run directory.

Safety boundaries held by the CLI (the same as on Claude, where the session holds them):

1. `approve` saves `approval.json` only when the last ledger is stage `ready`, status
   `ready-to-merge`, for the same pr, and the given `head` and `base` equal that ledger's
   (`NOT_READY`, `HEAD_MISMATCH`). `docs` and `ready` delete any saved approval.
2. `land` needs `approval.json` (`NO_APPROVAL`) and passes it to the graph, which re-reads the
   head on GitHub: a moved head or base is `stale`, and the CLI then deletes the approval.
3. At most one merge attempt: the merger leaf is dispatched only after the CLI creates
   `merge-attempt.json` exclusively (O_EXCL), immediately before the dispatch, and never
   removes it. A dispatch that loses the marker is a failed leaf, spawning nothing, so a later
   `land` ends `escalate` with the refused dispatch and `approve` exits 2
   `MERGE_ALREADY_ATTEMPTED`. A later `land` still reads the state back: the graph reports an
   already MERGED pull request (`merged`, merger not called), which writes `merge.json` so
   `verify` can run. A failed, refused, timed-out or unknown merge is never retried by the CLI.
   The marker is per pull request, not per head: a new head and a fresh approval after a
   dispatched attempt cannot merge on Codex (SKILL.md says never retry the merge); the graph
   host CLI (`graph-host.mjs`) does not go through this marker, so the marker guards this CLI's
   path, not every possible way to run release-flow.
4. No branch-protection bypass, force-push or rollback: the CLI runs no git except
   `rev-parse`, no `gh`, and the graph's roles are unchanged. A failed deploy ends in
   `rollback-recommended` for the human.
5. No fallback: a refused or failed leaf ends the stage as an `escalate` ledger; the CLI never
   starts another provider.
6. `verify` reads the merge SHA and targets from `merge.json`, written when `land` reports
   `merged`; without it, `NOT_MERGED`.

## 3. Catalog and SKILL.md

- release-pr's codex row: `{implementation: 'partial', transportId: 'codex-graph-host',
  limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE']}`;
  `dependencies` gain `native-runtime`; `proofRefs` is `['cp-08-release-codex']`;
  `permissionProfile` stays null (profiles are per leaf role, not per offering);
  `entrySha256` follows SKILL.md. No new transport.
- SKILL.md gains one `## Codex runner` section before `## Setup`. Sections Setup to 6 and
  Notifications are unchanged.

## Differences from Claude (honest list)

- The leaves run in Codex's `workspace-write` sandbox, which also lets a release leaf write
  inside the repository; Claude's `merger` has only the Bash tool (which is itself
  unsandboxed). The checker, merger and watcher prompts say they never edit.
- The leaf environment carries `HOME` (gh's stored login) and `GH_CONFIG_DIR`/`GH_HOST` when
  set, never a token variable; a `gh` that works only through `GH_TOKEN` needs the user.
  The Claude session passes its own whole environment.
- Codex has no push notification; the session puts the status and action at the top of its
  last message.
- Deploy configuration is still read from the repository's `CLAUDE.md` by the release-checker.
- The approval-before-merge rule is enforced by the CLI state (items 1 to 3) rather than only
  by the session's discipline.

## Acceptance

acceptance/codex-parity/cp-08-release-codex.test.mjs. It amends, minimally, the pins listed
in PROGRESS-codex-parity.md (CP-08 entry).
