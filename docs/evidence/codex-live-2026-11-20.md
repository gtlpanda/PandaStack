# Live Codex evidence, 2026-11-20

Recorded apart from fake-codex wiring proof, as the priority contract requires. The
user authorized both steps (option 1A, 2026-11-20). Codex CLI 0.167.0 on macOS, logged
in with ChatGPT. Raw records: docs/evidence/codex-live-2026-11-20/ (secret-scanned:
only usage counter names match "token").

## 1. Capability probe (5 calls)

Each call: `codex exec --json --sandbox read-only --skip-git-repo-check --ephemeral`,
low effort, a one-line prompt asking for `PROBE-OK`, 180 s cap. Temp HOME and
CODEX_HOME; `auth.json` was a symlink to the user's (never copied, unchanged after).
The temp CODEX_HOME held a planted `config.toml` whose only entry is an MCP server
that drops a marker file when launched.

| Call | Flags | Result |
|---|---|---|
| A | `--ignore-user-config`, gpt-6-luna | exit 0, `PROBE-OK`, **0 markers** |
| B | control, no flag, gpt-6-luna | exit 0, `PROBE-OK`, **2 markers** (config loaded) |
| C | `--ignore-user-config`, gpt-6.1-sol | exit 0, `PROBE-OK` |
| D | `--ignore-user-config`, gpt-6-astra | exit 0, `PROBE-OK` |
| E | `--ignore-user-config`, `-c agents.default_subagent_model="gpt-6.1-sol"`, `-c agents.max_concurrent_threads_per_session=2` | exit 0, `PROBE-OK`, no config error |

Established:
- `--ignore-user-config` stops `$CODEX_HOME/config.toml` from loading (A vs B).
  Decision 3's effect is no longer a hypothesis for that file.
- The three model ids in autobuild `codexModel` are accepted.
- Both `agents.*` keys are accepted. Their effect is untested (no subagent ran).
- `turn.completed.usage` carries `input_tokens`, `cached_input_tokens`,
  `output_tokens`, `reasoning_output_tokens` and also `cache_write_input_tokens`,
  which CP-02b drops.

## 2. Wave-1 live smoke (graph host on real Codex)

`node core/skills/native-runtime/graph-host.mjs --args-file …` on main c5e1154:
workflow `harness-repair`, offering `bughunt`, a fixture git repo with one passing
test, leaf env `{HOME, CODEX_HOME, PATH}` (temp dirs, auth symlink), 15 min deadline.

Result: exit 0, status `escalate`, 29 s, one leaf (checker, gpt-6-luna, high).

Established:
- Under `--output-schema` (the NR-01 wire schema) real Codex wrote exactly
  `{"json":"<string>"}` to `--output-last-message`; CP-02b returned it, and the host
  wrote `result.json` (0600). CP-02b's central assumption holds.

Found (fixed in wave 2):
- **The semantic schema is not enforced on Codex.** Codex enforced only the
  `{json:string}` wrapper. The checker's inner JSON had the right keys but
  `failures[].excerpt` as an array of strings; `CHECK_SCHEMA`
  (graphs/qa/workflows/harness-repair.js:51) says string. The runtime's NR-01
  decode rejected it ("Native output contract rejected.") and the graph escalated.
  On Claude the Workflow tool enforces the full schema. Fixed by CP-02h (W2-3).
- **Role bodies hard-code Claude paths.** The checker ran
  `bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/verify/verify.sh"` and got exit
  127 in a Codex HOME. Fixed by CP-03d (W2-4).

Neither result certifies any offering for live use.
