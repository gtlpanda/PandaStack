# Security-audit execution restrictions

This additive host-frozen instruction preserves existing execution restrictions. It does not change a finding's disposition, waive evidence, broaden the selected implementation, or authorize an audit of the target application.

## Prohibited reproductions

Do not retry, reconstruct, translate, reroute, or execute any previously blocked reproduction, including:

- The nested-capture orphan/overflow reproduction blocked during the 2026-11-10 native hunt.
- The previously blocked filesystem-race reproduction.
- F2 from the 2026-11-11 final native hunt of accepted b766adad72e58583fa7b1f3af0bed43e1e52953b: the shared-repository Git ownership/trust reproduction rejected by the safety filter. The owning hunt terminated with exit12. That rejection is an execution boundary, not proof that the finding is invalid or fixed.

These restrictions apply to all agents and stages, including builders, reviewers, hunters, reproducers, repairers, fix verifiers and evidence runners. Do not use another tool, agent, provider, session, payload, test fixture or later phase to recreate the same blocked action. Do not bypass the safety filter, alter the blocked scenario into an equivalent reproduction, or claim that a passing unrelated check verified it.

Preserve blocked status and the resulting evidence limitation. Static review, pure validation and separately reviewed ordinary inert fixtures remain available within their explicit selected scope; none is hostile-containment proof. If a requested check recreates a prohibited scenario, stop that check and retain the limitation for the supervisor. Broad completion requests, a new feature selection, a successful gate or a changed runner do not revoke this boundary.

## SA-RV01 selection

SA-RV01 owns only conservative review-baseline accounting and its reviewed ordinary acceptance fixtures. It authorizes no F2 repair/reproduction, target-application change, provider fallback or gate waiver. Preserve the existing review range, host-owned gates, review acknowledgment, retry limits and commit ownership.

The reviewed review-baseline acceptance uses ordinary independently owned temporary Git histories with existing fake Codex responses and the existing clean fake-hunt mode. Its valid-history and absent/malformed-backlog cases do not recreate the blocked shared-repository ownership/trust scenario. Do not expand those fixtures into an ownership/trust experiment.

The supervisor must provide this exact frozen document alongside the selected contract to every later handoff or provider stage whose work could reach the blocked scenarios. A handoff omitting these restrictions does not authorize those actions. Any later change to the propagation mechanism requires its own bounded review; this document itself does not activate a provider or replace a pinned runner.
