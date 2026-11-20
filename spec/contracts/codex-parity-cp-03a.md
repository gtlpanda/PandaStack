# CP-03a: provider-neutral SKILL_DIR helper invocation

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125).
Depends on CP-01b (spec/contracts/codex-parity-cp-01b.md): its drift guard pins every
`entrySha256` to the SKILL.md bytes on disk, so this feature's SKILL.md edits and their
catalog hashes land together.

Four entry skills tell the session to run a bundled helper. On main (d80d9c5) three of
them name a Claude-only path and the fourth reads only a Claude variable:

| skill | helper | main's fenced commands |
|---|---|---|
| backlog | backlog.mjs | `node ~/.claude/skills/backlog/backlog.mjs ...` (2) |
| findings | findings.mjs | `node ~/.claude/skills/findings/findings.mjs ...` (3) |
| gtm-brief | gtm-brief.mjs | `node ~/.claude/skills/gtm-brief/gtm-brief.mjs ...` (1) |
| verify | verify.sh | `bash "${CLAUDE_SKILL_DIR}/verify.sh"` (1), with a prose fallback to `~/.claude/skills/verify/verify.sh` |

Under Codex there is no `~/.claude` and no Claude substitution, so none of them runs.
This feature rewrites those commands to one provider-neutral idiom. It changes no
helper code: every helper already runs through a symlink (its entry guard compares
`realpathSync` of argv[1] with its own file).

It certifies nothing. The four catalog rows stay codex `unavailable` and
non-install-eligible; making them installable under Codex is CP-01c/CP-03b work.

## Owners and the files a builder may edit

- core/skills/backlog/SKILL.md, core/skills/findings/SKILL.md,
  core/skills/gtm-brief/SKILL.md, core/skills/verify/SKILL.md: the fenced helper
  commands and the paragraph below. Nothing else in these files changes.
- spec/offering-capabilities.json (writable since tier A): exactly the four
  `entrySha256` values of the offerings `backlog`, `findings`, `gtm-brief` and
  `verify`, each set to the sha256 of its new SKILL.md bytes. No other byte changes.
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

No autobuild.json `writable` change is needed: `core/` is not frozen, and the catalog
is already in `writable`. The host lists this contract and its test in `frozen`, as for
every frozen pair.

## The idiom

### Fenced commands

Every fenced line in the four files that runs or names the helper is exactly

```
<interpreter> "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/<helper>"[ <tail>]
```

matching `^(node|bash) "\$\{SKILL_DIR:-\$\{CLAUDE_SKILL_DIR\}\}\/([A-Za-z0-9._-]+)"(?: (.*))?$`,
with `node` for the `.mjs` helpers and `bash` for verify.sh. The tails stay what main
documents, in the same order:

| skill | tails |
|---|---|
| backlog | `check docs/backlog.json`; `task docs/backlog.json S2 [build state dir]` |
| findings | `check <ledger.json>`; `save <ledger.json> <intake.json> <result.json> [--repo <tree>]`; `report <ledger.json> [evidence dir]` |
| gtm-brief | `check docs/gtm.md` |
| verify | none (the line ends at the closing quote) |

A fenced line "runs or names the helper" when it contains `SKILL_DIR`, `.claude`,
`.agents`, `skills/` or the helper's file name, or starts with `node`, `bash` or `sh`.

Why this shape:
- Claude Code substitutes the exact text `${CLAUDE_SKILL_DIR}` in a skill's markdown
  with the skill's directory (Claude Code docs, "Available string substitutions").
  Kept as that exact token, nested as the default of `${SKILL_DIR:-...}`, the command
  becomes `"${SKILL_DIR:-/abs/skill/dir}/<helper>"` after substitution, which bash runs
  as written. If the variable is set in the environment instead, the same line works.
- Under Codex nothing substitutes it, and the caller sets `SKILL_DIR`. A set
  `SKILL_DIR` wins in both hosts.
- The reversed order (`${CLAUDE_SKILL_DIR:-$SKILL_DIR}`) is wrong: after substitution it
  becomes `${/abs/dir:-...}`, a bash syntax error.

### The paragraph

