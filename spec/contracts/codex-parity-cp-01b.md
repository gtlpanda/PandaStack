# CP-01b: production catalog converted to v2, with a drift guard

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125).
Depends on CP-01a (spec/contracts/codex-parity-cp-01a.md), which added the v2 schema
and the accessors. This feature rewrites spec/offering-capabilities.json as v2 and adds
one exported drift guard. It does not change install.sh (CP-01c), preflight (CP-01d),
any SKILL.md (CP-03a), or any provider code. It certifies nothing: every value below
is catalog data, not runtime proof.

## Owners and the files a builder may edit

- spec/offering-capabilities.json: rewritten as v2 (the host lists this one file in
  autobuild.json `writable` when it freezes this feature).
- core/skills/native-runtime/catalog.mjs: gains the export `checkCatalogDrift`. The
  guard is implemented in this file. No other export changes.
- tests/native-catalog-v2.test.mjs: its `productionV1()` reads the v1 snapshot
  acceptance/native-runtime/oc-01-catalog.fixture.json instead of the production file.
  No other change to that file.
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

Nothing else changes. The guard imports, and never copies:
- `loadOfferingCatalog` (same file) to read and validate the catalog;
- `loadRoleFile` from core/skills/native-runtime/role-files.mjs (CP-03c) for role
  frontmatter.

## The v2 production catalog

Same inventory as v1. The v1 file is byte-identical to the frozen
acceptance/native-runtime/oc-01-catalog.fixture.json, which is the reference below.

Top level:
- `schemaVersion` is 2. `status`, `inventorySha256`, `limits`, `assets`,
  `fixedTargets`, `installerTargets` and `aliases` are unchanged from v1.
  `inventorySha256` stays the sha256 of spec/codex-parity-inventory.json.
- Counts: 46 offerings, 6 workflows, 46 assets, 4 fixed targets, 92 installer
  targets, 1 alias (all verified on disk at d80d9c5).
- `transports` is exactly these three rows, in this order:

| id | provider | entry |
|---|---|---|
| `claude-code` | claude | `install.sh` |
| `codex-autobuild` | codex | `graphs/autobuild/tool/lib/codex.mjs` |
| `codex-bughunt` | codex | `graphs/hunt/skills/bughunt/native-runner.mjs` |

Workflows: same rows and order. Each row keeps `source`, `roles` and
`nativeReadiness`, and adds `sha256`, the sha256 of the file's bytes on disk.

Offerings: same 46 rows in the same order. Each keeps `id`, `kind`, `source`,
`entrySkill`, `installTargets`, `nativeReadiness`, `evidenceOwners`,
`requiredRuntimes`, `aliases` and `requirementsComplete` unchanged. Then:
- `codexInstallEligible` and `nativeImplementation` are removed (v2 derives them).
- `entrySha256` is the sha256 of `<source>/SKILL.md` on disk (unchanged today).
- `permissionProfile` is null. `proofRefs` is [].
- `dependencies` is the list in "Declared dependencies", sorted.
- `providers` follows the next table.

### Provider rows

"No `supported` appears anywhere" is read literally: no provider row of any offering,
Claude or Codex, is `supported`. Wave 1 certifies nothing, every row has
`requirementsComplete: false`, and the catalog status is
'PROPOSED_CATALOG_NOT_RUNTIME_CERTIFICATION'. No production code reads
`providerImplementation(row, 'claude')`, and the derived values are unchanged (below).

| offering | provider | implementation | transportId | limitations, in this order |
|---|---|---|---|---|
| every offering | claude | `partial` | `claude-code` | `LIBRARY_ONLY` (library rows only), `REQUIREMENTS_INCOMPLETE` |
| autobuild, bughunt | codex | `partial` | `codex-autobuild`, `codex-bughunt` | `LIVE_PROOF_MISSING`, `NATIVE_UNVERIFIED`, `REQUIREMENTS_INCOMPLETE` |
| security-audit | codex | `unavailable` | null | `NATIVE_UNVERIFIED`, `NO_NATIVE_ENTRY`, `NO_PROVIDER_TRANSPORT`, `PROFILE_UNSUPPORTED`, `REQUIREMENTS_INCOMPLETE` |
| the other 43 | codex | `unavailable` | null | `LIBRARY_ONLY` (library rows only), `NATIVE_UNVERIFIED`, `NO_PROVIDER_TRANSPORT`, `REQUIREMENTS_INCOMPLETE` |

Library rows are the two with `entrySkill: false`: decisions and native-runtime.
security-audit's extra codes record decision 2 of the priority contract.

