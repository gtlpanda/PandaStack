# CP-05e: the native QA gate proof

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125),
wave 2, and the last wave-2 feature. It proves, on the frozen fake codex, that the
CP-05d loop iteration gates on the repository's own test: a real failing test, a fixer
that changes the file, and the verify run that loop.md step 3.4 puts on the session.
It records that proof in the catalog. It adds no module, flag or code path, the same
shape as CP-02f.

Wiring proof, not runtime certification. A live harness-repair loop on a fixture repo
with a real failing test is a separate step after wave 2 merges.

## Owners and the files a builder may edit

- spec/offering-capabilities.json: exactly one change, below.
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

Nothing else changes: no module, workflow, role file, SKILL.md, loop.md or install.sh.
The proof is qa-loop.mjs (CP-05d), the host (CP-02e), the strict schema (CP-02h) and
the role loader (CP-03d), as built.

## The catalog change

`dev`'s `proofRefs` becomes `["cp-02f-host-wiring", "cp-05e-qa-gate"]`. No other byte of
the catalog changes. `dev`'s codex row stays `unavailable` (CP-02f gives the reason: dev
has no native Codex entry until CP-06, and W2-5 adds no QA or loop offering). `dev` carries
the reference because its `evidenceOwners` name graphs/qa/workflows/harness-repair.js,
and graphs/qa has no owning offering (CP-01b rule 1).

A reference is a pointer, never evidence; no derived value reads it (CP-01a).

## The fake codex (W2-9, amended additively at this freeze)

acceptance/codex-parity/cp-02f-fake-codex.cjs gains one optional reply field. A reply
`{json, writes}` first writes each `writes` entry, then answers as `{json}` does:
- `writes` is an object mapping a relative path to its UTF-8 content;
- a path must be relative, use `/`, and have no empty, `.` or `..` segment, or the fake
  writes nothing, records the call and exits 3;
- each file is written under the spawn's cwd (the host passes the repository top level),
  creating parent directories.

A reply without `writes` behaves exactly as before, so every frozen case that uses the
fake holds unchanged. This is how a scripted fixer changes the tree; the fake still
starts no process and uses no network.

## What the frozen test pins

The fixture root is CP-05d's: the candidate's catalog with only `dev`'s codex row flipped
to partial, the workflow templates, role files and every file in each skill directory,
with `core/skills/verify/verify.sh` replaced by an inert script. Here the inert script
runs the fixture repository's own `scripts/test.sh` and prints a VERIFY block whose last
line is `VERIFY: PASS` only when that test exits 0. The repository's own verify.sh, its
capture machinery and the blocked nested-capture reproduction are never run (AGENTS.md).

The fixture repository has one committed test: `scripts/test.sh` exits 0 only when
`src/value.txt` holds `fixed\n`. It is committed holding `broken\n`, so the test fails.

Every case runs `node <candidate>/graphs/qa/tool/qa-loop.mjs --args-file <file>` with the
leaf env `{PATH, FAKE_CODEX_DIR}`, the CP-05d `bin/` (whole `PATH`: a `node` shim, a
recording `git` wrapper, a `bash` link, and recording `claude` and `gh` stubs).

1. **The gate passes on a real fix.**
   - Before the iteration, the inert verify.sh run in the repository prints
     `VERIFY: FAIL` (the test is real).
   - Scripted replies: the checker fails naming `scripts/test.sh`; the fixer's reply
     writes `src/value.txt` = `fixed\n` and reports `touched: ["src/value.txt"]`; the
     checker passes; the reviewer and qa-auditor find nothing.
   - qa-loop exits 0 with status `done`. Spawns, in order: checker, fixer, checker,
     reviewer, qa-auditor. Sandboxes: checker and fixer `workspace-write`, the others
     `read-only`.
   - The report and the one recorded ledger run say `done` with `loopChecks.verify`
     `'PASS'`, `loopChecks.touched` `'MATCH'` and `loopChecks.changed`
     `["src/value.txt"]`; `src/value.txt` holds `fixed\n`; HEAD, refs and the index are
     unchanged (W2-8: no commit).
2. **The gate refuses an unproven fix.** The same, except the fixer writes
   `still broken\n` and the second checker reply claims a pass anyway. The graph returns
   `done` (the report's `graphStatus`), and qa-loop records `escalate` with `reason:
   'VERIFY_FAILED'`, `downgradedFrom: 'done'` and `loopChecks.verify` `'FAIL'`, because
   the real test still fails. Nothing is committed.
3. **What reached Codex.** Over both cases, for every spawn:
   - the `--output-schema` file is not the NR-01 wire schema; it parses as an object
     schema with `additionalProperties: false` (CP-02h);
   - the checker's and the fixer's stdin run
     `bash "<fixture root>/core/skills/verify/verify.sh"` (CP-03d, resolved to the
     fixture root), and no spawn's stdin contains `.claude` or `CLAUDE_CONFIG_DIR`;
   - the env keys are exactly `FAKE_CODEX_DIR` and `PATH`, and `--ignore-user-config` is
     present. The `claude` and `gh` stubs record nothing, and git saw only `rev-parse`
     and `status`.
4. **Catalog.** `dev`'s `proofRefs` equal `["cp-02f-host-wiring", "cp-05e-qa-gate"]`, no
   other row carries `cp-05e-qa-gate`, `dev`'s codex row is still `unavailable`, and
   `checkCatalogDrift` on the candidate root reports no problem.

## Not in scope

- Any provider row flip, transport, `requirementsComplete` or readiness change.
- Commits, PR tending, idle work and stopping (loop.md steps 2 and 4 to 7; CP-05d).
- Live codex; a real verify.sh; any retry, reroute or Claude fallback.

## Acceptance

acceptance/codex-parity/cp-05e-qa-gate.test.mjs (node:test, 4 cases, about 10 seconds).
It imports from and runs `PANDASTACK_CANDIDATE_ROOT` (default: the repo root). Owned temp
directories only; no HOME, network, real codex or claude.

At this freeze (qa-loop.mjs unbuilt) every case fails: cases 1 to 3 on the missing
module, case 4 on `dev`'s `proofRefs`. On a tree with every other wave-2 feature built and
not this one, cases 1 to 3 pass and case 4 fails: once CP-05d is built the loop already
gates as required, and nothing in the builder's scope can make cases 1 to 3 pass by
itself. This feature is proof plus one catalog field, as CP-02f was.

Enforced by review: that the reference id names this contract and its frozen test.
