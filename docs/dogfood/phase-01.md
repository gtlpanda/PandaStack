# Phase 1 dogfood report

2026-11-10, UTC. P1-01 through P1-14 are implemented. The external host completed
successfully at 13:42:28; all 253 frozen acceptance tests and 22 focused implementation
groups passed. Final native hunt covered six lenses with zero findings and a pass.
Fresh two-project live promotion smoke also passed on the clean tested revision.

## Revision-bound result

- Original immutable build host/baseline: 18eabde206c5041e098102b939877c8e4c99fb85.
- P1-14 implementation: 2ad0aa438623d235195a78e67cf6719f9374db5f.
- Reviewed/hunted implementation head: 4c409ae789acc56bbec94b15d4db56850d9f3e21.
- Final tested head: 518f8ef208fdf1ba9a6ac1facf236fd2015f4564.
  Its only subsequent change from hunted head was PROGRESS.md; saved review-status
  explicitly permits that documentation-only commit and retains disposition pass.
- Native run: 20261110T130322Z-1794316934926; feature gate 13:13:12,
  review/full gates 13:22:14, hunt finding summary 13:35:25,
  post-hunt host completion 13:42:28.
- The accompanying documentation-only commit is recorded in Git history.
  The tested revision remains 518f8ef; documentation does not establish testing
  of a new code change. Promotion occurs when the next phase uses this immutable
  runner. No push, remote merge or deployment occurred.

Delivered scope is central agent controls, effective-configuration doctor,
versioned immutable run/event records and managed autobuild/build-app observation.
Hard global scheduling, decision inbox and evaluation workflows belong later phases.

## Verification and final live evidence

