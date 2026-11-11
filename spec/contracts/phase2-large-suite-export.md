# Conditional P2-15: bounded-memory source export for large Git contents

Preparation only, after P2-14 and terminal native-hunt reconciliation. Native F1
repair was BLOCKED/reverted: focused repaired export passed, but full-suite
comparison was incomplete because the without-repair suite timed out. Do not
claim that repair accepted or relabel the historical disposition.

createSuiteExport({repo,tree}) must restore exact regular-file bytes and modes for
an aggregate tree exceeding the subprocess output buffer and for one regular blob
exceeding that buffer. Keep existing synchronous API and owned cleanup.
Do not increase the 128 MiB subprocess buffer or gate time budgets.
Use bounded per-object handling or streaming to owned files; no aggregate whole-tree
stdout allocation and no whole large-regular-blob stdout allocation. Preserve exact
tree/object identities, literal alternate paths, fresh source-only Git metadata,
mode restoration, no persistent alternate and self-contained object transfer.
Failed export removes only its owned directory. No changes to capture ownership,
control transport, blocked reproductions or unrelated protocols.

Two retained ordinary Git cases are adapted only from the rejected repair tree
to node:test/portable imports plus nested fixture cleanup finally: seventeen distinct 8 MiB regular blobs (136 MiB
aggregate) with exact byte assertions; one sparse 129 MiB executable regular blob
with distinct boundary bytes, exact size/mode and streaming SHA256 comparison.
Only fixed Git commands execute; no source-file payload is executed. Fixture Git
calls are bounded at 30 seconds; existing exporter command bounds remain. Temporary
source/export/object data can occupy several hundred MiB; this is not a zero-resource
unit test. Both tests restore TMPDIR and remove owned files in an inner finally even if exported.cleanup throws. This fixture correction is explicit; assertion bodies and workloads are unchanged.
No concurrent test launch or capture/lifecycle fixture is added.
No runtime has been performed for this package. Ordinary large Git export does not
prove arbitrary-size support, bounded total disk, hostile containment, or previously
blocked orphan/overflow/filesystem-race scenarios.

Acceptance wrapper imports the two case modules exactly once; Phase2 wildcard gate
discovers only p2-15.test.mjs. Original assertion bodies remain.
The existing baseline fixture tests/suite-export-paths.test.mjs currently intercepts every cat-file as binary
--batch output. A separately reviewed fixture-only amendment models --batch-check
as its real utf8 header string and preserves --batch binary framing, every original
path/byte/mode/cleanup/repack assertion and synthetic transfer failure. No pass bypass.
Amendment needed only if the final implementation uses that legitimate operation.
This existing baseline fixture was not previously frozen. The conditional package explicitly adds it to the frozen inventory after the reviewed amendment; subsequent builder edits require an explicit host amendment.
All existing gates and independent implementation review remain mandatory.
