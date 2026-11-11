# Review-baseline correction — proposed bounded contract

Status: UNSELECTED / UNFROZEN / NOT IMPLEMENTATION AUTHORITY. Static preparation only. This correction precedes SA-05b implementation. The root host owns selection, frozen acceptance, gates, commits and any runner promotion. No candidate or pinned-host changes are made by this handoff.

## Confirmed source defect and observed reachability

At accepted b766adad72e58583fa7b1f3af0bed43e1e52953b, graphs/autobuild/tool/lib/loop.mjs:217 chooses the newest chore(review) commit before considering the selected feature file's first commit. passedSince at lines87–95 returns zero when that historical blob is missing or cannot be parsed. reviewIfDue:222 and the final-review condition:242 treat zero as no outstanding review, and lines258–267 can start the hunt and later report Done.

Actual read-only history: newest review is 8a1a2d6c9316f13d1f3e516122e8b9fa7c4a0d47; git show of features-security-audit.json there exits128 because the path is absent. The selected file was added at73b5fa4412b22cbc2fbf2c6c3759e09bbdefcd74 with one feature, zero passing. Accepted HEAD has14 features, all passing. The ordinary host log /var/tmp/pandastack-autobuild-final-b766adad-8oz_68oa/host.log begins preflight then hunt without a review. This is source-plus-existing-run evidence, not a newly executed reproduction. The active hunt remains useful independent work; it does not discharge the missing final review.

## Scope and required behavior

Own only review-baseline accounting in graphs/autobuild/tool/lib/loop.mjs and a narrowly extracted helper if useful, plus additive focused implementation tests and host-selected acceptance. No provider/model changes, review gate weakening, frozen-test changes, marker forgery, feature flags, target audit, or changes to hunt semantics.

Unknown historical feature state must never be evidence that all current passing work was reviewed. The required correction is conservative accounting: if git show fails, JSON is invalid, or the historical feature document is structurally invalid, count every current passing feature as unreviewed while retaining the already selected earlier review SHA as the review range anchor. That older anchor includes the later selected backlog's additions and fixes; it must not be replaced with HEAD merely to obtain a readable blob. Extra review is acceptable; silently skipping review is not.

A structurally usable historical snapshot has an object containing a features array, non-null object entries, unique nonempty string IDs and boolean passes fields. Other feature fields remain accepted; this is not a new whole-backlog schema. Any malformed row invalidates the historical comparison as a whole rather than letting truthy values or partial rows prove reviewed work. A valid empty historical features array compares as an empty set. Use the current backlog's existing passing semantics; do not silently repair its data here.

For a valid historical snapshot, preserve the existing set difference by feature ID: current passing IDs not passing at the review baseline are outstanding; removed historical IDs do not count. With no review commit, preserve the existing first-addition range behavior and existing restart regression. Missing/unusable historical feature data must produce conservative outstanding work; never zero solely because that evidence was unreadable. A fallback range is not itself proof that a review happened.

Both periodic startup review and final review use the corrected accounting. Successful review acknowledgment still requires the existing new chore(review) commit and provider-specific host gate. A failed review retains its range and work; the existing bounded two-attempt final-review failure exits13 and does not report Done. Keep finalReview:false, reviewEvery and all existing completion/hunt/frozen-control gates unchanged. No claim that an old review's commit subject establishes stronger provenance than the current design already grants.

## Evidence and execution boundary

No tests, imports of candidate code, fake provider processes or real providers were run in preparing this contract. Future host-approved checks use ordinary throwaway Git history, existing fake provider transports, deterministic finite results and existing gate conventions. No process-kill, overflow, nested-capture orphan, filesystem-race, hostile containment or target-code reproduction. Existing prohibited scenarios remain prohibited.

A successful correction must be independently reviewed and accepted by the root host. If the root later promotes it, a new pinned runner must bind the accepted correction and required fresh ordinary evidence. Do not mutate the current pinned runner or retroactively call the already-started hunt evidence of final review.
