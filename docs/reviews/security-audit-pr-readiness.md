# Security-audit foundations PR review

This PR packages accumulated agent configuration, run records, decision routing,
verification repairs, and security-audit execution/recovery foundations. It does
not complete native Codex security audits or parity for every offering. No
Terracotta audit or target application changes are included.

## Merge disposition: changes required

Three independent AI reviewers inspected the audit, native runtime,
decision/storage, and verification/export paths. The following introduced export
regressions remain open, supported by static source tracing against origin/main:

- **Large source export:** `graphs/hunt/skills/bughunt/evidence.mjs` buffers the
  entire `cat-file --batch` response under a 128 MiB subprocess limit. An
  aggregate tree or individual blob exceeding that limit makes suite export
  fail before verification. Main previously used direct checkout to files.
- **Git object format:** the new export initializes a default-format repository
  before reading source objects through alternates. SHA256 source repositories
  fail with a default SHA1 destination. The source storage format is not queried.

The existing P2-15 and P2-16 contracts specify the respective fixes, but the
active user instructions explicitly defer those features. Neither reproduction
nor implementation was attempted during this review. These findings are not
waived because CI passes.

## Boundaries retained

The unfinished native critic executor and its isolated owner additions were
preserved outside the candidate and excluded from this PR. The native stage
entrypoint still explicitly refuses critic execution pending integration.
Offline preflight never promotes an offering to ready or guesses authentication,
account, payer, or provider confinement.

Blocked capture/orphan/overflow and filesystem-race reproductions remain blocked
and unverified. Existing native F3 ERROR and refused F4 evidence are not changed.
Static review found the P2-14 directory helper wiring, EEXIST-only handling,
evidence-parent policy, and root hardening intact; this is not concurrency or
hostile-containment proof.

## Verification scope

GitHub's required `test` job runs the unchanged `scripts/test.sh`. The additional
frozen acceptance/native-hunt gates and final host review are separate; ordinary
CI success does not establish completion of those requirements. Frozen tests,
contracts, feature pass flags, and gate rules were not amended for this PR.

Focused runtime, schema, pause, catalog/preflight, agent configuration, and
ordinary verifier umask tests: **70 passed, 0 failed**. Catalog's eight frozen
acceptance cases also passed. Tracked and new files passed the existing secret
scanner. The audit-focused group passed 135 checks and the selected frozen catalog,
runtime, journal, budget, lifecycle, and critic-partition acceptance group passed
92 checks. Final review-fix checks and CI results are recorded in the PR.

## Review fixes included

- Catalog identifiers and SHA256 fields reject a trailing newline using exact
  matches rather than JavaScript end-anchor behavior.
- A saved native application result is replayed through the owning applier after
  an interrupted state write, without dispatching or charging another leaf.
  Semantic refusals still permit the original bounded retry.
- Final native verification publishes its terminal report without requesting
  fresh terminal dispatch authorization. Terminal grants remain forbidden.

The pre-dispatch plan-to-capture-marker interruption window still refuses
automatic adoption. The PR does not claim this window has automatic recovery.

A final publication-recovery fix restores report freshness before planning the
next stage, including when the next operation requires a different helper.
The final native-stage/capture/spend focused subset passed **19 checks** after
this change. Its ordinary mocked report-write failure preserves five provider
fixture calls and five charged invocations across retry.
