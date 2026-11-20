# CP-03d: provider-neutral skill paths in role bodies

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125),
wave 2, root decision W2-4: role-body skill paths are resolved by the role loader.
It amends CP-03c (spec/contracts/codex-parity-cp-03c.md), whose loader it changes.

Motivation (live smoke, 2026-11-20). The checker ran
`bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/verify/verify.sh"` in a Codex HOME.
There is no `.claude` directory there, so bash exited 127 and the graph escalated.
The host adds nothing to a leaf's environment (CP-02f pins the leaf env keys), so
an environment variable cannot carry the path. The loader rewrites the path in the
text instead.

## Owners and the files a builder may edit

- core/skills/native-runtime/role-files.mjs: `assembleRoleInstructions` rewrites
  skill-path tokens (below). `listRoleFiles` and `loadRoleFile` do not change.
- The four role files that name an installed skill path: core/agents/checker.md
  (line 12), graphs/qa/agents/fixer.md (line 19), graphs/dev/agents/implementer.md
  (line 48) and core/agents/advisor.md (line 149). Each path becomes the token. No
  other byte of a role file changes.
- tests/native-graph-host.test.mjs (an implementation test, not frozen): its
  `copyFixture` copies every regular file of each skill directory, not only
  `SKILL.md`, so the fixture holds `core/skills/verify/verify.sh`.
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

core/skills/verify/verify.sh does not change. It finds its helpers from its own
location (`BASH_SOURCE[0]`), so it runs the same from any path.

## Role files in scope

