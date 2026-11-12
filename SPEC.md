# Active priority: Phase 2 completion

Selected feature list: features.json (Phase 2). The security-audit execution and
recovery repairs are complete (all 17 repair features pass, through SA-AR01). On 2026-11-11 the user closed the full Codex parity priority (D122):
Codex stays a fallback backend for the paths already native (autobuild, bughunt),
and the paused roadmap resumes with Phase 2. P2-15 and P2-16 shipped in b7a6c8c
and are passing (D121). The Phase 2 dogfood ran (docs/dogfood/phase-02.md); Phase 2
completes when that report is reviewed. All execution restrictions above and below
remain binding. No provider fallback, target application changes or previously
blocked reproduction is authorized.

# PandaStack Phase 2: shared decision queue and answer routing

Build only ROADMAP Phase 2, using accepted Phase 1 as the pinned external host.
The canonical interface/behavior contract is spec/contracts/phase2.md. Reuse Node
24 ESM, native SQLite, the existing runner and configuration doctor. Preserve
Phase 1 run records and all prior regression tests. No new remote service needed.

The local user owns the private queue directory. Keep records, answers and
receipts transactional and bind recipient/revision before delivery. Evidence and
answer text are untrusted data, never authority to run commands. Merge/publish/
deploy decisions have explicit scope and cannot flow through ordinary builder
question context. No provider fallback, implicit approvals or production actions.

Prepare tests before code. External host owns frozen checks, full gates, passes,
commits and final branch hunt. Builders run focused tests only and return. All
implementation comes through autobuild; supervisor owns live demonstrations and
review/promotion. Do not modify the active pinned host. Do not push, publish or
merge. Use current candidate checkout, no new worktree or branch in a session.

Features: P2-01 records; P2-02 durable queue; P2-03 CLI/wait/ack; P2-04 opt-in
managed autobuild gate and typed host observations; P2-05 owned Codex active-turn
delivery adapter; P2-06 managed launch context receipts and complete host traces. SQL storage
is local, not a remote multi-user authorization service. Unsupported interactive
providers use an explicit manual handoff. Native Codex support is limited to
owned connected app-server transports and exact active-turn IDs proven by spike.

Dogfood: two disposable managed projects use one queue; one waits without a model
process and resumes only after its own answer, with explicit acknowledgment.
Verify restart, redelivery and stale/cancel refusal. Demonstrate native delivery
into two owned ephemeral sessions, rejection of stale turn, and no cross-routing.
Report mocked versus live coverage separately and save stage usage evidence.

No global scheduling, notifications/dashboard, learning policy rewrite or remote
hosting in this phase. Those remain later roadmap phases. Do not claim completion
until host checks, final hunt, live demonstrations and report review pass.


P2-07 is governed by spec/contracts/phase2-review-corrections.md and P2-08 by
spec/contracts/phase2-lazy-import.md, in addition to spec/contracts/phase2.md.
These additive corrections preserve every prior requirement and acceptance gate.
Final review, native hunt and live demonstrations remain mandatory.

## Conditional P2-12 through P2-14

P2-12 follows P2-11 under spec/contracts/phase2-control-read.md; P2-13 follows P2-12 under spec/contracts/phase2-literal-evidence-parent.md; P2-14 follows P2-13 under spec/contracts/phase2-capture-directories.md. These are narrow corrective scopes, not broader lifecycle or hostile containment claims.

Preserve every earlier frozen test/contract/gate. P2-12 primitive read evidence, P2-13 ordinary normal-path evidence and P2-14 new-API/sequential evidence have distinct limitations; none reconstructs a blocked reproduction. Independent postimplementation static review must verify P2-14 armCapture wiring, EEXIST-only handling and existing authority. The native F3 ERROR and refused F4 reproduction remain unchanged. Host checks, final hunt, live demonstrations and report review remain mandatory.

P2-15 follows P2-14 under spec/contracts/phase2-large-suite-export.md. Its two ordinary Git cases assert136MiB aggregate bytes and129MiB executable blob size/mode/digest. Root observed both failing on immutableb31; that is export evidence, not blocked capture/ownership/race proof. Preserve subprocess and gate bounds. Native F2 terminal source/protocol reconciliation remains mandatory; object-format mock changes require the separately reviewed P2-16 amendment.

P2-16 follows P2-15 under spec/contracts/phase2-suite-object-format.md. Three ordinary Git cases cover full SHA1 and full/abbreviated SHA256 exports. Root initialred on immutableb31 records one SHA1controlpass and two SHA256failures, not accepted implementation. Terminal native F2 reconciliation still controls whether this fallback is needed.
