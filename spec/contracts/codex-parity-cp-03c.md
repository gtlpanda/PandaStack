# CP-03c: role-file loader with skills inlining

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125).
Claude Code preloads the skills named in a role file's `skills:` frontmatter into the
subagent. A Codex leaf has no such mechanism, so a native host must build the same
instruction text itself. This feature adds the one module that locates a role file,
parses its frontmatter and assembles the leaf instructions. It does not choose a
model, a sandbox or a profile (CP-02c), spawn anything (CP-02b), or change any role
or SKILL.md file.

## Owners

- core/skills/native-runtime/role-files.mjs (new): owns the role-file format
  (frontmatter keys and grammar), where role files and skill directories live, and the
  assembly of leaf instructions. Later callers import it; none re-parses frontmatter.
- core/skills/native-runtime/boundary.mjs: `fail(code)` throws the module family's
  error (`Error` with `code`, message `Native runtime: <CODE>.`). The loader imports it
  and defines no error class of its own.

The hunt runner's private `agentInstructions` (graphs/hunt/skills/bughunt/native-runner.mjs,
line 119) is not exported and is not changed. Its strip rule is re-derived here (below)
and the acceptance test reads that file's source to detect drift.

## Layout it reads

All paths are relative to `installationRoot`, which is the repository (source) tree.
The installed `~/.claude` layout is out of scope.

- Role files: `core/agents/<name>.md`, `kit/agents/<name>.md`,
  `graphs/<g>/agents/<name>.md` for every directory `graphs/<g>`. A missing `agents`
  directory is skipped. Today that is 37 files in 8 directories: 2 in core, 10 in kit,
  25 under graphs (blueprint, dev, hunt, qa, release, security-audit). Names are
  unique today.
- Skills: `core/skills/<s>/SKILL.md`, `kit/skills/<s>/SKILL.md`,
  `graphs/<g>/skills/<s>/SKILL.md`. A directory without `SKILL.md` is not a skill
  (`core/skills/decisions` and `core/skills/native-runtime` are examples).
- Only regular files count. A symlinked role file or `SKILL.md` is treated as absent,
  so a link can never pull in bytes from outside the tree.

## Exports

```js
export const ROLE_FRONTMATTER_KEYS      // frozen array, exactly:
// ['name', 'description', 'model', 'effort', 'tools', 'skills', 'memory']

export function listRoleFiles({ installationRoot })
// -> [{ name, path, root }] sorted by `path`. `path` is POSIX-relative, e.g.
//    'graphs/hunt/agents/hunter.md'. `root` is 'core' | 'kit' | 'graphs/<g>'.

export function loadRoleFile({ installationRoot, name })
// -> { name, path, root, frontmatter, body }

export function assembleRoleInstructions({ installationRoot, name })
// -> { name, path, root, frontmatter, body, skills, instructions }
//    skills: [{ name, path, body }] in declared order.
```

Amended by CP-03d (spec/contracts/codex-parity-cp-03d.md): `instructions` is this text with
skill-path tokens rewritten; `body` and `skills[].body` are unchanged.

All three are synchronous and read only the files they name. Arguments are one
options object. `installationRoot` must be an absolute string, else
INVALID_ROLE_ROOT.

`ROLE_FRONTMATTER_KEYS` is the set of keys that actually appear in the 37 shipped files
(counts today: name 37, description 37, model 37, effort 27, tools 27, skills 8,
memory 10). No key outside it is allowed.

## Errors

Every failure throws through boundary.mjs `fail`, with these fixed codes. The message
never echoes the requested name, a path or any file content.

| Code | When |
|---|---|
| INVALID_ROLE_ROOT | `installationRoot` is not an absolute string |
| INVALID_ROLE_NAME | requested name is not a string matching `^[a-z0-9][a-z0-9-]{0,63}$`: this covers `/`, `..`, a newline, empty, uppercase and non-strings. Checked before any file access. Also raised by `listRoleFiles` for an agents-directory `.md` file whose stem fails that pattern |
| ROLE_NOT_FOUND | no regular `<name>.md` in any agents directory |
| DUPLICATE_ROLE | the same stem exists in more than one agents directory. `loadRoleFile` checks the requested name; `listRoleFiles` checks all names |
| INVALID_ROLE_FRONTMATTER | any parse rule below is broken |
| UNKNOWN_SKILL | a declared skill has no directory with a regular `SKILL.md` in any skills root |
| DUPLICATE_SKILL | a declared skill name has a `SKILL.md` in more than one skills root |
| INVALID_SKILL_FILE | a `SKILL.md` has no complete frontmatter block (cannot be stripped), or its bytes are not valid UTF-8 |
| INVALID_ROLE_FILE | a role file's bytes are not valid UTF-8 |
| IO_ERROR | any other filesystem failure while listing an agents or skills directory or reading a role or `SKILL.md` file (EACCES, EIO). The raw system error never reaches the caller |

Both kinds of file are decoded with a fatal UTF-8 decoder
(`new TextDecoder('utf-8', { fatal: true })`). Invalid bytes are never replaced
silently.

