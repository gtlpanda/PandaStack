# Security-audit foundations PR review

This PR packages accumulated agent configuration, run records, decision routing,
verification repairs, and security-audit execution/recovery foundations. It does
not complete native Codex security audits or parity for every offering. No
Terracotta audit or target application changes are included.

## Merge disposition: CI and final readiness pending

Three independent AI reviewers inspected the audit, native runtime,
decision/storage, and verification/export paths. The two introduced export regressions identified in that review now have
corrective implementation and separate evidence:

- **P2-15, large source export:** `createSuiteExport` queries object sizes and
  streams regular blobs over 1 MiB directly into private destination file
  descriptors. Smaller objects are handled individually with exact framing.
  The subprocess buffer and timeout limits are unchanged.
- **P2-16, Git object format:** the exporter queries the source storage format
  and initializes the destination accordingly. SHA256 prefixes are never
  mistaken for SHA1 based on identifier length.

After the user's directive to merge and continue, both fixes passed independent
static review, 13 focused implementation checks, two frozen P2-15 cases, and
three frozen P2-16 cases. These ordinary Git fixtures execute no source payload.
The original native-hunt dispositions and blocked reproductions remain unchanged;
this is new corrective evidence, not relabeling an earlier run.

The exact Codex hunt fixture highlighted in the failed CI log also passes locally
unchanged: one test, zero failures or skips. GitHub's current Ubuntu 24.04 runner
reports that required non-root execution isolation is unavailable. The prior CI
run failed 29 workflow checks and one autobuild fixture; other checks passed.
The exact OS-level cause remains unconfirmed because the probe suppresses stderr.

A temporary Ubuntu 22.04 runner amendment, with the same Node 24, required tests,
15-minute bound and actual isolation checks, was approved by the user for PR #45 and applied. It also checks
setpriv availability and runs the production isolation probe before the suite.
This approved environment-only amendment preserves the required test command,
assertions, isolation checks, and time limit. No security-policy
disable, unsafe fallback, test skip or timeout increase is proposed. The older
runner retires April 17, 2027, so this is a temporary compatibility path.

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
