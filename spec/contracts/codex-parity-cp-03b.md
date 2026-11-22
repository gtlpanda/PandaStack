# CP-03b: reference-content closure

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125).
Depends on CP-01c (spec/contracts/codex-parity-cp-01c.md), whose install plan checks the
transitive `dependencies` of every Codex-eligible offering, and on CP-03a
(spec/contracts/codex-parity-cp-03a.md), the last wave-1 feature that edits a reference
SKILL.md. Through CP-01c it also rests on CP-01b (catalog v2, drift guard), CP-01a
(validator, accessors) and CP-03c (role-file loader).

The reference skills are prose and small helpers that graphs and roles read. This
feature makes the catalog tell the whole truth about them:
- every role `skills:` name resolves to a catalog entry offering;
- the six bughunt lenses agree everywhere they are listed;
- the catalog declares the reference content each graph reaches through a child
  workflow or a role body, which CP-01b's rules do not derive;
- the reference rows say that their prose guidance has no model-behavior proof.

It is a catalog data change. It certifies nothing: no row becomes `supported`, no
readiness changes, and no model is run.

## Owners and the files a builder may edit

- spec/offering-capabilities.json (already in autobuild.json `writable`): exactly the
  changes in "Catalog changes" below. No other byte changes.
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

Nothing else changes. No SKILL.md, role file, workflow, lens file, install.sh or module
changes, so no `entrySha256` or workflow `sha256` changes. If a builder finds it must
touch a SKILL.md, the matching `entrySha256` changes in the same edit (CP-03a's rule),
and the change must still satisfy every case below.

## Reference rows

The reference rows are the offerings whose catalog `kind` is
`shared-reference-contract`. That is the catalog's own word for reference content. Today
there are exactly seven, in catalog order:

backlog, bug-lenses, default-stack, findings, gtm-brief, knowledge-map, run-records.

All seven have `entrySkill: true`. The matrix's CP-03 batch also lists decisions (a code
library, `LIBRARY_ONLY`), harness-review and verify (both `guided-offering`). They are not
reference rows here. Guided offerings get their own marker in the batch that owns them
(CP-11/12/13). decisions is not prose guidance.

## `GUIDANCE_ONLY`

`GUIDANCE_ONLY` is already in the CP-01a closed limitation set and the validator accepts
it on any row. No validator change is needed. Its meaning, fixed here:

> The row's content is prose guidance for a model, plus any helper it documents. Tests
> may prove a helper's behavior. No test proves that a model follows the prose.

It is the record of "prose guidance has no model-behavior proof". It is a limitation,
not a refusal: it does not change `installEligible`, `nativeImplementationOf`, discovery,
preflight or `inspectOffering` status. `inspectOffering` already copies a v2 row's
limitations into its result (CP-01d), so the code shows up there as data.

Rules:
- Every reference row carries `GUIDANCE_ONLY` under both `claude` and `codex`.
- No `executable-graph-or-cli` row and no `shared-library-no-entry-skill` row carries it.
  Graphs have executable stages; libraries are code.
- `guided-offering` rows are not decided here. They keep what they have (no
  `GUIDANCE_ONLY` today), and a later batch may add it.

## Closure rules

CP-01b derives edges from role `skills:` frontmatter of the roles a graph's own workflow
names, from `skills/<name>/` mentions in entry SKILL.md files, and from static
`core/skills/<name>` imports. It does not follow a child workflow and does not read role
bodies. CP-03b adds two rules. An edge `A -> B` counts only when B is a catalog offering
id other than A. Owners are as in CP-01b rule 1: for a `workflows` row whose source is
`graphs/<g>/workflows/<file>`, every offering with `entrySkill: true` whose source starts
with `graphs/<g>/skills/`. A workflow with no owner (graphs/qa) gives no edge of its own.

**Reach.** A workflow reaches itself and, transitively, every child workflow it calls.
A child call is found in the workflow source, with comment lines removed (lines whose
first non-blank characters are `//`, `/*` or `*`), by

```
/\bworkflow\(\s*(?:'([a-z0-9][a-z0-9-]*)'|([A-Z][A-Z0-9_]*)\b)/g
```

- A literal gives the child name directly.
- An identifier must be bound in the same file by
  `const <IDENT> = '<name>'`. An unbound identifier is an error.
- The name is matched to the `workflows` row whose source holds
  `/^[ \t]*name:[ \t]*'([a-z0-9][a-z0-9-]*)'/m` with that name. No match is an error.
  Rule: the closure fails closed; it never drops an edge it cannot resolve.

Today's one child call is graphs/dev/workflows/dev-build.js calling
`workflow(QA_WORKFLOW, ...)` with `const QA_WORKFLOW = 'harness-repair'`. The test
requires that this call is found; it does not forbid later child calls.

For every role named in the `roles` of a reached workflow, loaded with CP-03c
`loadRoleFile`:

- **(a) Nested `skills:`.** Each name in `frontmatter.skills` is an edge from every
  owner. For the workflow itself this equals CP-01b rule 1; for a child it is new. This
  is "dev's nested-QA reach into harness-review" that CP-01b left to this feature.
