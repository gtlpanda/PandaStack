# Codex parity inventory — read-only current source

Observed HEAD `364cb2b7c29f245df053c66ba6a37161dfa131ad` at 2026-11-10T22:33:06.299927+00:00. Security repairs remain first. This is an inventory and missing-proof plan, not implementation or runtime certification.

## Installer boundary

`install.sh` installs each direct core/kit/graph skills, agents, workflows, commands and bin entry flat under Claude. `--codex` explicitly allows only autobuild and bughunt in ~/.agents/skills, excludes other assets/settings/hooks and does not install the PATH executable. Existing symlinks from other setups are not proof of native support.

Inventory: 45 skill-directory entries (including decisions shared library), 6 workflows, 46 other directory assets plus 4 fixed targets. JSON enumerates every target and hashes skill/workflow/asset sources.

## Offering-by-offering classification

| Offering | Kind / status | Missing parity work |
|---|---|---|
| backlog | shared-reference-contract; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| bug-lenses | shared-reference-contract; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| decisions | shared-library-no-entry-skill; provider-neutral-core-plus-Codex-specific-delivery | Not a standalone command; include dependency resolution for every native consumer; Interactive Claude delivery not assumed from shared queue |
| default-stack | shared-reference-contract; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| findings | shared-reference-contract; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| gtm-brief | shared-reference-contract; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| harness-review | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| knowledge-map | shared-reference-contract; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| run-records | shared-reference-contract; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| verify | guided-offering; provider-neutral-helper-install-gap | Resolve script without CLAUDE_SKILL_DIR/~/.claude fallback; Same complete stdout/stderr retention, timeout and nonzero exit behavior in native callers |
| workflow-state | guided-offering; provider-neutral-injector-Claude-Workflow-consumer | Native workflow runner for emitted script; injection CLI alone is not runtime parity; Same duplicate-args/input size/refusal tests with native consumer |
| build-bot-integration | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| build-scraper | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| clean-gone | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| commit | guided-offering; partial-Claude-tool-or-output-dependency | Translate specific Agent run_in_background/frontmatter/optional Claude setup semantics through supported native owner; Offline per-stage output and failed-subagent behavior tests; no implicit optional Claude integration parity |
| copywriting | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| deep | guided-offering; partial-Claude-tool-or-output-dependency | Translate specific Agent run_in_background/frontmatter/optional Claude setup semantics through supported native owner; Offline per-stage output and failed-subagent behavior tests; no implicit optional Claude integration parity |
| deep-fix | guided-offering; partial-Claude-tool-or-output-dependency | Translate specific Agent run_in_background/frontmatter/optional Claude setup semantics through supported native owner; Offline per-stage output and failed-subagent behavior tests; no implicit optional Claude integration parity |
| dockerize | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| dry | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| error-audit | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| fix-scraper | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| frontend-design | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| init-agents | guided-offering; Claude-specific-output-partial | Define Codex AGENTS/agent configuration counterpart while preserving requested Claude output compatibility; Verify actual native discovery/routing/permissions; do not translate frontmatter into presumed capability |
| init-ci | guided-offering; partial-Claude-tool-or-output-dependency | Translate specific Agent run_in_background/frontmatter/optional Claude setup semantics through supported native owner; Offline per-stage output and failed-subagent behavior tests; no implicit optional Claude integration parity |
| init-claude | guided-offering; Claude-specific-output-partial | Define Codex AGENTS/agent configuration counterpart while preserving requested Claude output compatibility; Verify actual native discovery/routing/permissions; do not translate frontmatter into presumed capability |
| init-env | guided-offering; partial-Claude-tool-or-output-dependency | Translate specific Agent run_in_background/frontmatter/optional Claude setup semantics through supported native owner; Offline per-stage output and failed-subagent behavior tests; no implicit optional Claude integration parity |
| init-monorepo | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| init-tasks | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| init-tests | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| logging | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| release | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| render | guided-offering; provider-neutral-helper-install-gap | Relocatable Bash/curl/jq wrapper and credential path review; Read-only API fake transport tests; no remote calls during port proof |
| scaffold-app | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| security | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| seo | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| vendor-lens | guided-offering; provider-neutral-guidance-unverified-install | Codex-visible installation/discovery and relative dependency resolution; Instruction/tool equivalence review and representative offline output/negative tests; no native workflow claimed by prose |
| autobuild | executable-graph-or-cli; native-supported-with-explicit-limits | Keep native role/model/environment/auth parity regression matrix; tool-hook semantics differ explicitly; do not claim dollar/tool-turn cap equivalence; Full offering install/uninstall without Claude dependency remains broader installer work |
| blueprint | executable-graph-or-cli; Claude-Workflow-only | Native graph adapter preserving interview pause/resume and exactly one approval; Actual saved-state CLI tests through every stage/error plus immutable-input validation |
| build-app | executable-graph-or-cli; Claude-only-launcher-with-provider-neutral-ledger | Explicit backend dispatch: session.mjs runClaude/Claude hooks/Haiku probe must receive native equivalent; Depends on native dev+nested QA; no fallback to Claude; full driver stop/resume/PR gates tests |
| dev | executable-graph-or-cli; Claude-Workflow-only | Native adapter must support nested workflow() in addition to agent(); Fake CLI end-to-end plan/resume/QA/failure tests and native tooling permission parity |
| bughunt | executable-graph-or-cli; native-supported-with-unverified-runtime-edges | Native support does not prove every reproduction/cleanup boundary; preserve current explicit prohibited scenarios; Graph schema adapter optional-field parity and per-leaf checkpoint tests; no clean-verdict promise |
| release-pr | executable-graph-or-cli; Claude-Workflow-only | Native adapter plus explicit approval boundary, no inferred consent; Offline gh/deploy fake tests matching exact-head, unknown, resume, notification authorization; real remote actions not part of port proof by default |
| security-audit | executable-graph-or-cli; Claude-Workflow-only-with-provider-neutral-host-helpers | Priority eight repairs first, including true optional-schema handling, per-agent checkpoint/resume and partial reports; Native source-reader transport/tool enforcement, capability preflight, same upstream gates; do not merely symlink skill |
| seo-check | executable-graph-or-cli; provider-neutral-helper-install-gap | Resolve own installed path without ~/.claude; Codex installer and CLI success/failure fixtures |