Each of the four files carries this paragraph, identical bytes up to line wrapping
(the test collapses whitespace before comparing). It is the documented fallback:

> `SKILL_DIR` is the directory that holds this SKILL.md. Claude Code fills it in
> through its `CLAUDE_SKILL_DIR` substitution, so there the helper commands in
> this file run as written. Anywhere else (Codex, or this file read without that
> substitution), start each command with `SKILL_DIR='<dir>';`, where `<dir>` is
> the absolute path of the folder that holds this SKILL.md. A set `SKILL_DIR`
> wins. With neither set, the command fails.

In verify it replaces main's parenthesis about `CLAUDE_SKILL_DIR` and
`~/.claude/skills/verify/verify.sh`; the sentence about passing a directory as the
first argument stays.

Note on the `SKILL_DIR='<dir>';` form: it is a separate statement, not an env prefix.
`SKILL_DIR=x node "${SKILL_DIR...}"` would expand the old value, because bash expands
arguments before it applies a prefix assignment.

### File-wide rules

- No `.claude` appears anywhere in the four files, prose included. (Stricter than the
  priority bullet, which names fenced commands, so no prose fallback can send a
  session to `~/.claude`.)
- `${CLAUDE_SKILL_DIR}` appears only inside idiom lines: once per idiom line, never in
  prose (Claude Code would substitute a prose copy too). `CLAUDE_SKILL_DIR` is never
  read in another form (`$CLAUDE_SKILL_DIR`, `${CLAUDE_SKILL_DIR:-...}`).
- No relative or project-local lookup: the idiom never consults the working directory,
  a project `.claude/skills` or `.agents/skills`, or `$HOME`. A target repository may
  ship its own copy of a helper, which would run as the user.

## Constraints from frozen readers of these files

The builder keeps all of these true; each is checked by a frozen test or script:
- tests/backlog.test.mjs parses the first ```` ```json ```` fence of backlog/SKILL.md as a valid backlog.
- tests/gtm-brief.test.mjs parses the first ```` ```markdown ```` fence of gtm-brief/SKILL.md as the template.
- scripts/validate.sh `rule` lines pin these sentences: gtm-brief "Read the brief and
  never edit it." and "Never invent the"; backlog "nothing else writes it" and
  "A goal never says \"stop and ask\""; findings "never from what an agent said".
- scripts/check-refs.mjs: any new backticked `/name` must resolve.
- CP-01b dependency rule 2: any `skills/<other-id>/` text added to one of these files
  derives a dependency edge and turns the drift guard red (`DEPENDENCY_UNDECLARED`).
  Do not mention another skill's path. (A self mention is not an edge.)

## OC-01 (host edit, applied in the freeze commit)

acceptance/native-runtime/oc-01-catalog.test.mjs pins every SKILL.md hash through its
frozen fixture (first test, line 19). With this feature built it fails there, at the
first edited offering in catalog order (backlog: fixture 9a3415be... against disk).
The priority contract ("OC-01 snapshot") retires that one assertion. The host deletes
only `assert.equal(entry.entrySha256,entry.entrySkill?sha(readFileSync(skill)):null);`
from line 19 and keeps `assert.equal(entry.entrySkill,existsSync(skill));`. `sha` and
`readFileSync` stay used elsewhere in the file. The fixture file
(oc-01-catalog.fixture.json) stays unchanged: CP-01a, CP-01b and
tests/native-catalog-v2.test.mjs read it as the v1 reference. The builder never edits
OC-01.

With that edit OC-01 passes 8 of 8 on main + tier A (freeze worktree, v1 catalog) and on
the CP-03a reference.

## Not in scope

- No helper code change (backlog.mjs, findings.mjs, gtm-brief.mjs, verify.sh,
  retention.mjs and the rest), including their comments.
- No change to install.sh, install-plan, the catalog's provider rows, eligibility or
  dependencies.
- No other SKILL.md (render and seo-check still hard-code `~/.claude`; later batches).
- No claim that Codex shows a skill's path to the session, or that Claude Code
  substitutes a token nested inside `${SKILL_DIR:-...}`. Both are untested hypotheses
  here: the test models Claude Code's documented text substitution and the variable
  form, and models the Codex caller setting `SKILL_DIR`. Neither host is run.