- **(b) Role-body skill paths.** Every match of CP-01b's mention regex
  `/skills\/([a-z0-9][a-z0-9-]*)\//g` in the role's `body` (frontmatter stripped) is an
  edge from every owner. The inlined skill bodies are not scanned here: rule 2 of CP-01b
  and the transitive dependency closure already cover them.

A role-body mention also names a path. When the mention is followed by a path segment
(`skills/<id>/<segment>`, segment `[A-Za-z0-9._-]+`), `<source of id>/<segment>` must
exist as a regular file or a directory. Today: `skills/verify/verify.sh` (checker,
fixer, implementer) and `skills/backlog/SKILL.md` (advisor).

## Catalog changes

The declared dependencies must be a superset of the edges from both rules, and of
CP-01b's. For this feature they become exactly (verified on the CP-03a reference):

| offering | added | dependencies after |
|---|---|---|
| dev | harness-review, verify | backlog, default-stack, harness-review, knowledge-map, verify, workflow-state |
| bughunt | backlog | backlog, bug-lenses, default-stack, findings, knowledge-map, verify, workflow-state |
| release-pr | backlog | backlog, default-stack, knowledge-map |

Why:
- dev -> harness-review: harness-repair's reviewer lists `skills: harness-review`.
- dev -> verify: implementer, checker and (nested) fixer run
  `.../skills/verify/verify.sh`.
- bughunt -> backlog and release-pr -> backlog: both workflows use the shared advisor
  role, whose body points at `~/.claude/skills/backlog/SKILL.md`. The advisor reads it
  only when it gates a backlog. The edge is still declared: the rule is mechanical, a
  superset is allowed, and the target is a reference row.

Every list stays sorted and unique. The graph stays acyclic (every added target has
`dependencies: []`). No other offering's `dependencies` change, and the reference rows'
own lists stay `[]` (no rule derives an edge from them).

Then `GUIDANCE_ONLY` is added to the `limitations` of both providers of the seven
reference rows. Each list stays sorted in code-unit order, so it comes first:
claude `GUIDANCE_ONLY, REQUIREMENTS_INCOMPLETE`; codex `GUIDANCE_ONLY,
NATIVE_UNVERIFIED, NO_PROVIDER_TRANSPORT, REQUIREMENTS_INCOMPLETE`.

Nothing else in the catalog changes: implementations, transport ids, the other
limitations, `proofRefs`, `permissionProfile`, hashes, workflows, transports and the v1
blocks stay as CP-01b and CP-03a left them.

## Skills names and lenses (invariants this feature pins)

Both already hold on main. This feature pins them so later changes keep them.

**Every `skills:` name resolves.** For every role in `listRoleFiles` (CP-03c) with a
non-empty `skills:` list, each entry of `assembleRoleInstructions(...).skills`:
- is the id of a catalog offering with `entrySkill: true`;
- whose `installTargets` include `skills/<name>` (Claude preloads a skill by its
  installed name);
- whose `<source>/SKILL.md` equals the skill's `path`, is a regular file, and hashes to
  the row's `entrySha256`;
- and whose stripped body is not empty.
Today the names are backlog, bug-lenses, default-stack, harness-review and knowledge-map.

**The six lenses agree.** The lens set is `ALWAYS` plus the keys of `SIGNALS`, both
exported by graphs/hunt/skills/bughunt/intake.mjs. They do not overlap, and there are six.
That set equals each of these:
- the entries of core/skills/bug-lenses/lenses, each a regular file named `<lens>.md`,
  each with exactly one `lens-token: <token>` line;
- the backticked first column of the table under `## The lenses` in
  core/skills/bug-lenses/SKILL.md;
- `LENSES` and `LENS_ORDER` in graphs/hunt/workflows/bughunt-flow.js, and the keys of
  `LENS_TOKENS`, whose values equal the lens-token lines;
- `LENSES` exported by core/skills/findings/findings.mjs.
And `routeLenses` (intake.mjs) routes all six for a code change that trips every signal,
and nothing for no change.

These names are existing exports read as they are: intake.mjs `ALWAYS`, `SIGNALS` and
`routeLenses`, findings.mjs `LENSES`. This contract pins only that they exist and agree.

## Install and other frozen gates

- `installPlan` (CP-01c) still returns exactly the two entries, autobuild and bughunt.
  The installed set does not change, and no dependency is linked. (Amended at the tier-4 freeze (CP-04e, W2-10): 
  blueprint joins the set once CP-04e flips its codex row; its closure also lives under
  core/skills.)
- bughunt's transitive closure gains backlog, so install-plan now checks it: a root
  without core/skills/backlog gives `DEPENDENCY_MISSING`.
- The transitive closure of every Codex-eligible offering stays under core/skills/. That
  keeps CP-01c's fixture roots, which copy only core/ and the two entry sources, valid.
  Any future dependency of a Codex-eligible offering outside core/skills needs the host
  to amend CP-01c's fixture.
- `checkCatalogDrift` (CP-01b) stays `{ ok: true, problems: [] }`. Extra declared
  dependencies never make a problem.