## Executable graph detail

### autobuild

Owner: `graphs/autobuild/tool/lib/loop.mjs`, `graphs/autobuild/tool/lib/codex.mjs`, `graphs/autobuild/tool/lib/codex-gate.mjs`

Stages: config/preflight → feature selection → builder → host frozen/full/progress gate → commit → limit probe/wait/retry → final review → native bughunt

Gates: host controls flags/commit; frozen files; full test gates; noProgress/iteration/time bounds; no unsupported dollar caps

Recovery: completed feature resume; bounded provider-limit wait; signals/timeouts; failed gate feedback

Reports: host logs; feature flags; run lifecycle; Codex token usage; dollars unknown; hunt ledger/report

### bughunt

Owner: `graphs/hunt/skills/bughunt/native-cli.mjs`, `graphs/hunt/skills/bughunt/native-runner.mjs`, `graphs/hunt/workflows/bughunt-flow.js`

Stages: impact → lens hunters → blind skeptic → referee → reproduction/evidence → repair → independent fix verification → full comparison → recheck/landing

Gates: same graph/schema/ledger; partial coverage remains nonclean; exact head; independent evidence; safe blocked/incomplete comparisons

Recovery: persisted ledger/evidence; bounded repair attempts; unknown/blocked manual disposition

Reports: native result; coverage entries; findings ledger; markdown report; evidence records

### blueprint

