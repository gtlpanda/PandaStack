# CP-04e: blueprint on Codex (runner section, catalog flip, end-to-end proof)

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125),
wave 2. Root decision W2-6 binds it: blueprint becomes Codex `partial` through driver
CLIs, and the session asks the interview and approval questions in chat and drives
them. CP-04c (the stage CLI) and CP-04d (the approve CLI) built the CLIs. This feature
adds the instructions a Codex session follows, flips blueprint's codex row, and proves
the whole path through an `install.sh --codex` install on the production catalog.

Everything it proves runs against the frozen fake codex: wiring proof, not runtime
certification. A live blueprint smoke is a separate step after wave 2 merges.

## Owners and the files a builder may edit

- graphs/blueprint/skills/blueprint/SKILL.md: one new section, below. No other byte of
  the file changes. Sections 1 to 8 keep the Claude path exactly as it is.
- spec/offering-capabilities.json: exactly the three changes below.
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

Nothing else changes: no module under core/, graphs/ or kit/ (blueprint-native.mjs,
blueprint-approve.mjs, write-docs.mjs, the host, provider, role loader, install-plan),
no workflow, role file, install.sh, autobuild or hunt edit. `install.sh --codex` derives
its targets from the catalog (CP-01c), so the flip alone makes it link `skills/blueprint`.

## The catalog changes

1. Blueprint's codex row becomes exactly
   `{implementation: 'partial', transportId: 'codex-graph-host',
   limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE']}`.
   `NO_PROVIDER_TRANSPORT` goes; `LIVE_PROOF_MISSING` comes, the same set autobuild and
   bughunt carry. Its claude row, `dependencies`, `evidenceOwners`, `proofRefs`,
   `requirementsComplete` (false) and `nativeReadiness` ('unknown') do not change.
2. `transports` gains a fourth row, after the three CP-01b pinned:
   `{id: 'codex-graph-host', provider: 'codex', entry: 'core/skills/native-runtime/graph-host.mjs'}`.
3. Blueprint's `entrySha256` becomes the sha256 of the new SKILL.md bytes.

No other byte changes. The derived values follow (CP-01a): blueprint is Codex
install-eligible and its `nativeImplementationOf` is `present-limited`.

### Why one shared transport

A transport's `entry` names the module that owns the transport (CP-01a). Blueprint
does not have its own: its leaves run through the CP-02e graph host and the CP-02b
provider, which every later host-run offering (dev at CP-06) uses too. One
`codex-graph-host` row serves all of them, so later flips add no transport and amend no
transport pin. The entry is graph-host.mjs because blueprint-native.mjs reaches Codex
only through `runGraphHost` (CP-04c imports). `checkCatalogDrift` already requires the
entry to be a regular file (`TRANSPORT_ENTRY_MISSING`), and inspectOffering reads it.

### Why the flip is safe now (unlike dev in CP-02f)

CP-02f kept dev `unavailable` because its SKILL.md could not run from Codex. Blueprint's
can after this feature: every stage has a native CLI, and the runner section below names
no Claude-only path. Its dependency closure (backlog, default-stack, knowledge-map,
native-runtime, run-records) lives under core/skills, so CP-03b's closure rule holds,
and install-plan verifies those sources without linking them (CP-01c).

## The Codex runner section

A section headed exactly `## Codex runner`, placed after the opening paragraphs and
before `## When to ask` (the bughunt SKILL.md has the same section). It says:

1. On Codex, the session drives the `blueprint-design` graph through the CLIs beside
   SKILL.md. It never invokes Claude or the Workflow tool, and never falls back to
   another provider. Sections 1 to 8 still say what to ask, show and report.
2. **The roots.** The first fenced `bash` block of the section, after every
   `<installed-skill-dir>` is replaced with the absolute path of the installed skill
   directory (a symlink), sets three shell variables and nothing else visible:
   - `SKILL_DIR`: the real directory holding SKILL.md (the symlink resolved);
   - `ROOT`: the installation root, four levels above `SKILL_DIR`;
   - `CODEX`: the absolute path of `codex` on `PATH`.
   It reads no `HOME`, `CLAUDE_CONFIG_DIR` or `.claude` path, and it runs only shell
   builtins plus `dirname`, `readlink` and `realpath`.
3. **The commands.** A fenced `bash` block holding both command forms:
   `node "$SKILL_DIR/blueprint-native.mjs" <verb> --args-file <file>` and
   `node "$SKILL_DIR/blueprint-approve.mjs" <show|approve> --args-file <file>`.
4. **The steps.** One table row per CLI verb, all nine: `start`, `interview`, `answer`,
   `design`, `gate`, `backlog`, `show`, `approve`, `edit`. Each row names the SKILL.md
   step it replaces and the args file keys (CP-04c and CP-04d tables). The three stage
   rows name `installationRoot` (`ROOT`), `codexBin` (`CODEX`), `env` and `timeoutMs`.
   The `approve` row names `approvalSha256`.
5. **The leaf environment.** `env` is the leaf's whole environment: `HOME`,
   `CODEX_HOME` when it is set, and `PATH`, copied from the session's. Nothing else is
   added, and never a secret.
6. **Outputs.** A stage prints `{status, file, invocationId, redacted}`; the session
   reads the questions, design or backlog from that file in the state directory, already
   redacted. Exit 1 is bad input, 2 a refusal, 3 a failure, 4 a busy run directory;
   stderr is one `{"error"}` line, which the session reports before it stops. A refused or
   failed stage is never retried with another provider.
