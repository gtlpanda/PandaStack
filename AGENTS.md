# Hotfix release authorization (2026-11-11)

The user explicitly requested this hotfix on main with updated docs and README.
Root may commit documentation, push this branch, open its PR, and merge the
reviewed head after required CI passes. This supersedes the older no-push/merge
restriction for this release only. Preserve all blocked-reproduction and provider
refusal restrictions; do not report an unfinished hunt as complete.

# Temporary PR-first delivery override (user authorized 2026-11-11)

The user's latest priority is reliable delivery today. They explicitly authorized
changing quality gate scheduling/configuration so code can reach a PR before
long regression runs and broad reviews. Implement the bounded PR-first hotfix
directly with parallel agents; the previous pinned-builder-only/full-gate-before-
commit requirements are superseded for this hotfix and its focused validation.
Root owns coordination and commits. Preserve unfinished work and all existing
test assertions. Keep focused acceptance, secret checks, frozen-input integrity
and Git-control protection before a feature commit. Defer full regressions and
broad review/hunt to the PR/merge stage, explicitly reporting them as pending.
Only opt-in PR-first mode may defer these quality checks; ordinary full mode
remains compatible. Draft PR creation may precede review; merge/deploy still
require their checks and authorization. No automatic push/merge/deploy in this
hotfix. Do not alter the immutable pinned host.

This does NOT authorize retrying, translating or rerouting any provider-refused
work or any previously blocked reproduction. Preserve the F2 shared-repository
Git ownership/trust restriction, nested-capture orphan/overflow and filesystem-
race restrictions. No safety-filter bypass, provider fallback, target audit,
target application changes or false verification/completion claims.

# Active priority: Phase 2 completion

Selected feature list: features.json (Phase 2). The security-audit execution and
recovery repairs are complete (features-security-audit.json 17/17, through
SA-AR01). On 2026-11-11 the user closed the full Codex parity priority (D122):
Codex stays a fallback backend for the paths already native (autobuild, bughunt),
and the paused roadmap resumes with Phase 2. P2-15 and P2-16 shipped in b7a6c8c
and are passing (D121); Phase 2 completion still needs its dogfood scenario and
report. All execution restrictions above and below remain binding. No provider
fallback, target application changes or previously blocked reproduction is
authorized.

# Phase 2 autonomous build

Read SPEC.md and spec/contracts/phase2.md. Implement only the next feature chosen
by the pinned external host. Acceptance tests, baseline tests, contracts and gate
configuration are frozen. Do not weaken them. The host owns commits, flags and
final completion. Do not push, merge, change branch, alter Git control or launch
another provider. Use this candidate checkout, no new worktree. Keep work within
Phase 2 decision records, durable queue, routing, opt-in integration and native
owned-session delivery and observational host traces. Add meaningful implementation tests using repository
harness conventions. Run focused tests only inside the session; host runs full
gates. No live provider calls except explicitly launched supervisor dogfood.
Never modify the pinned host checkout. Decision actor text is not authentication;
ordinary answers and scope matches do not grant merge/publish/deploy permission.

Supervisor-reviewed corrective scope: P2-09 may repair installed verification
entrypoint dispatch in core/skills/verify; P2-10 may repair literal path handling
in graphs/hunt/skills/bughunt/evidence.mjs. Follow only the selected contract.
Do not run or recreate the nested-process reproduction rejected during the
2026-11-10 second native hunt. No safety-filter retries, alternate-provider
rerouting or review-gate waivers are authorized.

P2-11 may implement its frozen cooperative capture-ownership contract in
core/skills/verify. Its six pure and one immediate ordinary-success acceptance
cases have completed host review and are authorized to run. This does not
authorize the blocked negative reproduction, alternate payloads recreating it,
or claims of hostile containment. Keep all signal authority in local root-owned
identities. The optional shared helper basename is capture-owner.sh.

## Conditional host-selected corrective scope

P2-12: only the four control-read decision predicates under spec/contracts/phase2-control-read.md; closed-grammar finite-stdin primitive checks are not owner/lifecycle proof.
P2-13: only Bash retention literal evidence-parent checksum/manifest handling under spec/contracts/phase2-literal-evidence-parent.md; two immediate normal-success cases prove only that ordinary path behavior. Native F3 ERROR remains distinct.
P2-14: only prepareCaptureDirectories and armCapture wiring under spec/contracts/phase2-capture-directories.md; five sequential ordinary helper cases are not concurrency or F4 reproduction proof. Preserve evidence-parent policy, realroot mode hardening and root authority.

Do not retry, reconstruct, translate or reroute any previously blocked reproduction, including the nested-capture orphan/overflow reproduction and the filesystem-race reproduction. Do not use another tool, agent, provider, payload or later-phase fixture to perform the same blocked action. This execution restriction persists across phases; a new phase or passing unrelated test does not revoke it. Preserve the blocked status and the resulting evidence limitation. Do not waive evidence requirements, weaken or skip approved gates/tests, or claim the blocked scenario was reproduced or verified. Continue permitted static review, pure validation and separately reviewed benign tests within their explicit scope; if a requested check would recreate a blocked action, stop that check and report the limitation to the supervisor. No implied permission follows from roadmap completion instructions.

P2-15 may correct only ordinary large Git source export under spec/contracts/phase2-large-suite-export.md. The host-reviewed frozen fixture amendment models only cat-file --batch-check; builders may not edit that fixture or add unreviewed object-format behavior. Preserve all capture/race restrictions and owning evidence limits.

P2-16 may preserve actual source Git object format under spec/contracts/phase2-suite-object-format.md, without identifier-length inference. The separately reviewed combined mock supports only the exact source-format query and existing object-path query layouts; it is newly frozen by this package. No source execution, capture or blocked reproduction is authorized.