Owner: `graphs/blueprint/workflows/blueprint-design.js`, `graphs/blueprint/skills/blueprint/write-docs.mjs`

Stages: extract → question/interview → human answers → design → advisor gate/revise → slice backlog → advisor backlog gate → one approval → write docs

Gates: binding answers; design/backlog bounded rounds; max questions; knowledge ownership; default stack departures

Recovery: saved request/state/run1/run2/run3; gate revision loop; needs-human/escalate

Reports: approved design; backlog; decisions; saved ledgers

### dev

Owner: `graphs/dev/workflows/dev-build.js`, `graphs/qa/workflows/harness-repair.js`

Stages: planner → advisor plan gate → scout → implementer → host check → acceptance auditor → triage → nested QA

Gates: plan approval; bounded planning; acceptance criteria evidence; verification; nested QA result

Recovery: saved approved plan/ledger; resume; needs-human; escalation/stuck signature

Reports: plan; acceptance evidence; ledger; commit/result summary

### build-app

Owner: `graphs/build/skills/build-app/driver/driver.mjs`, `graphs/build/skills/build-app/driver/session.mjs`

Stages: backlog preflight → isolated integration checkout → per-slice dev session → driver checks/commit → final QA → bughunt fix → push/PR

Gates: backlog/earlier dependencies; driver lock; own acceptance checks; final QA/hunt; PR publication policy

Recovery: status/stop/resume/unblock; persisted build ledger; usage wait/probes

Reports: status.json; ledger; session logs; PR

### release-pr

Owner: `graphs/release/workflows/release-flow.js`

Stages: docs → ready → human exact-head approval → land → verify deploy → advisor recommendation

Gates: exact PR/head/base approval; fresh head/base read; match-head merge once; MERGED resume skip; UNKNOWN manual; merge-SHA deploy proof; two consecutive health failures

Recovery: saved ledger/approval; bounded verify rounds; stale approval; unknown merge no retry

Reports: docs/changelog; release ledger; deploy evidence; rollback recommendation

### security-audit

Owner: `graphs/security-audit/workflows/security-audit-flow.js`, `graphs/security-audit/skills/security-audit/audit-run.mjs`, `graphs/security-audit/skills/security-audit/audit-stage.mjs`, `graphs/security-audit/skills/security-audit/audit-report.mjs`

Stages: init committed snapshot → four recon researchers → synthesize → seed → plan waves → hunters → merge → coverage critic → mint/apply critic → consolidate → validate → write findings → independent Phase5 verification → report

Gates: explicit full audit; upstream validators/schema; source-only needs_validation; budget reserves; coverage completeness; independent challengers; no target execution

Recovery: stage-state/next; stage result apply idempotency; bounded malformed-result retry; prior-run carry; individual checkpoint gap

Reports: REPORT.md; FINDINGS-DETAIL.md; NEEDS-VALIDATION.md; coverage ledger; findings; remediation export

### seo-check

Owner: `graphs/seo/skills/seo-check/seo-check.mjs`

Stages: built HTML scan → metadata/link/schema/sitemap checks → safe report

Gates: actual built artifact assertions; nonzero failure

Recovery: rerunnable CLI; no agent ledger

Reports: text or JSON check result

### /loop and QA (no separate skill directory)

`loop.md` delegates to `graphs/qa/workflows/harness-repair.js`: checker → fixer → reviewer → advisor triage → QA; bounded fix rounds/stuck signatures, verification gates, saved loop ledger and escalation. `dev-build.js` calls nested `workflow(...)` for this same QA. No native QA runner was identified. Port both standalone /loop routing and nested calls, preserving nonzero/incomplete state and recovery.

## Shared assets and aliases

The following are roles/commands/integrations rather than independent implemented graph engines. Every item is installed in Claude mode; none is directly installed by current --codex allowlist. Native adapter mapping must preserve role instructions, supported tools, model effort selection and independent-role boundaries without assuming Claude frontmatter is honored.

