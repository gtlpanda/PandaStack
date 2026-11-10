# Conditional P2-16: preserve actual source Git object format

Preparation only, after P2-15 and terminal native reconciliation. F2 first repair
passed its initial checks but failed adversarial 40/63-character SHA256-prefix
checks; it is not accepted. Second native repair is still being checked. Do not
duplicate or preempt its ownership, claim a landed fix, or rewrite historical
evidence. No runtime or candidate modification is performed by this draft.

createSuiteExport must query the source repository's actual storage object format,
accept sha1/sha256 explicitly and initialize its owned empty repository accordingly.
Do not infer format from supplied identifier length: accepted40..64 lowercasehex
identifiers can represent SHA256 prefixes. Preserve the existing input grammar;
do not broaden to arbitrary revision expressions or shell strings.
Unavailable/unsupported format refuses safely and removes only owned temporary
export state. Preserve source bytes/modes/tree identity, literal alternates,
source-only metadata, self-contained objects, cleanup and P2-15 large exports.
No model/provider, capture lifecycle, race or previously blocked reproduction work.

Three ordinary real-Git acceptance cases retain actual native fixtures: original
full SHA256 reproduction; full SHA1; SHA256 full plus40/48/63-character prefixes.
Assertions compare actual export format, full resulting tree and selected bytes;
source status remains unchanged. Fixed Git calls have5-second timeouts; payload is
small inert file data, never executed. Portable node:test imports and nested outer
cleanup finally are explicit fixture adaptations; assertions remain unchanged.
No skip-as-pass on missing SHA256 Git capability. No new gate budgets.

The separately proposed baseline mock amendment builds upon P2-15's proposed batch
protocol correction. Its sole new source query is rev-parse --show-object-format,
returning a documented sha1 text result. Original literal paths, byte/mode/cleanup/
repack assertions remain. The expected source query inventory deliberately changes
from one operation to an exact two-layout allowlist: the original single objects-path query, or one format query followed by that objects-path query. Objects-path remains exactly once; no other query/order/repetition is accepted. This preserves baseline tests before feature implementation.
This is an explicit fixture protocol amendment, never an assertion bypass.
Reconcile against actual accepted P2-15 fixture bytes before installing; do not
replace a subsequently changed file from this preparation snapshot. This baseline mock was not previously frozen; the conditional package newly freezes its reviewed amended bytes.
Independent review and host approval are required before install or runtime.