7. **Approval.** `approve` runs only after the human chose `Approve` on the report
   `show` printed, with that report's hash (W2-7). It creates `integration/<app>` and
   commits there; it never pushes.
8. **Held leaves.** A stage that exits 3 `CHECKPOINT_UNCERTAIN` is never resumed. Running
   the stage again starts a new invocation (CP-04c).

The section contains no `~/.claude`, `$HOME/.claude`, `CLAUDE_CONFIG_DIR` or
`CLAUDE_SKILL_DIR` text.

## Not in scope

- Any change to the Claude path (sections 1 to 8), a module, the host, install.sh or
  install-plan.
- `requirementsComplete`, `nativeReadiness`, `supported`, or any other offering's row.
- `/build-app` on Codex; live codex; a retry, reroute or Claude fallback.

## Acceptance

acceptance/codex-parity/cp-04e-blueprint-codex.test.mjs (node:test, about 20 seconds).
It imports from and runs `PANDASTACK_CANDIDATE_ROOT` (default: the repo root). Owned temp
directories only; no network, real codex or claude. It never runs the repository's own
verify.sh or capture machinery (AGENTS.md); blueprint-design runs no verify.

Unlike CP-04c, the installation root is the candidate root itself: the production
catalog, unmodified. The fake is the frozen acceptance/codex-parity/cp-02f-fake-codex.cjs.

Cases:
1. **Catalog.** Blueprint's codex row, the four transports and blueprint's
   `entrySha256` are exactly as above. Its claude row, dependencies and proofRefs are
   as CP-04c left them (`dependencies` are the four ids CP-04c declares). Codex `partial`
   rows are exactly autobuild, blueprint and bughunt.
   `installEligible(blueprint, 'codex')` is true, `nativeImplementationOf` is
   `present-limited`, and `checkCatalogDrift` reports no problem.
2. **Install.** install-plan prints exactly three lines: autobuild, blueprint, bughunt.
   `install.sh --codex` with `PANDASTACK_CODEX_SKILLS_DIR` set to an owned directory and
   an owned empty `HOME` links `blueprint` to graphs/blueprint/skills/blueprint, creates
   no `.claude`, `.codex` or `.local` in `HOME`, and `--uninstall` removes the link.
3. **Readiness.** CP-01d's `inspectOffering` gives `ready` for blueprint on Codex only
   with an injected probe that reports support (wiring proof), and never without one.
4. **The section.** The `## Codex runner` section exists before `## When to ask`,
   names all nine verbs, both command forms, the four host keys and `approvalSha256`,
   and holds none of the Claude-only strings. Its first `bash` block, run through the
   installed symlink in an owned `HOME` with no `.claude` and a stub `codex` on `PATH`,
   prints `SKILL_DIR` equal to the real skill directory, `ROOT` equal to the candidate
   root's realpath and `CODEX` equal to the stub's path.
5. **The whole path on the production catalog.** Through the installed symlink
   (`<skills>/blueprint/blueprint-native.mjs` and `blueprint-approve.mjs`), with
   `installationRoot` the candidate root's realpath and `codexBin` the fake codex installed
   as `<bin>/codex`; at the end, the section's first `bash` block run with that `bin/` on
   `PATH` prints exactly those two values as `ROOT` and `CODEX`. `start` -> `interview` (`needs-human`)
   -> `answer` -> `design` (`design-ready`) -> `backlog` (`backlog-ready`) -> `show` ->
   `approve` with the hash `show` printed. Each step exits 0.
   - `approve` creates `integration/<app>` with one commit holding exactly the paths it
     printed. No push, no `gh` or `claude` call.
   - Every leaf: sandbox `read-only`, `--ignore-user-config` present, env exactly the
     args file's `env` (`HOME`, `PATH`, `FAKE_CODEX_DIR`), and an `--output-schema` file
     that is not the NR-01 wire schema but the leaf's strict schema (CP-02h: an object
     schema with `additionalProperties: false`).
   - The advisor's stdin names `<ROOT>/core/skills/backlog/SKILL.md` (CP-03d). With every
     occurrence of `<ROOT>` removed (a checkout may itself sit under a `.claude`
     directory), no leaf's stdin contains `.claude` or `CLAUDE_CONFIG_DIR`.
   - The owned `HOME` holds no `.claude` afterwards.

At this freeze (main plus the tier-1 to tier-3 freezes, CP-04c and CP-04d unbuilt) every
case fails. Against a tree with every other wave-2 feature built and not this one: case 1
fails on the codex row, case 2 on the two-line plan, case 3 on `PROVIDER_UNAVAILABLE`,
case 4 on the missing section, and case 5 at its install step: `install.sh --codex` links
no `blueprint` while the row is `unavailable`, so nothing can run through the installed
symlink. (With a hand-made link, the same tree stops at `interview` with exit 2
`OFFERING_UNSUPPORTED`; the test author checked this in a throwaway copy.)

Enforced by review, not by a case: that sections 1 to 8 are byte-identical (the
`entrySha256` pin covers the whole file, not which part changed); the prose of items 1, 5,
6, 7 and 8 beyond the strings case 4 checks.

## Amended pins (W2-10)

The freeze retires only the pins this flip changes, so each holds before and after it:
CP-01b (codex row, transports, derived values), CP-01c and tests/install-codex.test.mjs
(the installed set; CP-01c's sha of that file), CP-01d (the ready set), CP-03b (the
installed set), and the CP-02e and CP-04c refusal cases, whose fixture roots now set
blueprint `unavailable` themselves. This test pins the new state.
