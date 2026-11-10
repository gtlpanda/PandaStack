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