- A skill directory whose absolute path contains a single quote is not supported by
  the `SKILL_DIR='<dir>';` form. Not tested.

## Acceptance

acceptance/codex-parity/cp-03a-skill-dir.test.mjs (node:test, about 11 s on macOS). It
reads the four SKILL.md files under `PANDASTACK_CANDIDATE_ROOT` (default: the repo
root) and runs their documented commands for real through `bash -c`, in owned temp
directories. Each run has an env built from scratch: `PATH`, a temp `HOME` whose path
contains a space, a temp `TMPDIR`, `LC_ALL=C`. Never the real HOME, no network, no
npm, no provider. Each work tree holds decoy helpers (printing `DECOY`) at `./`,
`.claude/skills/<name>/`, `.agents/skills/<name>/` and `skills/<name>/`; none may run.

17 top-level cases:
- 4 static cases, one per file: every helper line matches the idiom with its
  interpreter and helper; the tails equal the table; no `.claude`; `${CLAUDE_SKILL_DIR}`
  only inside idiom lines; the paragraph is present.
- 4 Codex cases: HOME holds only `.agents/skills/<name>` -> `<root>/core/skills/<name>`,
  `CLAUDE_SKILL_DIR` is unset, and each command runs as `SKILL_DIR='<link>'; <command>`.
  The documented exits hold (below), stderr has no module-not-found, and HOME still
  has no `.claude` afterwards.
- 4 Claude cases: HOME holds `.claude/skills/<name>`. main's command (from the table
  above, with `${CLAUDE_SKILL_DIR}` replaced) is the baseline. The new command with
  `${CLAUDE_SKILL_DIR}` replaced by the link, and with `CLAUDE_SKILL_DIR` set in the
  environment, give the same exit and last stdout line for every step.
- 4 fail-closed cases: with neither variable each command exits non-zero, prints no
  verdict line and writes nothing; with `SKILL_DIR` set, a `CLAUDE_SKILL_DIR` (variable
  or substituted) pointing at a decoy copy is not used.
- 1 catalog case: the four `entrySha256` equal sha256 of the SKILL.md bytes, and
  `checkCatalogDrift({ installationRoot })` deep-equals `{ ok: true, problems: [] }`.

Documented exits exercised (every layout):
- backlog: `check` of a valid file 0 `BACKLOG: PASS`; invalid 1 `BACKLOG: FAIL`;
  `task docs/backlog.json S2` and with a state dir 0 with JSON `slice: "S2"`; `check`
  with no path 2.
- findings: `save` 0 `FINDINGS: SAVED 0 finding(s), disposition ...`; `check` 0
  `FINDINGS: PASS`; `report` 0 with `# Bug hunt: PR #7`; a broken ledger 1
  `FINDINGS: FAIL`; `report` of a missing ledger 1; `report` alone 2.
- gtm-brief: a complete brief 0 `GTM-BRIEF: PASS`; one missing a section 1 `GTM-BRIEF: FAIL`.
- verify (D123, platform-aware): a project whose executable `scripts/test.sh` exits 0
  gives 0, `[0] scripts/test.sh` and `VERIFY: PASS`; the same command with the
  directory argument `failing` (its test exits 3) gives 1, `[3] scripts/test.sh` and
  `VERIFY: FAIL`. On Linux (`process.platform === 'linux'`, D123's `OWNED_CAPTURE`) the
  output has no `capture: direct`. Elsewhere the line
  `  capture: direct (no /proc on this platform: steps ran without process-group ownership)`
  sits directly above the verdict.

Freeze results:
- On the freeze worktree (main + tier-A freezes, nothing built) it fails 17 of 17. 16
  fail because main's fenced commands do not match the idiom (the feature's reason). The
  catalog case passes its four hash checks (the v1 hashes match the unedited files) and
  fails only because `checkCatalogDrift` is not exported: CP-01b is not built (a
  dependency reason, not this feature's).
- On the reference (tier-A reference + this feature) it passes 17 of 17, 3 times serial
  and 3 times in parallel. The Linux branch of the verify check has not been run
  (macOS only); it is an untested hypothesis until CI runs it.
