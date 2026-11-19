# Codex parity priority roadmap

Status: active from 2026-11-19 (D125). The binding contract is
spec/contracts/codex-parity-priority.md. The batch plan and its per-offering checks are
spec/codex-parity-completion-matrix.md and .json.

**Goal.** Every offering in spec/offering-capabilities.json runs natively on the Codex
CLI with the same stages, gates, recovery and outputs as on Claude Code.
- Nothing falls back to Claude or silently drops a stage.
- An offering counts as done only with its matrix check met.
- Live Codex evidence comes from an explicitly authorized run, recorded apart from
  fake-codex wiring proof.

## Waves

Each wave is cut into features only when the seams it consumes have passed. Every
feature gets a contract and a frozen test committed by the host before selection.

| Wave | Batches | Consumes | Notes |
|---|---|---|---|
| 1 | CP-01 catalog + install, CP-02 graph host + Codex leaf, CP-03 shared references | existing native-runtime (NR-01, NR-02, OC-01) | 13 features, approved in the priority contract |
| 2 | CP-05 QA/loop, CP-04 blueprint | CP-02e host, CP-03c role loader, CP-02d store | needs a held-call reconcile command before any unattended native graph |
| 3 | CP-06 dev, CP-08 release | wave 2; release needs a verified `release-controlled` profile (network, `gh`) | dev uses the dev-build to harness-repair child edge |
| 4 | CP-07 build-app, CP-09 existing offerings | CP-06; CP-09 migrates autobuild and hunt onto the shared launcher/provider and removes the five duplicated pieces | hunt's `runner` leaf needs a non-model leaf kind |
| 5 | CP-10 bootstrap/config, CP-11 guided engineering, CP-12 git/docs/service tools, CP-13 marketing/SEO | catalog v2 rows, `install-plan`, `SKILL_DIR` rule | render and seo-check still hard-code `~/.claude` |
| 6 | CP-14 full-install conformance; security-audit native entry | everything above; a verified `audit-source-only` recipe | clean Codex-only HOME, every catalog row inspected |

## Open items that need an authorized live step

None of these runs inside an unattended builder session.
- A bounded Codex 0.167.0 capability probe for:
  - `--ignore-user-config` and its effect on MCP, tools and config;
  - the `agents.default_subagent_model` and
    `agents.max_concurrent_threads_per_session` config keys;
  - acceptance of the gpt-6-astra, gpt-6.1-sol and gpt-6-luna model ids.
- A live native Codex smoke for each wave's graphs, recorded as runtime evidence
  separately from the fixture proof.

## Known constraints

- autobuild.json freezes `spec`. spec/offering-capabilities.json is listed as
  writable for this priority because CP-01b, CP-02f, CP-03a and CP-03b edit it.
- Every SKILL.md edit must update its catalog `entrySha256` in the same change;
  CP-01b's drift guard makes a missed update fail.
- Builder sessions on macOS cannot run the Linux-only stores (D22) or the hunt
  isolation. The full gate runs in Linux CI on the PR (pr-first delivery).