The loader throws instead of returning a problem list (as the CP-01a validator does)
because a missing or malformed role has no partial result a caller could use safely.

## Parse rules

1. The file is UTF-8 text. It must match `/^---\n([\s\S]*?)\n---\n/`. This is the hunt
   runner's own delimiter rule, so the loader and the runner cut at the same byte. No
   match (no opening `---`, or no closing `---` line terminated by a newline, or an
   empty block) is INVALID_ROLE_FRONTMATTER. A carriage return anywhere in the
   frontmatter block is INVALID_ROLE_FRONTMATTER.
2. `body` is `text.replace(/^---\n[\s\S]*?\n---\n/, '')`: everything after the closing
   `---\n`, untrimmed. Every shipped body starts with `\n`; trimming would break
   parity with the runner.
3. Each frontmatter line is `key: value`, split at the first `:`, with the value
   trimmed. The key must be in `ROLE_FRONTMATTER_KEYS` and must not repeat. A blank
   line, a line without `:`, or an unknown key is INVALID_ROLE_FRONTMATTER.
4. Required keys: `name`, `description`, `model`. Their values must be non-empty. `name`
   must equal the file's stem, so "locate by name" and "duplicate role name" mean the
   same thing. Optional keys, when present, must also be non-empty.
5. `description`, `model`, `effort` and `memory` are the raw remainder of the line. No
   unquoting and no unescape. (Ten kit files write `description` as a double-quoted
   string with backslash escapes, and not consistently: `\n` in one file, `\\n` in
   another. The loader is YAML-ish, not YAML, and a leaf needs only the body.) The
   values of `model`, `effort` and `memory` are not validated here; CP-02c maps them.
6. `tools` is inline, comma separated: split on `,`, trim each, no empty element
   (INVALID_ROLE_FRONTMATTER otherwise). Order is kept.
7. `skills` is a block list only: the line `skills:` with an empty value, then one or
   more lines of exactly two spaces, `- `, and a name. An inline value after `skills:`,
   an empty list, a `  - ` line that does not follow `skills:`, or a repeated name is
   INVALID_ROLE_FRONTMATTER. Each entry must match the same pattern as a role name, so
   an entry containing `/`, `..` or a newline is INVALID_ROLE_FRONTMATTER (it is never
   used to build a path).
8. Absent optional keys give `frontmatter` these values: `effort: null`,
   `tools: []`, `skills: []`, `memory: null`. `frontmatter` always has exactly the keys
   `name, description, model, effort, tools, skills, memory`.

## Skill resolution and assembly

`assembleRoleInstructions` calls `loadRoleFile`, then resolves each entry of
`frontmatter.skills` in declared order by looking for `SKILL.md` under the three skills
roots. Zero matches is UNKNOWN_SKILL; more than one is DUPLICATE_SKILL. `loadRoleFile`
alone never touches a skill.

A skill's `body` is its `SKILL.md` with the frontmatter block removed by the same
regex as rule 2, then leading newlines removed (`.replace(/^\n+/, '')`), otherwise
untrimmed. A `SKILL.md` the regex does not match is INVALID_SKILL_FILE.

**Decision: the SKILL.md frontmatter is stripped.** `name` and `description` are routing
metadata for skill discovery. Claude's preload hands the subagent the skill's content,
and a leaf that sees a stray `---` block would read it as part of its own instructions.
The assembled text has no frontmatter block at all.

`instructions` is exactly:

```
body                                   when skills is empty
[body, ...skills.map(s => s.body)].join('\n')   otherwise
```

So each skill body comes once, after the role body, in declared order, separated by a
single `\n` (a blank line, since every body ends in a newline).

## Parity with the hunt runner

`assembleRoleInstructions(...).body` for any role equals what `agentInstructions(role)`
in graphs/hunt/skills/bughunt/native-runner.mjs returns for the same file, because both
apply the regex of rule 2. `agentInstructions` is module-private, so the rule is
re-derived here rather than imported. The acceptance test applies the runner's regex to
every shipped role file and also asserts the runner's source still contains that exact
`replace(...)` call, so a change on either side fails the test.

## Not in scope

- No role-to-profile or model/effort mapping (CP-02c). No validation of `model`,
  `effort` or `memory` values. No `tools`-to-sandbox mapping.
- No provider, spawn or prompt wrapper. `instructions` is the instruction text only;
  the host adds the task prompt and its own contract.
- No installed-layout (`~/.claude/agents`) reader. No change to the hunt runner, any
  role file or any SKILL.md.
- No full YAML. Anchors, multi-line scalars, flow lists and quoting are not supported
  and are INVALID_ROLE_FRONTMATTER where they break the grammar above.

## Acceptance

acceptance/codex-parity/cp-03c-role-files.test.mjs (node:test). Real-tree cases read
the shipped files and derive every expectation from disk (the role count is computed
by walking the three agents patterns, not written in the test). Negative cases build
fixture installation roots in owned temp directories.