A grep of every role file under core/agents, kit/agents and graphs/*/agents for
`.claude`, `CLAUDE_CONFIG_DIR` or `~/.claude` finds 13 lines:

| file | line | text | decision |
|---|---|---|---|
| core/agents/checker.md | 12 | `bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/verify/verify.sh"` | token |
| graphs/qa/agents/fixer.md | 19 | same command | token |
| graphs/dev/agents/implementer.md | 48 | same command | token |
| core/agents/advisor.md | 149 | `~/.claude/skills/backlog/SKILL.md` (a mention, not a command) | token |
| 9 kit/agents files | one line each | `~/.claude/agent-memory/<name>/` | out of scope: agent memory is CP-11 |

The hunt roles have no such line. The shared advisor role is in every graph, so its
mention is in scope. No SKILL.md inlined into a role of harness-repair,
blueprint-design or dev-build has such a line today.

## The token

In a role file the path is written as:

```
${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/<id>/<file>}
```

- `<id>` matches `[a-z0-9][a-z0-9-]{0,63}` (CP-03c's role and skill name pattern).
- `<file>` matches `[A-Za-z0-9._-]+`: one path segment (CP-03b's segment class).
- The match is exact. The loader uses this regex, with the `g` flag:
  `/\$\{PANDASTACK_SKILL_PATH:-\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}\/skills\/([a-z0-9][a-z0-9-]{0,63})\/([A-Za-z0-9._-]+)\}/g`

The token is a valid shell expression. Its default is today's path, so the role file
behaves the same under Claude Code, which reads the raw file. Under bash and sh, with
`PANDASTACK_SKILL_PATH` unset, it expands exactly as
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/<id>/<file>` does: `$HOME/.claude/...`
when `CLAUDE_CONFIG_DIR` is unset or empty, `$CLAUDE_CONFIG_DIR/...` otherwise.

Nothing in PandaStack sets `PANDASTACK_SKILL_PATH`. It is the token's marker, not a
supported setting. A user who sets it changes every token's expansion under Claude.

The four edits are, exactly:
- checker, fixer, implementer:
  `${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/verify/verify.sh}`
  replaces `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/verify/verify.sh` inside the
  existing `bash "..."`.
- advisor: `${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/backlog/SKILL.md}`
  replaces `~/.claude/skills/backlog/SKILL.md` inside the existing backticks.

## Rewrite rule

`assembleRoleInstructions({ installationRoot, name })` builds the CP-03c text
`[body, ...skills.map(s => s.body)].join('\n')` (or `body` alone), then replaces every
exact token match in that whole text. Each match becomes

```
join(installationRoot, <skills dir>, <id>, <file>)
```

with node:path `join`, so a trailing slash on the root does not double. `<skills dir>`
is `core/skills`, `kit/skills` or `graphs/<g>/skills`, whichever holds the skill.
So for the checker the instructions contain `bash "<root>/core/skills/verify/verify.sh"`.

- `body` and every `skills[].body` stay raw. Only `instructions` is rewritten. CP-03b
  reads raw bodies: the substring `skills/verify/verify.sh` (and
  `skills/backlog/SKILL.md` for the advisor) keeps its derived edge and its
  path-exists rule.
- A token in an inlined SKILL.md body is rewritten too. None exists today.
- Text that is not an exact match is left as it is, and nothing is looked up for it:
  an extra space, another variable name, `${HOME}`, bare `$HOME/.claude/...`,
  `~/.claude/...`, today's `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/...` form, an id
  outside the pattern (uppercase, over 64 characters), or a nested path.
- With no token, `instructions` is byte-for-byte what CP-03c produced. The hunter has
  no token, so its assembly still equals the hunt runner's strip plus the bug-lenses
  body.

### Lookup

For each match, in text order:
1. The skill is located as CP-03c's `resolveSkill` does: a real directory `<id>` with
   a regular `SKILL.md`, under one of the skills roots. Zero hits is
   `UNKNOWN_SKILL`. More than one is `DUPLICATE_SKILL`. A directory without
   `SKILL.md` is not a skill, even if it holds `<file>`.
2. `<file>` must be a regular file directly in that directory, judged by the
   directory listing (lstat kinds). A missing name, a symlink, a directory, `.` and
   `..` are all absent: `UNKNOWN_SKILL`. One code for every unresolved target follows
   CP-03c's rule that a non-regular file counts as absent.
3. Any other filesystem failure while listing (EACCES, EIO) is `IO_ERROR`.

The file's bytes are not read.

### Root characters

The root is spliced into text a leaf runs inside `bash "..."`. When the text holds at
least one token, and before any lookup, `installationRoot` must not contain `"`, `$`,
a backtick, a backslash or a newline. Those are the characters that are special
inside double quotes, plus the line break. Any of them is `INVALID_ROLE_ROOT`.

The check runs only when there is a token. A role without one assembles under any
absolute root, as in CP-03c. `listRoleFiles` and `loadRoleFile` never apply it.

### Errors

Only CP-03c's existing codes, through boundary.mjs `fail`. The message is exactly
`Native runtime: <CODE>.`: no root, id, file name or text is echoed. `loadRoleFile`
never fails because of a token; it returns the raw body.

## Who else reads role text

- CP-02e graph host: `roleInstructions` calls `assembleRoleInstructions`, so leaves get
  the rewritten text. The host adds nothing to the leaf environment.
- CP-02f fake codex: it identifies a spawn's role by `assembleRoleInstructions(...)
  .instructions + '\n\n'` on the same fixture root the host uses, so the prefixes
  still match.
- The catalog: agent files have no hashes. `assets` rows are `{ target, source, kind }`.
  spec/codex-parity-inventory.json `otherInstallerAssets[].sha256` is a historical
  snapshot. It goes stale for these four files by design. Only OC-01 reads that array,
  and it maps `{ target, source, kind }`; no test compares those hashes with disk.
- scripts/validate.sh fixed-string rules on implementer.md and advisor.md do not touch
  the edited lines. install.sh links role files unchanged.

## Host amendments to frozen tests (applied with this freeze)

They keep every frozen test green on main and make it green once this feature is
built. Each was run on main and on the reference.

1. acceptance/codex-parity/cp-03c-role-files.test.mjs, case "every shipped role
   inlines each declared skill once, in declared order": the two byte equalities
   (`instructions` equals the stripped text plus skill bodies, and equals the body when
   no skill is declared) skip a role whose file contains `${PANDASTACK_SKILL_PATH:-`.
   This feature's test pins those roles' exact text instead. On main no role has the
   token, so the case is unchanged there.
2. spec/contracts/codex-parity-cp-03c.md, after the `instructions` code block, one
   sentence: "Amended by CP-03d (spec/contracts/codex-parity-cp-03d.md): `instructions`
   is this text with skill-path tokens rewritten; `body` and `skills[].body` are
   unchanged." Without it the two frozen contracts disagree once this is built.
3. acceptance/codex-parity/cp-02e-graph-host.test.mjs and
   acceptance/codex-parity/cp-02f-native-graphs.test.mjs, `copyTree`: copy every
   regular file directly in each skill directory, not only `SKILL.md`. Without
   `core/skills/verify/verify.sh` in the fixture root, assembling the checker fails
   closed and the host refuses the run.

## Not in scope

- kit agent-memory paths (CP-11). Paths in SKILL.md files (CP-03a and later
  batches). Installed-layout readers. Any change to verify.sh, the hunt runner, the
  catalog or install.sh.
- Setting `PANDASTACK_SKILL_PATH` anywhere, or any change to a leaf's environment.
- Multi-segment paths (`skills/<id>/a/b`).
- Live proof. The bash cases are run against fixture files; they are wiring proof, not
  runtime certification.

## Acceptance

acceptance/codex-parity/cp-03d-skill-paths.test.mjs (node:test). Real-tree cases read
the shipped role files, SKILL.md files and catalog under `PANDASTACK_CANDIDATE_ROOT`
(default: the repo root) and derive the role sets from the catalog `workflows` rows.
Fixture cases use owned temp roots. Shell cases run `bash` and `sh` with an explicit
environment (a temp HOME and PATH only). No real HOME, network or provider.

Cases:
1. checker, fixer and implementer: `instructions` contains
   `bash "<root>/core/skills/verify/verify.sh"`; their raw `body` contains the verify
   token; the advisor's `instructions` contains `<root>/core/skills/backlog/SKILL.md`
   and its `body` the backlog token.
2. No role of harness-repair, blueprint-design or dev-build has `.claude`,
   `CLAUDE_CONFIG_DIR` or `PANDASTACK_SKILL_PATH` in its `instructions`.
3. Every shipped role assembles. Its `instructions` equals the test's own rewrite of
   the CP-03c text, its `body` equals the runner strip, and the hunter assembly equals
   the strip plus the bug-lenses body.
4. CP-03b still holds on raw bodies: the mention regex finds `skills/verify/verify.sh`
   in checker, fixer and implementer and `skills/backlog/SKILL.md` in the advisor, and
   those files exist.
5. The shipped token expands under bash and sh exactly as today's form, with HOME only,
   with `CLAUDE_CONFIG_DIR` set, and with it empty.
6. Fixture: tokens in core, kit and graph skills, repeated tokens, a token in a
   SKILL.md and a trailing-slash root are rewritten; `body` and `skills[].body` stay
   raw.
7. Fixture: a rewritten command runs the skill file in a HOME with no `.claude`; the
   raw command exits 127 there and runs the Claude-layout copy when HOME has one.
8. Fixture: near-miss text is untouched and never looked up.
9. Fixture: unknown skill, missing file, symlinked file, directory named like the file,
   `.` and `..`, a skill directory without `SKILL.md`, a symlinked skill directory and
   a duplicate skill each fail closed with the fixed code and no path echoed;
   `loadRoleFile` still loads each role.
10. Fixture: a root containing each of the five characters is `INVALID_ROLE_ROOT` for a
    tokened role, checked before lookup; a role without a token still assembles there.
11. Fixture: an unreadable target file still resolves (its bytes are never read); an
    unreadable skill directory is `IO_ERROR` (both skipped when run as root).
