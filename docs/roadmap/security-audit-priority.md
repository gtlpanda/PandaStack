# Security-audit execution and recovery priority

Status: active preparation; broader roadmap paused after P2-14 at
364cb2b7c29f245df053c66ba6a37161dfa131ad. This is the user's explicit priority
handoff, not a new Terracotta application audit or application repair.

## Incident evidence

The preserved audit concerns a5288f8f130ad581a0879c2d7f88b59228f149f3.
There are 52 needs_validation records, four rejected records, and one pending
record. The final verification pass did not run. 121 coverage units and 202
recorded invocations do not establish 52 confirmed vulnerabilities. The critic
script was rejected at 505230 bytes against the unchanged 500000-byte limit.
A read-only current check still reports 208 snapshot permission problems.
The original run and its provisional evidence remain untouched.

## Required outcomes and dependency order

1. SA-01: Verify actual exported snapshot permission bits during initialization,
   before publication or agents. Retain exact source and existing cleanup.
   This prerequisite is not a same-user hostile-code isolation claim.
2. SA-02: Durable individual attempt receipts and progress-report generations.
   Reserve before dispatch, persist completion immediately, reuse completed
   siblings on restart. Unknown dispatched attempts stay held pending terminal
   reconciliation. Model output cannot select receipt paths/identities.
3. SA-03: Per-dispatch invocation budgets plus after-wave forecasts; reserve
   concrete critic/validation/verification/reporting work. New native runs require
   finite budgets. Explicit nonterminal budget checkpoint accepts adjustments
   only within a caller-provided maximum and never silently raises the grant.
   Dollar cost remains unknown when the provider does not supply it.
4. SA-04: Exact legal transition vocabulary and two-attempt logical retry limits
   persisted across restarts. Critics cannot reopen deferred units. Host budget
   resume is limited to budget-deferred work in a nonterminal run. Preserve the
   first terminal reason and report retained evidence.
5. SA-05: Full-evidence subsystem critic partitions plus global reconciliation.
   Deterministic manifest binds every unit, evidence reference, part hash and
   reconciliation result. Do not advance until every required part is valid.
   Exercise a fixture larger than 121 units and 505230 bytes. No limit increase
   or evidence clipping may satisfy completion.
6. SA-06: Canonical absent optional fields, semantic prevalidation and targeted
   slot retries. Retain valid siblings exactly; no coercion of invalid nulls,
   cross-unit duplicate suppression or weakening upstream validators.
7. SA-07: Native Codex stage execution through the existing trusted workflow,
   scheduler and validators, with host-owned agent callbacks providing durable
   reservations and results. Independent research/hunt/verification sessions.
   No Claude fallback. Fake protocol E2E must produce all three final reports;
   real provider capability/dogfood evidence must be separately labeled.
8. SA-08: Source-only native reader and verified tool restrictions. Bounded
   list/read/literal-search access confined to the committed snapshot. No target
   execution, shell, writes, arbitrary MCP/config inheritance or network tools.
   Fail before inference if restrictions cannot be established. A read-only
   filesystem sandbox or prompt alone does not prove this property.
9. SA-09: Supported installation and preflight reporting: provider, runtimes,
   exact capability support, model/effort and observed account context. Billing
   identity unknown remains unknown; never claim subscription means zero cost.
   Preserve legacy Claude installation and reject unsupported backend execution.
10. SA-10: Integrated interrupted/large-run fixture, final independent review,
    actual filesystem evidence, bounded native Codex-only toy dogfood and three
    reports. No audit of the original target, no promotion of source-only leads.

Each item may split into smaller host-selected features before its tests freeze.
Implementation uses the accepted external autobuild host and current candidate
checkout. Host owns frozen contracts/tests, gates, flags and commits. Builders
run only focused tests. Preserve every existing baseline/vendor/schema byte and
prior phase acceptance. Preserve original Phase 2 inputs for resumption; P2-15
and P2-16 remain unstarted. No pushes, merges or deployments.

## Shared decisions

- The authoritative nextStep remains the only stage scheduler. Native transport
  does not implement a second audit lifecycle.
- Trusted workflow evaluation may execute installed workflow code, never source
  exported from the target or model-returned JavaScript.
- Native callbacks are a real host checkpoint seam. Claude Workflow aggregate
  transport cannot claim individual recovery until an equivalent real seam exists.
  Keep that limitation explicit rather than inventing a runtime callback.
- Durable attempts distinguish prepared, dispatched/unknown, returned and
  semantically accepted. Returned-invalid records remain charged and visible.
- One owning host writes a run; no distributed multi-writer guarantee is claimed.
- Checkpoints render readable pending leads, counts, coverage gaps, unknown
  dispatches and blockers. Report-generation failure cannot relaunch completed
  agents or present old prose as current; final validators remain mandatory.
- Existing completed/incomplete terminal runs are not silently reopened. An old
  run requires an explicit continuation binding before any future recovery.
- Snapshot permission checks and restricted tool capabilities are complementary;
  neither constitutes hostile same-user OS isolation.
- All blocked capture/orphan/overflow and filesystem-race reproductions remain
  prohibited across this priority batch. No retries, translations, rerouting,
  waived gates or claims of evidence that was never obtained.

## Completion standard

All eight user handoff requirements must have concrete evidence. Mock tests prove
wiring and deterministic behavior, not actual provider capability or isolation.
A feature passing is not overall completion. Retain coverage consolidation,
independent challenge, pinned validators and honest needs_validation semantics.

## Expanded user priority: full Codex workflow parity

The user explicitly requires security and every other offering ported to Codex,
with full workflow parity. Security execution/recovery repairs remain first.
Inventory every installer-visible executable offering and workflow; shared
documentation and aliases must be identified rather than counted as ports.
For each offering, track native entrypoint, stage/role/model configuration,
tool permissions, scheduler/gates, persistence/resume, cost accounting, reports,
installation/preflight and end-to-end acceptance. A visible skill link is not
runtime support. Do not silently fall back to Claude or omit workflow stages.

Use shared native transport where appropriate with explicit per-role capability
profiles; security remains source-only while builders retain their authorized
implementation tools. Preserve independent review and existing graph semantics.
No offering is marked parity-complete based solely on mocks, documentation or
installation. Separate deterministic fixture proof from actual native runtime
evidence and state external-service limitations explicitly. Broader product
expansion stays paused until this priority work is complete.