- `agents/advisor.md` ← `core/agents/advisor.md`: shared role definition; Claude frontmatter not native registration
- `agents/checker.md` ← `core/agents/checker.md`: shared role definition; Claude frontmatter not native registration
- `bin/statusline.sh` ← `core/bin/statusline.sh`: Claude statusline integration
- `agents/agentic-ux-reviewer.md` ← `kit/agents/agentic-ux-reviewer.md`: shared role definition; Claude frontmatter not native registration
- `agents/cloudfront-invalidator.md` ← `kit/agents/cloudfront-invalidator.md`: shared role definition; Claude frontmatter not native registration
- `agents/design-lead.md` ← `kit/agents/design-lead.md`: shared role definition; Claude frontmatter not native registration
- `agents/google-ads-strategist.md` ← `kit/agents/google-ads-strategist.md`: shared role definition; Claude frontmatter not native registration
- `agents/icp-review.md` ← `kit/agents/icp-review.md`: shared role definition; Claude frontmatter not native registration
- `agents/qa-engineer.md` ← `kit/agents/qa-engineer.md`: shared role definition; Claude frontmatter not native registration
- `agents/terraform-staff-engineer.md` ← `kit/agents/terraform-staff-engineer.md`: shared role definition; Claude frontmatter not native registration
- `agents/ui-design-reviewer.md` ← `kit/agents/ui-design-reviewer.md`: shared role definition; Claude frontmatter not native registration
- `agents/ux-ai-framework-advisor.md` ← `kit/agents/ux-ai-framework-advisor.md`: shared role definition; Claude frontmatter not native registration
- `agents/wiring-check.md` ← `kit/agents/wiring-check.md`: shared role definition; Claude frontmatter not native registration
- `commands/aws-arch-review.md` ← `kit/commands/aws-arch-review.md`: provider-neutral advisory command; Codex alias missing
- `commands/founding-sales.md` ← `kit/commands/founding-sales.md`: provider-neutral advisory command; Codex alias missing
- `agents/architect.md` ← `graphs/blueprint/agents/architect.md`: shared role definition; Claude frontmatter not native registration
- `agents/extractor.md` ← `graphs/blueprint/agents/extractor.md`: shared role definition; Claude frontmatter not native registration
- `agents/questioner.md` ← `graphs/blueprint/agents/questioner.md`: shared role definition; Claude frontmatter not native registration
- `agents/slicer.md` ← `graphs/blueprint/agents/slicer.md`: shared role definition; Claude frontmatter not native registration
- `workflows/blueprint-design.js` ← `graphs/blueprint/workflows/blueprint-design.js`: workflow asset; see workflows
- `agents/acceptance-auditor.md` ← `graphs/dev/agents/acceptance-auditor.md`: shared role definition; Claude frontmatter not native registration
- `agents/implementer.md` ← `graphs/dev/agents/implementer.md`: shared role definition; Claude frontmatter not native registration
- `agents/planner.md` ← `graphs/dev/agents/planner.md`: shared role definition; Claude frontmatter not native registration
- `agents/scout.md` ← `graphs/dev/agents/scout.md`: shared role definition; Claude frontmatter not native registration
- `workflows/dev-build.js` ← `graphs/dev/workflows/dev-build.js`: workflow asset; see workflows
- `agents/fix-verifier.md` ← `graphs/hunt/agents/fix-verifier.md`: shared role definition; Claude frontmatter not native registration
- `agents/hunter.md` ← `graphs/hunt/agents/hunter.md`: shared role definition; Claude frontmatter not native registration
- `agents/impact-mapper.md` ← `graphs/hunt/agents/impact-mapper.md`: shared role definition; Claude frontmatter not native registration
- `agents/repairer.md` ← `graphs/hunt/agents/repairer.md`: shared role definition; Claude frontmatter not native registration
- `agents/reproducer.md` ← `graphs/hunt/agents/reproducer.md`: shared role definition; Claude frontmatter not native registration
- `agents/runner.md` ← `graphs/hunt/agents/runner.md`: shared role definition; Claude frontmatter not native registration
- `agents/skeptic.md` ← `graphs/hunt/agents/skeptic.md`: shared role definition; Claude frontmatter not native registration
- `workflows/bughunt-flow.js` ← `graphs/hunt/workflows/bughunt-flow.js`: workflow asset; see workflows
- `agents/fixer.md` ← `graphs/qa/agents/fixer.md`: shared role definition; Claude frontmatter not native registration
- `agents/qa-auditor.md` ← `graphs/qa/agents/qa-auditor.md`: shared role definition; Claude frontmatter not native registration
- `agents/reviewer.md` ← `graphs/qa/agents/reviewer.md`: shared role definition; Claude frontmatter not native registration
- `workflows/harness-repair.js` ← `graphs/qa/workflows/harness-repair.js`: workflow asset; see workflows
- `agents/deploy-watcher.md` ← `graphs/release/agents/deploy-watcher.md`: shared role definition; Claude frontmatter not native registration
- `agents/merger.md` ← `graphs/release/agents/merger.md`: shared role definition; Claude frontmatter not native registration
- `agents/release-checker.md` ← `graphs/release/agents/release-checker.md`: shared role definition; Claude frontmatter not native registration
- `agents/scribe.md` ← `graphs/release/agents/scribe.md`: shared role definition; Claude frontmatter not native registration
- `workflows/release-flow.js` ← `graphs/release/workflows/release-flow.js`: workflow asset; see workflows
- `agents/audit-analyst.md` ← `graphs/security-audit/agents/audit-analyst.md`: shared role definition; Claude frontmatter not native registration
- `agents/audit-researcher.md` ← `graphs/security-audit/agents/audit-researcher.md`: shared role definition; Claude frontmatter not native registration
- `agents/audit-synthesizer.md` ← `graphs/security-audit/agents/audit-synthesizer.md`: shared role definition; Claude frontmatter not native registration
- `workflows/security-audit-flow.js` ← `graphs/security-audit/workflows/security-audit-flow.js`: workflow asset; see workflows

