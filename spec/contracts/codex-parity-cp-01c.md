# CP-01c: Codex install plan from the catalog

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125).
Depends on CP-01b (spec/contracts/codex-parity-cp-01b.md): the v2 production catalog
and its declared `dependencies`. This feature adds one module, `install-plan.mjs`, that
turns the catalog into the list of Codex install targets. `install.sh --codex` then
takes its targets, its `dest_of` mapping and its backup allow-check from that list
instead of a fixed pair. The installed set does not change: today the plan is exactly
autobuild and bughunt.

Amended at the tier-4 freeze (CP-04e, W2-10): CP-04e makes blueprint Codex install-eligible. The
candidate-root case accepts exactly the two-line plan or CP-04e's three-line plan, every
fixture root sets blueprint's codex row `unavailable` itself, and tests/install-codex.test.mjs
is amended the same way (its sha256 in this test follows). CP-04e's test pins the
three-line plan.

It does not change the catalog, the validator, the accessors, the drift guard,
preflight (CP-01d) or any SKILL.md (CP-03a). It certifies nothing.

## Owners and the files a builder may edit

- core/skills/native-runtime/install-plan.mjs (new): the export `installPlan` and the
  CLI below.
- install.sh: only its `--codex` paths (rules below), plus the usage line for
  `--codex` in its header comment.
- README.md: the "For Codex" paragraph, which today names the two skills and the
  accepted `--skip` names. It must say the set comes from the catalog (today autobuild
  and bughunt).
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

Nothing else changes. In particular the frozen tests/install-codex.test.mjs and
scripts/test-install.sh are not edited, and spec/offering-capabilities.json is not
edited.

install-plan.mjs imports only `node:` builtins and modules in its own directory,
core/skills/native-runtime/. It imports, and never copies, `loadOfferingCatalog` and
`installEligible` from ./catalog.mjs. A same-directory import is a self edge, which
CP-01b's rule 3 skips, so the catalog's declared dependencies stay valid. It never
calls `checkCatalogDrift`: an installer must not refuse because a SKILL.md hash
drifted. It reads no SKILL.md and writes nothing.

## `installPlan({ installationRoot, backend }) -> Array<{ dest, src }>`

Exported from core/skills/native-runtime/install-plan.mjs. Synchronous.

Input:
- The option object is a plain object (boundary.mjs `fields` rules: own enumerable
  data properties, Object or null prototype, no proxy, so no getter runs) with exactly
  the keys `installationRoot` and `backend`.
- `installationRoot` is a non-empty string, an absolute path, at most 4096 bytes, with
  no control character (U+0000-U+001F, U+007F-U+009F).
- `backend` is exactly `'codex'`. Claude installs do not use the catalog in this
  feature, so `'claude'` is refused like any other value.
- Anything else throws `INVALID_INSTALL_PLAN_INPUT` before any filesystem access.

Load:
- It calls `loadOfferingCatalog({ installationRoot })` and lets its errors through
  unchanged: `INVALID_CATALOG_INPUT` (for example, the root is a regular file),
  `NOT_FOUND`, `INVALID_CATALOG`, `IO_ERROR`.
- Both catalog versions are accepted. v1 and v2 differ only through the accessor.

Entries:
- An offering is planned when `installEligible(offering, backend)` is true.
- `installerTargets[].codexInstaller` is never read. It is v1 data that the v2
  `providers` rows replace. A catalog where the two disagree follows `installEligible`.
- Each planned offering gives one entry per `installTargets` item:
  `{ dest: <the target>, src: <offering.source> }`. Both are root-relative POSIX paths
  exactly as the catalog stores them. The validator already guarantees each target is
  `skills/<name>` and unique.
- The result is sorted by `dest` in code-unit order. Catalog row order does not matter.
- An empty result is valid.
- Each entry is a plain object with exactly the keys `dest` and `src`.
- A planned offering's own `source` is not checked. install.sh keeps its existing
  `skip (missing in repo)` behavior for a missing entry source.

Dependencies:
- The dependency set is the transitive closure of `dependencies` from every planned
  offering. The catalog validator already rejects cycles and dangling ids.
- Each offering in that set must have its `source` as a real directory under the
  canonical root (`realpathSync(installationRoot)`). "Real directory" means `lstat` of
  `<canonical root>/<source>` reports a directory: a symlink, a regular file or a
  missing path is not one. Intermediate path components are not checked. This is a
  static check, not protection against concurrent replacement.
- A source that is not a real directory, or whose `lstat` fails with ENOENT or
  ENOTDIR, throws `DEPENDENCY_MISSING`. Any other `lstat` failure throws `IO_ERROR`.
- Dependencies are verified, never planned. A dependency appears in the result only
  when it is itself install-eligible.

Errors:
- Every error is an `Error` whose `code` is one of the fixed strings above.
- The message never echoes input, a path or file content.
- The result for an unchanged root is the same on every call.

## CLI