- Verified against the reference (tier-A and tier-B references, CP-03a and this feature),
  run from the freeze tree with `PANDASTACK_CANDIDATE_ROOT`: every
  acceptance/codex-parity test passes (CP-01a 7, CP-01b 25, CP-01c 9, CP-01d 24,
  CP-02a 69, CP-02b 92, CP-02c 25, CP-02d 26, CP-03a 17, CP-03b 7, CP-03c 14, counting
  subtests). OC-01, NR-01 and NR-02 pass. tests/native-catalog-v2, native-preflight-cli,
  native-offering-catalog, native-role-files, install-codex, graphs/hunt/tests/bughunt-flow
  and intake pass (install-codex and intake need a real, non-symlinked TMPDIR on macOS,
  as on main). No frozen file needs a host edit.

## On CP-03a's note

CP-03a says making its four rows installable under Codex "is CP-01c/CP-03b work". This
feature does not do that. Flipping a reference row to codex `partial` needs a transport
that does not exist, would change the installed set that CP-01c pins, and would break
CP-01b's and CP-01d's "only autobuild and bughunt" cases. Codex installation of reference
content belongs to a later batch (CP-09/CP-14) with its own host amendments.

## Not in scope

- No `supported` value, no readiness change, no new limitation code, no validator,
  accessor, guard or install-plan change. `checkCatalogDrift` does not learn the new
  rules; this feature's frozen test is their gate.
- No linking or copying of dependencies by install.sh, under either provider.
- No edge from workflow source text, inlined skill bodies, prose without a
  `skills/<name>/` path, code-file comments or dynamic imports.
- No graph-to-graph composition outside a `workflow(` call: build-app's driver (dev
  sessions, final QA, bughunt), release-pr and /loop are CP-05/CP-07/CP-08/CP-14 work.
- No `GUIDANCE_ONLY` decision for `guided-offering` rows (harness-review, verify,
  workflow-state, kit offerings).
- No proof that a model follows any SKILL.md. That is what `GUIDANCE_ONLY` records.

## Acceptance

acceptance/codex-parity/cp-03b-reference-closure.test.mjs (node:test, under a second). It
reads the catalog, role files, lens files and modules under `PANDASTACK_CANDIDATE_ROOT`
(default: the repo root) and derives the closure edges itself. The install and
derivation cases use owned temp roots. No HOME, network, provider or child process.

Seven top-level cases:
1. Every `skills:` name in a shipped role file resolves to an entry offering with a
   readable SKILL.md.
2. The six lenses in intake routing equal the lens files, the skill table and the hunt
   lists.
3. Declared dependencies cover the closure (child workflows and role-body skill paths),
   and every role-body skill path exists. The derivation must find the dev-build ->
   harness-repair child and the dev -> harness-review, dev -> verify and
   bughunt -> backlog edges, so an empty derivation cannot pass.
4. The derivation follows a child workflow on a fixture root, ignores a commented call,
   and refuses an unresolved child.
5. The reference rows are the seven above; they declare sorted dependencies covering the
   closure, are never `supported`, and carry `GUIDANCE_ONLY` and `REQUIREMENTS_INCOMPLETE`
   under both providers; no graph or library row carries `GUIDANCE_ONLY`; the catalog
   validates.
6. `installPlan` gives the same two entries; every Codex-eligible closure stays under
   core/skills; on a fixture root, removing core/skills/backlog gives
   `DEPENDENCY_MISSING`.
7. `checkCatalogDrift` is ok on the candidate root.

Freeze results:
- Freeze tree (main plus the tier-A and tier-B freezes, nothing built; v1 catalog):
  fails 4 of 7. Case 3 fails on 15 undeclared closure edges (the v1 catalog declares no
  dependencies; four of them are this feature's own: dev -> harness-review, dev -> verify,
  bughunt -> backlog, release-pr -> backlog). Cases 5 and 6 fail because the catalog is
  v1 (CP-01b unbuilt), and case 7 because `checkCatalogDrift` is not exported (CP-01b
  unbuilt). Cases 1, 2 and 4 pass there: the `skills:` and lens invariants already hold
  on main, and case 4 checks the test's own derivation with only the CP-03c loader,
  which is built.
- Reference before this feature (tier A + tier B + CP-03a): fails 3 of 7, only for this
  feature's reasons: case 3 on exactly the four edges above, case 5 on the missing
  `GUIDANCE_ONLY`, case 6 on bughunt -> backlog.
- Reference with this feature: passes 7 of 7, 3 times serial and 3 times in parallel.
- Mutation sweep, each caught: dropping any of the four added edges; dropping
  `GUIDANCE_ONLY` from one provider of one reference row; adding it to bughunt; a
  `supported` reference row; a bughunt dependency outside core/skills; deleting a lens
  file; a seventh `SIGNALS` key; an extra lens-table row; a drifted `LENS_TOKENS` value; a
  `skills:` entry naming a skill directory that has no catalog row; a SKILL.md edit
  without its hash; a role-body path to a missing file.
