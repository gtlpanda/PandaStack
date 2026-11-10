# Phase 1 supplemental coverage inspection

User authorized continuing the entire roadmap on 2026-11-10. This supplemental
read-only review addresses the prior native hunt's three named coverage gaps;
it does not replace the native graph ledger or grant a review waiver.
Target c6854a67c56854e9eff1f3ed90319713805e685f; base 18eabde206c5041e098102b939877c8e4c99fb85.

Read all retro.md:1-3178 and PROGRESS.md:1-282, including historical failed checks
and limitations. PROGRESS.md:243-270 disposes of prior doctor/store findings;
PROGRESS.md:282 preserves the last manual_review result.

Read complete graphs/hunt/bench/make-fixtures.mjs and run-bench.mjs. Shared
runClaude tracking is reached at run-bench.mjs:110-114 and
build-app/driver/session.mjs:57-60; existing arguments, return codes, scoring and
fixture behavior remain unchanged. Standalone benchmark sessions have no
synthetic parent.

Read complete graphs/hunt/skills/bughunt/{native-cli,native-runner,intake,evidence,
land,review-status}.mjs and graphs/autobuild/tool/lib/bughunt.mjs. Traced model
mapping, config override, concurrency/timeout, preparation locks, evidence,
rechecks, provisional publication, verified landing and review coverage.
References: config.mjs:114-146; native-cli.mjs:26-30;
native-runner.mjs:80-88,144-188,264-275,293-331; land.mjs:118-182;
review-status.mjs:121-174. Native hunt leaves bypass the tracked runCodex wrapper,
consistent with deferred native-leaf tracking. graphs/hunt is unchanged vs base.

Rechecked complete tracking/adapters and shared session execution. Tracking
errors retain underlying work and error identity (tracking.mjs:24-47); snapshots
allowlist settings instead of copying prompts/environment (adapters.mjs:32-54).
No concrete introduced defect found in this inspection.

Inherited limitation: retro.md:2081-2084,2103-2110 discusses filter/attribute
export exposure; evidence.mjs:170-178 still exports through source-repository
checkout-index with inherited environment. Phase 1 neither introduced nor
widened this path. Keep it in the Phase 7 isolation design review. This is not
proof that pre-existing hunt/security internals have no defects.

Inspection only: no provider calls, tests, exploit reproductions, ledger edits,
or blocked-reproduction retries were performed by the supplemental reviewer.
A fresh native graph review is required to update the machine-readable result.