```
node core/skills/native-runtime/install-plan.mjs --installation-root <absolute path> --backend codex
```

- It runs only when the file is the process entry point. Importing it has no side
  effect and prints nothing.
- argv is exactly those two flags, each once, in either order, each followed by its
  value as the next argument. `--flag=value`, an unknown flag, a repeated flag, a
  missing value or an extra argument is `INVALID_INSTALL_PLAN_INPUT`. The values are
  then checked by `installPlan`.
- Success: exit 0. stdout is one line per entry, `<dest>\t<src>\n`, in result order,
  and nothing else. stderr is empty.
- Failure: stdout is empty. stderr is exactly one line, `install-plan: <CODE>\n`.
  - `INVALID_INSTALL_PLAN_INPUT` exits 1.
  - Every other code exits 2: `DEPENDENCY_MISSING`, `NOT_FOUND`, `INVALID_CATALOG`,
    `IO_ERROR`, `INVALID_CATALOG_INPUT`.
  - An error without one of these codes is reported as `IO_ERROR` and exits 2.

For the production catalog it prints exactly:

```
skills/autobuild	graphs/autobuild/skills/autobuild
skills/bughunt	graphs/hunt/skills/bughunt
```

## install.sh `--codex`

Claude mode is unchanged and never runs the plan. In `--codex` mode, for install,
`--dry-run` and `--uninstall` alike:

1. **One plan per run.** install.sh runs
   `node "$REPO_DIR/core/skills/native-runtime/install-plan.mjs" --installation-root "$REPO_DIR" --backend codex`
   exactly once per invocation, before it creates, changes or removes any file or
   directory. `node` is taken from PATH. Every value stays quoted, so roots with
   spaces or colons work.
2. **No node.** With no `node` on PATH it prints a line containing
   `--codex needs node` to stderr and exits 2 before any change.
3. **Plan failure.** When the plan exits non-zero, the plan's stderr line reaches
   install.sh's stderr and install.sh exits 2. It creates, changes or removes nothing:
   not the skills directory, its parent, an existing link, or the backup root.
4. **Targets.** `list_targets` prints the plan's stdout lines, in order. The fixed
   `skills/autobuild` and `skills/bughunt` lines are gone.
5. **`dest_of`.** A rel path equal to a plan `dest` maps to
   `$CODEX_SKILLS_DIR/<dest without skills/>`. Any other rel path dies with
   `unsupported Codex target` (exit 1), as today.
6. **`--skip`.** It accepts `skills` and every plan `dest`. Any other name is refused
   as today (`is not an install target`, exit 1, no change).
7. **Restore allow-check.** During `--uninstall`, a manifest line that is not a plan
   `dest` dies with `unsupported Codex backup target` (exit 1), as today. It is never
   restored, in dry-run or not, and its backup copy stays where it is. Whether the
   lines before it were already restored is not part of this contract (today's loop
   order is kept). A backup made for an entry that later left the plan is therefore
   refused, not restored.
8. **Unchanged.** Everything else stays as it is: the `PANDASTACK_CODEX_SKILLS_DIR`
   and HOME rules, the symlinked-directory refusal, the backup root
   `.pandastack-codex-backups-<directory name>`, the manifest format, the messages
   (`linked:`, `backed up:`, `restored:`, `skip (--skip):`,
   `skip (missing in repo):`, `already exists at target`), the `done:` lines,
   idempotence, and preservation of foreign entries and later replacements. install.sh
   keeps working under bash 3.2 (macOS /bin/bash).

## Not in scope

- No change to the catalog, `installerTargets`, the validator, the accessors or
  `checkCatalogDrift`.
- No linking of dependencies, assets, agents, workflows or any other Codex content.
  Reference-content closure is CP-03b.
- No Claude-mode change and no new Claude-mode requirement on node.
- No readiness, probe or provider work (CP-01d, CP-02*).
- No change to how a partial restore keeps the manifest.

## Acceptance

acceptance/codex-parity/cp-01c-install-plan.test.mjs (node:test, about ten seconds).

- It reads modules and files under `PANDASTACK_CANDIDATE_ROOT` (default: the repo
  root). It runs install.sh only from owned temp fixture roots, each a copy of the
  candidate's install.sh, core/, the autobuild and bughunt skill directories and a
  fixture catalog.
- Every install.sh run gets an owned temp HOME and an explicit
  `PANDASTACK_CODEX_SKILLS_DIR`. The real HOME is never touched.
- No network, provider, codex or claude process is started.
- It pins the sha256 of tests/install-codex.test.mjs and runs that file against the
  candidate.

Against the freeze tree (main plus the tier-A freezes, nothing built) it fails 8 of 9
top-level cases, because install-plan.mjs does not exist, install.sh still hard-codes
the pair, and install.sh neither runs the plan nor needs node. The case "tests/install-codex.test.mjs is unchanged and passes"
passes there: today's behavior already satisfies it, and the feature must keep it.