Derived values stay what v1 stored, for every offering:
- `installEligible(row, 'codex')` equals v1 `codexInstallEligible` (true only for
  autobuild and bughunt);
- `nativeImplementationOf(row)` equals v1 `nativeImplementation`;
- `installEligible(row, 'claude')` is true (every row has one install target).

So `discoverOfferings` and `projectOfferingPreflight` give the same results as with
v1, and install.sh, which does not read the catalog, installs the same set.

## Declared dependencies

A dependency edge `A -> B` is derived from disk when B is a catalog offering id other
than A, by any of these three rules. Nothing else is derived.

1. **Role `skills:` frontmatter.** For each `workflows` row whose source is
   `graphs/<g>/workflows/<file>`, every role it names is loaded with `loadRoleFile`.
   Each name in the role's `frontmatter.skills` is an edge from every offering with
   `entrySkill: true` whose source starts with `graphs/<g>/skills/`. A workflow under a
   graph with no such offering (graphs/qa, harness-repair) gives no edge. A nested child
   workflow (dev-build runs harness-repair) is not followed. A role-file error is thrown
   unchanged (fail closed).
2. **`skills/<name>/` mentions.** Every match of `/skills\/([a-z0-9][a-z0-9-]*)\//g`
   in the entry `<source>/SKILL.md` text, for offerings with `entrySkill: true`.
