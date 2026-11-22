# Live Codex evidence, 2026-11-22

These are the live steps the priority contract schedules after CP-02h and CP-03d are built
("Live steps around wave 2"). They are recorded apart from the fake-codex wiring proof. The user
authorized them on 2026-11-20 (D126, option 1A).

Setup:
- Codex CLI 0.167.0, logged in with ChatGPT, on Linux (WSL2). The 2026-11-20 run was on macOS.
- PandaStack main 40b4587, with wave-2 tiers 1 and 2 merged (PR #83).
- Temporary HOME and CODEX_HOME. `auth.json` was a symlink to the user's file, never a copy.
  The real file had the same sha256 before and after both steps, and the link was still a
  symlink afterwards.
- Raw records are in docs/evidence/codex-live-2026-11-22/, with paths redacted
  (`<home>`, `<scratch>`, `<tmp>`). `scripts/check-secrets.sh` reported them clean.

In total there were 16 live calls: 13 in the probe and 3 graph leaves in the smoke.

## 1. Strict-schema probe (13 calls)

Each call went through the real CP-02h path: `createCodexProvider().runLeaf` with profile
`source-review` (read-only sandbox), gpt-6-luna at low effort, a 180 s deadline, and an empty
working directory. The prompt said not to run commands. Each returned wire was then passed to
the runtime's own NR-01 decode, `encodeOutputContract(schema).decode`.

The schemas came from the schema blocks of the two workflows. They are every schema passed to
`runNode`: five from `harness-repair.js` (CHECK, FIX, REVIEW, CONFIRM, UNSTICK) and five from
`blueprint-design.js` (BRIEF, QUESTIONS, DESIGN, SLICES, GATE). `FINDING_SCHEMA` is not a leaf
schema; it appears only inside REVIEW. Offline, `strictOutputSchema` converted all 11 schemas,
including FINDING, with no `UNSUPPORTED_SCHEMA`.

| Calls | What | Result |
|---|---|---|
| 0 | probe self-check, UNSTICK | returned, decode OK |
| 1-10 | the 10 leaf schemas above, polite prompt ("fill every field with placeholders") | **10/10 returned, 10/10 decode OK**, 3-8 s each |
| 11 | adversarial: CHECK, prompt demands `failures[].excerpt` as an ARRAY of two strings (the wave-1 failure) | returned `"excerpt":"line one\nline two"`, a string; decode OK |
| 12 | negative control: raw, non-strict CHECK_SCHEMA handed straight to `codex exec --output-schema` | exit 1, `TURN_FAILED`: HTTP 400 `invalid_json_schema`, "'schema.additionalProperties' is required to be supplied and to be false when strict is true" |

What this shows:
- **Accepted.** Codex accepts the strict form of every harness-repair and blueprint-design leaf
  schema. Real Codex writes a bare object to `--output-last-message`, and the provider wraps it
  as the NR-01 wire (W2-3).
- **Enforced.** Codex runs `--output-schema` in strict mode: the API refuses a non-strict schema
  outright (call 12). Asked for an array where the schema says string, it produced a string
  (call 11), the opposite of the wave-1 result.
  - Call 11 is one sample. It is consistent with constrained decoding, but it is not proof that
    every schema violation is impossible.
  - CP-02h's conversion is therefore required, not optional: the wave-1 NR-01 wrapper worked only
    because `{json:string}` is already strict.

## 2. Wave-1 smoke rerun (graph host on real Codex, 3 leaves)

The run: `node core/skills/native-runtime/graph-host.mjs --args-file …`, workflow
`harness-repair`, offering `bughunt`, deadline 15 min.
- The fixture is a git repo whose `feature` branch adds one function and its test over `main`;
  both tests pass.
- The leaf environment is `{HOME, CODEX_HOME, PATH}`.
- `installationRoot` is the PandaStack checkout. The args are in `smoke-args.json`.

Result: exit 0, status **done** ("VERIFY: PASS and no HIGH/CRITICAL review or QA findings"),
45 s, 0 fix rounds. On 2026-11-20 the same smoke escalated at the first leaf.

| Leaf | Selection | Profile | Output |
|---|---|---|---|
| checker, check #1 | gpt-6-luna, high | build-workspace | `{"verdict":"PASS","verify_block":"  [0] npm run test\nVERIFY: PASS","failures":[]}` |
| reviewer, review: branch | gpt-6.1-sol, high | source-review | `{"files_reviewed":2,"findings":[]}` |
| qa-auditor, qa: branch | gpt-6.1-sol, high | source-review | `{"files_reviewed":3,"findings":[]}` |

What this shows:
- **CP-03d works live.** The checker ran
  `bash "<home>/code/PandaStack/core/skills/verify/verify.sh"`, the absolute path the role loader
  substituted for the skill-path token. It ran inside Codex's workspace-write sandbox on Linux and
  exited 0 with `VERIFY: PASS` (`smoke-commands.txt`). On 2026-11-20 this step was exit 127.
- **CP-02h works through the whole host.** All three leaves returned schema-valid objects, the
  runtime decoded them, and the host wrote `result.json`.
- **Seen, not a defect.** The checker shortened `verify_block` to the summary lines rather than
  pasting the full block. The schema only requires a string.

## Not established

- Neither step certifies any offering for live use. Blueprint stays codex `unavailable` until
  CP-04e, and no QA or loop offering exists (W2-5).
- The fix, advise and unstick leaves of harness-repair did not run, because the fixture's tests
  passed. A failing-test loop is the post-wave-2 smoke.
- The blueprint-design leaves were probed only as schemas. No blueprint graph ran.
- `agents.*` keys: their effect is still untested, since no subagent ran.
