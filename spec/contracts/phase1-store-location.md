# Phase 1 managed tracking store placement

Managed tracking remains observational. Before createRunStore or ANY filesystem
mutation by tracking, resolve project and runner working-tree roots using Git,
not only the supplied subdirectory. For non-Git directories protect the canonical
supplied directories instead; do not change recorded repo/runnerRoot semantics. Reject selected tracking locations equal to
or inside either working tree. Use path-component containment, not string-prefix:
a sibling project-records is outside project and supported. Resolve the existing ancestor of a prospective nonexistent store read-only, then
append the missing suffix using the same path.resolve lexical semantics as the
store. Indeterminate, looping or non-directory ancestry fails open unrecorded.
No hostile race guarantee or exploit test.
This managed-wrapper rule does not change direct createRunStore(directory).

Working-tree content includes .gitignored locations: reject them too. Ignoring
files is not an invariant that observation can safely own project output. Never
modify .gitignore, Git exclude/index flags, clean checks or staging rules to conceal
tracking. Existing repo/runner content and all preexisting directories remain
unchanged on refusal; do not create empty parent directories before validation.
No fallback to an unrelated store: skip recording for that invocation.

Only the exact trusted Git metadata owner plus literal pandastack-runs namespace,
and descendants within that namespace, are excepted from worktree containment.
Obtain the Git metadata owner read-only; do not canonicalize a caller-created
pandastack-runs symlink into a source directory and redefine that destination as
an allowed namespace. Independently canonicalize the candidate; the existing
store no-follow policy still applies. Other .git subdirectories (including
pandastack-runs-other) get no broad metadata exception.
Preserve the default git-path pandastack-runs location for normal and linked
worktrees. Linked Git metadata can lie inside the runner's worktree; the exact
trusted namespace exception must still work there. Explicit stores in that same
namespace or a child are supported. External shared stores (including sibling-
prefix paths) and explicit external stores for non-Git directories stay supported.
A static ordinary namespace symlink into the fixture source must remain untouched
and unrecorded. No symlink race or unrelated filesystem mutation is tested.

Selection precedence remains options.storeDir, then PANDASTACK_RUNS_DIR, then
Git metadata default. Both explicit/API and environment-selected forbidden paths
must fail open before mutation: currentRunId() is null inside work, work executes
exactly once, the exact returned code or thrown error object propagates unchanged,
and one generic warning per affected wrapper invocation states tracking unavailable.
Never include paths, work error messages or configuration secrets in the warning.
Accepted default/external paths retain parentage, terminal events and context
cleanup. Nested managed wrappers each apply the same placement rule.

Acceptance uses ordinary disposable Git projects, linked worktrees and ignored
folders. No provider calls: actual build-app/autobuild entry points use their existing
fake CLIs with explicit executable paths. Clean build-app internal-store invocation
must complete normally, external control still completes, and genuinely dirty
input still exits6 without fake session launch. Both autobuild fake backends must
complete with no tracking directory created/committed and unchanged .gitignore.
Direct store API remains usable inside a caller-chosen project directory.


Pre-freeze evidence: native hunt 20261110T114537Z-1794312301456 reproduced the clean-build regression at 4edd0b612341e33f3a62d4f865da8703e9d2492c (head exit 1 with marker; baseline 18eabde206c5041e098102b939877c8e4c99fb85 exit 0). The independently reviewed 20-case acceptance matrix had 4 passing controls and 16 expected behavioral failures before implementation. No provider calls or race-exploit tests are part of acceptance.