`kit/commands/aws-arch-review.md` and `founding-sales.md` are advisory command aliases; expose equivalent native entrypoints/content without inventing persistence. `core/bin/statusline.sh` consumes Claude statusline integration and needs a supported native UI/status counterpart or an explicit unsupported presentation boundary. `init-claude` intentionally emits CLAUDE.md; provider-specific aliases/counterparts must avoid silently changing requested output. `init-agents`, optional init-env permission files and init-ci Claude PR workflow are product output semantics, not merely spelling changes.

## Required evidence before calling full parity

1. Security: all eight priority machinery repairs, full native stage execution, read/search-only enforcement, canonical schema validation, preserved independent challenges and source-only needs_validation, per-agent resume and partial reports.
2. Shared native transport: schema compatibility, role/tool enforcement, input/output bytes, model/effort selection, bounded owned cleanup, in-flight uncertainty, auth/environment confidentiality, immutable provenance and stage/child linkage. Preserve no-unapproved fallback.
3. Graph adapters: exact stage ledgers/gates and recovery fixtures for blueprint, dev plus nested QA, build-app, release. Mock gh/deploy/remote services for tests; port authorization checks without taking remote actions.
4. Installer/discovery: all explicitly offered skills plus dependent assets discoverable from clean native-only HOME; portable path resolution, collision/backups/uninstall/skip behavior, no automatic Claude settings/hook import.
5. Guidance/shared modules: read the same reference content and run real owning helper checks; smoke generated artifact/output and error semantics for each offering. Prompt-only usability is distinct from durable graph parity.

No live tools/providers/installers or tests were run for this inventory. No current native graph support implies every target reproduction scenario is proven; existing prohibited reproductions remain prohibited. Do not force coverage/clean verdicts.