Full required gates include bash scripts/test.sh and
node --test graphs/hunt/test-native/*.test.mjs. Host acceptance 253/253 had
0 failures/skips/cancellations; focused workflow summary 22/22. This replaces the
earlier 179/194/214/250 snapshots without erasing their revision-specific meaning.

Promotion smoke ran 13:45:24.919675–13:45:51.205809 on 518f8ef, reconstructing pristine
fixtures from original Git blobs into new private disposable projects. Both exit 0;
exact output/frozen checks passed. Shared store contains 4 records and 8 events:
2 outer invocations and 2 child sessions, all terminal finished/0, correct parentage,
distinct project revisions and overlapping child lifetimes. No cleanup failures;
runner remained clean at the same SHA. One earlier request pinned 4c409ae was
refused before launch because the host had committed 518f8ef; no provider ran for
that refusal.

|Project|Root run|Child session|Child start → finish UTC|
|---|---|---|---|
|alpha|44f07de0-67a2-48b7-b881-8e1ce2e35ae1|8550671f-daaa-442d-93a3-84ce5c99d86c|13:45:25.085 →13:45:49.690|
|beta|5df9fbda-5426-4168-9159-b46aaf37237f|40923aaf-aa79-407e-8b20-8ae97c420141|13:45:25.089 →13:45:50.803|

Input revisions: alpha 2acaf479d7f2ddd24546cf3abb52000985836ac7,
beta dcd3c8021ca56087de166a7d7c5582f8ed22a587.
Smoke retained Astra/medium, Sol subagent model, configured cap 8 and unknown
subagent effort. Candidate builds/reviews used high main effort since P1-07;
do not rewrite earlier/smoke medium settings as high. Codex supplied live sessions;
both backends have fake-adapter coverage, but no Claude live parity claim.

Neutral doctor refreshed on 518f8ef at 13:46:12.991450. Both backends exit 2/degraded:
configuration/definitions/binary presence pass, providerExecuted=false,
runtime.version=null, native model/effort/concurrency support unknown. This is
honest non-executing diagnosis, not failed configuration validation or native
capability proof. Neutral Claude roles resolve opus/high, fable/high, sonnet/high;
Codex central main/advisor medium differs from the project override noted above.

## What dogfooding found and how it was handled

P1-05..12 repaired launch/doctor precedence and attribution, selected falsy inputs,
operational IO_ERROR versus corruption, retained directory descriptors/durability,
close-after-release cleanup, path resolution/serialization, and complete accepted
child launch context. Default doctor stopped executing selected binaries. Each
bounded follow-up used frozen regressions and the pinned external host.

P1-13 addressed tracking writes inside clean project/runner trees before preflight,
including ignored/nested paths, with a narrow genuine Git tracking-namespace
exception. Native hunt 20261110T114537Z-1794312301456 reproduced the regression
at 4edd0b6 versus baseline 18eabde; the host was stopped before repeating the known
broken isolated-repair environment. A legacy test fixture conflicted with the new
policy: commit 3d33626f029c4401ad8eac44af0c865536ab8f82 moved its store to a sibling
under an outer temp root and its regular-file failure to dirname(storeDir)/file.
Every assertion remained unchanged, including explicit-store precedence.

P1-14 preserved exact Git path bytes and distinguished invalid metadata/discovery
from genuine absence. Its initial 36 cases had 3 passing controls/33 expected
failures. A further owned-config probe showed that a malformed config filename
containing "not a git repository" fooled substring-based error classification.
Three cases were appended: misleading malformed filename, ordinary malformed
filename, valid empty config. Original 36 bytes/assertions stayed unchanged;
expanded 39 had 38 pass/1 expected failure before the final correction. Freeze
clarification commit 1a2bb818fbb5a63d8199f06cbd0eaa9c16ab5aa1 retained implementation
work; the resumed builder and final host gates supplied 253/253 and 22/22 evidence.

Historical unsuccessful evidence remains historical:
- A filesystem-race reproduction was provider-blocked and was not retried or
  routed through another provider. Ordinary defensive invariants/fault tests
  supplied subsequent evidence.
- Isolated exports lacked .git, chmod checks encountered mapped root, and baseline
  comparisons timed out. These were setup/inconclusive outcomes, not verified
  repairs. Sandbox git-spawn EPERM and an existing sandbox /tmp/.git also prevented
  some local checks; root-host proofs passed without weakening those assertions.
- Interrupted gates are not passes. Old F1 labels can retain unrelated repair
  rows; bind findings to run/revision/evidence identity. A custom test harness once
  printed failures with exit 0, so authoritative summaries are checked as well.
- P1-09's hook fixture maxIterations changed 1→2 to allow the existing completion
  iteration; assertions remained. P1-10 used the documented line-local annotation
  for a synthetic fixture token; scanner rules were not relaxed.
- Full-source forwarding fixed truncated review input while retaining native
  instructions, schema and ledger gates; it was not a coverage waiver.
- Historical d3eca8a live alpha first failed at the outer run for a missing progress
  heading, then succeeded on resume;6 records/12 events retain that failure.
  The later 970953 smoke passed 4 records/8 events and remains separate from final 518f evidence.

## Measured usage, with limits

Final reconciliation at 13:46:21.118857 covers 154 fingerprinted source files and
127 observed completed turns, including completed turns from interrupted stages.

|Stage|Turns|Input tokens|Cached input subset|Output tokens|Reasoning output|
|---|---:|---:|---:|---:|---:|
|Builders|18|13,335,698|12,488,320|109,450|11,680|
|Reviews|11|8,637,396|7,941,888|39,778|6,862|
|Native hunts|91|199,122,887|183,431,808|443,975|169,079|
|Historical live|3|309,586|267,136|1,362|0|
|970953 live|2|175,536|154,880|813|0|
|518f promotion live|2|175,735|145,152|895|0|
|Observed total|127|221,756,838|204,429,184|596,273|187,621|

Cached input is already included in input. Reasoning counters are retained as
reported, not assumed additive. These are top-level completed-turn observations,
not all account usage: failed/incomplete turns without counters, unobserved
contributors and supervisor chat remain unknown/excluded. No dollar estimate or
cost-saving claim. All observed completed-turn fields had measurements; this
does not imply complete coverage of unsuccessful attempts.

## Evidence retention and limitations

Local authoritative artifacts:
- pandastack-phase 1-p114-expanded-all-acceptance.log;
  pandastack-phase 1-p114-expanded-focused.log.
- pandastack-phase 1-git-discovery-resume.log;
  pandastack-phase 1-final-hunt-status.json.
- pandastack-phase 1-promotion-2cmdyc41/{matching-stem-manifest.json,
  matching-stem-results.json}, plus owned records/events.
- pandastack-phase 1-final-doctor-provenance.json and both doctor JSONs.
- pandastack-phase 1-final-usage.json.
Raw originals reside under /tmp. Durable sanitized counterpart:
[phase-01-evidence.md](phase-01-evidence.md), retaining tested revision, hunt disposition/
documentation exemption, host gate excerpts, 253/22 counts, 4 run identities/settings
and 8 events, doctor status/hashes, usage totals and all 154 source fingerprints.
Independent comparison matched those fields to the originals and found no home or
temporary-directory paths in the snapshot. Historical supplement remains explicitly
historical. No raw provider/tool transcript is included.

Redaction preserves source hashes but changes the projection's own bytes; do not
label the redacted snapshot with an original raw-file hash. Hashes bind identity,
not source availability or independent truth. The report and durable snapshot
preserve the measured outcome without publishing raw prompts, environment, actor/
credential information or provider traces. Raw logs remain local evidence.

Content hashes binding this report's inspected inputs:
- Acceptance: 22bf4dc46afcedae0c2ea7e76c0bf2f5c637821b7b7d4b5f784bfa0dd7f21a81.
- Focused groups: 3c377f35bc0cc81a40c0b1e5c7ed3dd815ed91765b8ca23c46244606036adbac.
- Hunt status: ff85ac1a88ace42533efbf20a5877dc4b2080c0c1543529e91c4fb76159151db.
- Final host log: ca9f4fe7dfaa458513dd1ea92c9628f4807f6c27df409a1b55f717bb5395eeca.
- Promotion results: 4acbcd8d5c0202ad521465034eb364e8278def4d544b8a889a90ab25a57fbc94.
- Doctor provenance: 62de55b60c2f59f6c8ec145e372e88168efe16eb11a497398796c2a21dde7d84.
- Usage: 5a355f6f8b6e6dd7328dc836eb851f6bec1b53959e65c6d6e5bcd4361255ad7f.

Recording relies on Linux/WSL procfs anchoring; unsupported recording safely warns
while authorized work continues. No physical power-loss test, crash reconciliation,
hard global/nested-worker enforcement or observed external-session cap is claimed.
Configured concurrency 8 is not an enforcement proof. Probe/native-hunt sessions
are outside Phase 1 recording coverage. Abrupt termination can leave incomplete
starts. The next phase must use the accepted immutable runner and preserve these
limits; plans for Phases 2–8 are not evidence those phases shipped.