3. **Static `core/skills/<name>` imports.** Every regular `.mjs`, `.js` or `.cjs` file
   under `<source>`, recursively, through real directories only (symlinks are not
   followed). In each file, every match of

   ```
   /^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom[ \t]*(['"])([^'"\n]+)\1|^[ \t]*import[ \t]*(['"])([^'"\n]+)\3/gm
   ```

   gives a specifier. Only specifiers starting with `.` count. The specifier is resolved
   against the file's directory, as a root-relative POSIX path. When the result starts
   with `core/skills/<name>/`, `<name>` is the edge target. Dynamic `import()`, bare
   specifiers and imports into `graphs/*/skills/*` are not edges. (bughunt and build-app
   import each other's files; declaring both would be a cycle, which v2 rejects.)

The declared `dependencies` of each offering must be a superset of its derived edges.
For this conversion they are exactly the derived edges (verified at d80d9c5):

| offering | dependencies |
|---|---|
| blueprint | backlog, default-stack, knowledge-map |
| build-app | backlog, run-records |
| bughunt | bug-lenses, default-stack, findings, knowledge-map, verify, workflow-state |
| dev | backlog, default-stack, knowledge-map, workflow-state |
| native-runtime | run-records |
| release-pr | default-stack, knowledge-map |
| security-audit | native-runtime |

Every other offering keeps []. The graph is acyclic. dev's nested-QA reach into
harness-review (through harness-repair's reviewer) is not derived here; CP-03b owns
reference-content closure.

## Drift guard

### `checkCatalogDrift({ installationRoot }) -> { ok, problems }`

Exported from core/skills/native-runtime/catalog.mjs. Synchronous and read-only: it
never creates, changes or removes a file.

Input and load:
- The option object has exactly the key `installationRoot`, an absolute path.
  Otherwise `INVALID_CATALOG_INPUT`.
- It calls `loadOfferingCatalog({ installationRoot })` and lets its errors through
  unchanged: `INVALID_CATALOG_INPUT`, `NOT_FOUND`, `INVALID_CATALOG`, `IO_ERROR`.
- A valid v1 catalog throws `CATALOG_NO_PINS` (v1 has no workflow hashes to check).
- A directory listing that fails for a reason other than "missing" throws `IO_ERROR`.
- A role-file error from rule 1 is thrown with its own CP-03c code.
- Every error is an `Error` whose `code` is the fixed string; the message never echoes
  input or file content.

Paths below are under the canonical root (`realpathSync(installationRoot)`). It is a
static check, not protection against concurrent replacement. A "regular file" is
opened without following a final symlink and checked with `fstat`.

Problems, each `{ code, ref, dependency }` with exactly these keys:

| code | when | ref | dependency |
|---|---|---|---|
| `SOURCE_MISSING` | an offering's `<source>` is not a real directory | offering id | null |
| `SOURCE_UNLISTED` | a real directory directly under `core/skills`, `kit/skills` or `graphs/<g>/skills` (each real `<g>` under `graphs`) is no offering's source | its root-relative path, or null when its name is not a catalog identifier | null |
| `ENTRY_SHA_MISMATCH` | an `entrySkill` offering whose source is present, and whose `<source>/SKILL.md` is missing, not a regular file, unreadable, or hashes to another value than `entrySha256` | offering id | null |
| `WORKFLOW_SHA_MISMATCH` | a workflow whose `source` is missing, not a regular file, unreadable, or hashes to another value than `sha256` | workflow source | null |
| `TRANSPORT_ENTRY_MISSING` | a transport whose `entry` is not a regular file | transport id | null |
| `DEPENDENCY_UNDECLARED` | a derived edge `A -> B` (rules above) where B is not in A's `dependencies` | A | B |

- Rules 2 and 3 skip an offering whose source is missing. Rule 2 skips an unreadable
  SKILL.md (that is already `ENTRY_SHA_MISMATCH`).
- One problem per row and code; one `DEPENDENCY_UNDECLARED` per missing `(A, B)` pair.
- `problems` is sorted by `code`, then `ref`, then `dependency` (string order, null
  before any string). `ok` is `problems.length === 0`.
- The result for an unchanged root is the same on every call.

CP-02f and CP-01d call this guard (CP-02e does not: a pin change must reach the
registry as `REGISTRY_MISMATCH`, decision 5); CP-03a and every later SKILL.md or workflow
edit must update the matching hash in the same change, or the guard fails.

## OC-01 and CP-01a

- acceptance/native-runtime/oc-01-catalog.test.mjs reads its own fixture, not the
  production file, and no SKILL.md changes here. It stays green unchanged. Its SKILL.md
  hash pin is superseded by this guard (priority contract, "OC-01 snapshot"); the host
  retires that case when CP-03a is frozen.
- acceptance/codex-parity/cp-01a-catalog-v2.test.mjs reads spec/offering-capabilities.json
  as "production v1". Against a converted catalog, 4 of its 7 cases fail: "the
  production v1 catalog and its v2 form both validate", "v2 rejects each malformed
  shape with no input echoed", "accessors give the same answers for the v1 and v2
  forms of every offering", and "load, discovery and preflight agree for the same
  offering in v1 and v2". The host amends that frozen test in the commit that freezes
  this feature, one line: `productionV1()` reads
  acceptance/native-runtime/oc-01-catalog.fixture.json (the same v1 bytes, so the
  amended test also passes on main). With that line it passes 7 of 7 against the
  converted catalog. The builder never edits it.
- The OC-01 fixture file is the v1 reference for the amended CP-01a test, for
  tests/native-catalog-v2.test.mjs and for this feature's test. Retiring OC-01's hash
  case (CP-03a) must keep the fixture file.
- tests/native-catalog-v2.test.mjs (not frozen; scripts/test-workflow.mjs runs it in
  the baseline gate) fails one case the same way ("v2
  catalog with a v1 row" in "v2 rejects the claude side of the provider rules"). The
  builder makes the same one-line change there (see Owners).

## Not in scope

- No change to install.sh, preflight-cli.mjs, discovery, preflight projection, the
  validator or the accessors.
- No `supported` value, no readiness other than 'unknown', no new limitation code.
- No dependency inferred from nested workflows, prose without a `skills/<name>/` path,
  dynamic imports, or imports between graph skill directories.
- No check of `assets`, `fixedTargets` or `installerTargets` sources on disk.

## Acceptance

acceptance/codex-parity/cp-01b-catalog-v2-production.test.mjs (node:test, a few
seconds). It reads the production catalog and files under `PANDASTACK_CANDIDATE_ROOT`
(default: the repo root), derives the dependency edges itself, and runs the guard on
owned temp fixture roots. No HOME, network, provider or child process.

On main (d80d9c5) it fails 13 of 14 top-level cases: three on `schemaVersion` 1, one on
the missing workflow `sha256`, one on 20 undeclared derived edges, and eight because
`checkCatalogDrift` is not exported. The inventory case passes on main.

Cases the test does not pin, by design, because later features may change them under
their own contracts: `proofRefs`, the exact order and any extra limitation codes
beyond the required ones (LIBRARY_ONLY exactly for library rows; REQUIREMENTS_INCOMPLETE
everywhere; NATIVE_UNVERIFIED for codex; LIVE_PROOF_MISSING for codex `partial`;
NO_PROVIDER_TRANSPORT for codex `unavailable`; NO_NATIVE_ENTRY and PROFILE_UNSUPPORTED
for security-audit), extra declared dependencies, and the order of `dependencies`.
A later feature that flips a codex row to `partial` (for example a CP-02f row update)
must have the host amend the "codex is partial only for autobuild and bughunt" case
when it is frozen.
