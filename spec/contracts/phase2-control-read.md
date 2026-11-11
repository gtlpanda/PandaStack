# Conditional P2-12: preserve control-byte observation at existing decisions

Preparation only. The active native hunt retains current fix ownership. The
supervisor decides after its terminal result whether this fallback is needed;
these files do not authorize installation, duplicate repair or provider launch.
Depends on accepted P2-11; preserve its cooperative local ownership boundary.

Scope is the four existing STOP_FD read decisions in co_root: before admission,
while the root waits, and during completion/join decisions. Any observed finite
input byte, including NUL, newline or partial ordinary bytes followed by EOF,
must latch closing/incomplete before admission or successful completion proceeds.
Empty input alone is not a stop request. A failed read with a nonempty partial
message still indicates input. Clear each read's message variable so stale bytes
cannot be mistaken for a new observation. This is byte presence, not parsing a
request's contents into action or signal authority.

Keep existing read wall-time bounds and16-character bound, local root-owned signal
identities, stop reasons, grant ordering, normal success settlement, and bounded
cleanup unchanged. The two drains after failure is already latched are outside
these four decision sites; no broader protocol/ownership redesign is required.
Do not infer a kernel lifecycle guarantee from the primitive read predicate.

## Frozen fallback acceptance proposal

Install the byte-identical reviewed read-predicate.test.mjs as
acceptance/phase2/p2-12.test.mjs, SHA256
92dcaf4649e5f09da9b56f885ee4d958094ab69a59978ff723bdf772404a19c0.
It imports no product module and never sources or launches capture-owner. It reads
source text and extracts only four predicates through a closed builtin grammar,
replacing only STOP_FD with finite stdin. Fixed Bash read/printf receives inert
finite byte arrays, then EOF; bounded shell deadline is a fixture failure bound.
It does not create FIFO, capture tree, descendant or process group, invoke owner
functions, send signals, or reproduce an orphan/overflow/filesystem-race scenario.
No blocked action may be retried, translated or routed through another tool,
agent or provider. No evidence/gate waiver follows from this correction.

Two grouped cases: observed NUL, NUL+literal, newline, partial1byte and bounded16byte
inputs all produce observed; emptyEOF produces empty at every inspected site.
This is source-bound primitive evidence ONLY, not whole-owner/lifecycle proof.
Existing approved gates remain independently required. Existing root-run evidence:
actual-predicate-red.json/log: source6d73f481..., exit1, one expected assertion
failure plus one control pass; proposed-predicate-green.json/log: external proposed
source89a875d6..., exit0, two passes. These are existing evidence, not a fresh run
of this fallback copy and not current native-repair acceptance. No missing-module
failure is expected because the original failure is behavioral.

## Coupling and review constraint

The extractor intentionally binds the four inspected source sites and fails closed
if their count or the narrow inert grammar changes. This is brittle to harmless
source refactoring; do not silently broaden executable extraction or require
format beyond those reviewed predicates. If the native fix adopts an equivalent
layout outside this grammar, supervisor must review that mismatch before freeze.
A future tiny pure predicate helper might reduce source coupling, but a new public
API is not required by this narrow correction and would need its own actual-callsite
binding review. No runtime lifecycle substitute is authorized by this alternative.
