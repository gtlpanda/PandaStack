# Literal repository paths in source-only suite exports

Additive regression of the existing createSuiteExport({repo,tree}) contract only.
Valid source repository paths containing a colon, ordinary spaces or double quotes
must export the selected Git tree with identical regular-file bytes and executable
modes. Git alternate-object list syntax must not reinterpret a literal path as
multiple paths. The resulting fresh Git repository remains self-contained after
construction; no persistent alternate reference to the original source is allowed.
Original source files, selected HEAD and tracked status remain unchanged. Cleanup
removes only the owned export and stays idempotent.

Four ordinary owned Git fixtures cover plain path, spaces/quotes, colon, and
colon with spaces/quotes. They contain a binary blob and inert executable-mode
text; none is executed. Only Git subprocesses run; no provider, namespace,
browser, suite, retention relay or descendant-lifecycle reproduction is involved.
Each Git invocation has a timeout and output bound. The test is portable through
PANDASTACK_CANDIDATE_ROOT or installed acceptance/harness ../../ root.

Proposed fix scope: encode the source object directory as one literal element of
Git's alternate-object directory format, with its documented quoting/escaping,
or use an equivalently bounded source-only Git object transfer preserving these
properties. Do not reject valid colon paths or weaken export isolation. No main
implementation change is included in this draft.

Provenance: native hunt 20261110T183914Z-1794337371951 finding F2 describes raw
GIT_ALTERNATE_OBJECT_DIRECTORIES assignment in createSuiteExport. This draft
independently invokes only the benign exported Git helper, not fix() or a suite.
The blocked F3 nested-process reproducer is neither reused nor recreated.
