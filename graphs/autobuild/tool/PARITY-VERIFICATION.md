# Provider parity verification — 2026-11-09

The Claude and Codex autobuild paths now share the final hunt graph, findings
ledger, reproduction and independent repair checks, landing rules and PR gate.
The Codex-only audit shortcut is removed. Provider-specific sandbox/hook and
USD-versus-token/time limits remain explicit in the README.

## Automated verification

`scripts/test.sh` exited 0:

- VALIDATE: PASS
- TEST-INSTALL: 138 passed, 0 failed
- TEST-SECRETS: 22 passed, 0 failed
- TEST-WORKFLOW: 1425 passed, 0 failed (includes the awaited native-runner suite)
- TEST-AUTOBUILD: 106 passed, 0 failed
- TEST: PASS

The native runner suite has 15 direct cases. Targeted native/Codex/status tests
passed 39 cases. Four additional permanent lock tests cover both providers.
The final full suite includes those cases, not only the targeted runs.

## Real Codex verification

A disposable frozen-test project used saved CLI authentication with the Claude
executable deliberately unavailable. Astra built and reviewed the feature; Sol
ran specialist hunt leaves; the host gated and committed the work. The unchanged
review-status reader returned `hunted: true`, `disposition: pass`. Resuming used
the genuine ledger, reran the host gate and returned 0 without new model calls.

A second disposable project deliberately changed addition into subtraction.
The native fix run found and reproduced one defect, repaired it, and obtained
independent verifier acceptance. Standalone fix intentionally retained the
repair without landing: its original broken target still requested changes.
The existing host `landHunt` then verified and landed one commit; review-status
recognized the verified repair and returned pass. No source-under-review or
production branch was changed by the model.

## Defects caught during integration

- Actual Codex rejected the shared graph schema with HTTP 400 because strict
  objects require additionalProperties=false. Provider normalization fixed it;
  the repeated real Luna call completed with schema-valid JSON.
- A done ledger could be visible before host recheck/report. The runner now
  publishes incomplete state until all host verification is complete.
- A competing review could prepare/reset an active repair worktree before
  acquiring ownership. Both providers now acquire the common repository lock
  before preparation; exact native/Claude competitor probes preserve the active
  repair, source HEAD and intake and create no attempt branch.

Independent audit found no remaining verified blocker within the examined
routing, failure, isolation, schema, installation and landing scope. Live
smokes are small synthetic JavaScript repositories, not proof of identical
model quality on arbitrary applications. No review guard is disabled.
