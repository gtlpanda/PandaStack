# The review gate as a Codex hook: live probes (2026-11-23)

**Question.** Can the review gate (`graphs/hunt/skills/bughunt/gate.mjs`), which Claude Code runs as a
PreToolUse hook, block an interactive Codex session from pushing to the default branch or opening an
unhunted PR? And what does `install.sh --codex` have to do so that it actually runs?

**Setup.**
- Codex CLI 0.167.0 on Linux (WSL2).
- Every probe ran in a throwaway `CODEX_HOME` under the session scratch directory (`<scratch>` below). Its
  `auth.json` was a symlink to the real login, never a copy, and was never read or printed. The real
  `~/.codex` was not changed.
- Each push target was a local bare repo made with `git clone --bare`, so a push the gate failed to stop
  reached only that throwaway.
- Models: `gpt-6-luna` and `gpt-6-astra` (the configured default).

## What Codex does with hooks

| # | Probe | Result |
|---|---|---|
| 1 | `$CODEX_HOME/hooks.json` with `{"hooks":{"PreToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"node <scratch>/log-hook.mjs"}]}]}}`; `codex exec --dangerously-bypass-hook-trust "Run the shell command: echo probe-ok"` | The hook got Claude-shaped input: `hook_event_name: "PreToolUse"`, `tool_name: "Bash"`, `tool_input: {"command": "echo probe-ok"}`, `cwd`, plus `session_id`, `turn_id`, `transcript_path`, `model`, `permission_mode`, `tool_use_id`. The captured payload is `graphs/hunt/tests/fixtures/codex-pretooluse.json`. |
| 2 | The hook command replaced by the unchanged `gate.mjs` (matcher `Bash`); `gpt-6-luna` asked to run `git push origin main` (with the bypass flag) | `hook: PreToolUse Blocked`, with the gate's own reason ("this pushes straight to origin/main, the default branch, with no review…"). The bare remote stayed at 1 commit. Codex obeys `hookSpecificOutput.permissionDecision: "deny"`. |
| 3 | Same, **without** `--dangerously-bypass-hook-trust` (the hook never trusted) | The push **went through** (`cba934f..70439e9 main -> main`). There was no warning in the output. An untrusted hook is skipped without a word. |
| 4 | `codex app-server` (stdio JSON-RPC): `hooks/list {cwds:[…]}` | Each hook has `key` (`<CODEX_HOME>/hooks.json:pre_tool_use:<group>:<hook>`), `source` (`user`), `command`, `currentHash` (`sha256:…`) and `trustStatus` (`untrusted`/`trusted`/`modified`/`managed`). |
| 5 | `config/batchWrite {edits:[{keyPath:"hooks.state", mergeStrategy:"upsert", value:{"<key>":{trusted_hash:"<currentHash>"}}}]}` | `status: ok`. `config.toml` gained `[hooks.state."<key>"] trusted_hash = "sha256:…"`, and `hooks/list` then reported `trusted`. This is the write the Codex UI makes (the binary's strings: `config/batchWrite failed while updating hook trust in TUI`). |
| 6 | After 5, no bypass flag, `-m gpt-6-astra`, `git push origin main` | Blocked (`Command blocked by PreToolUse hook: review gate: …`). The bare remote stayed at 2 commits. |
| 7 | Trusted hook: edit the hook **script's** contents | Still `trusted`. A `git pull` that changes `gate.mjs` keeps the gate on. |
| 8 | Trusted hook: edit the **entry** in `hooks.json` (`timeout` 30 → 31) | `modified`. |
| 9 | Trusted hook: rewrite `hooks.json` with different whitespace (same JSON) | Still `trusted`. |
| 10 | A `modified` hook whose script denies everything; `echo marker-ran` | The command ran. A `modified` hook is skipped without a word. |
| 11 | Trusted hook that throws (exit 1); `echo marker-ran` | `hook: PreToolUse Failed`, and the command ran: it fails open. |
| 12 | Trusted hook that hangs past its `timeout` (3 s) | `hook: PreToolUse Failed`, and the command ran: it fails open. Neither the binary's strings nor the app-server schema show a fail-closed option. |
| 13 | Trusted hook that logs `PANDASTACK_REVIEW_PROBE`; Codex launched with `PANDASTACK_REVIEW_PROBE=probe-value` | The hook saw `probe-value`. A variable set at launch reaches the hook. The probe used a look-alike name rather than setting the real `PANDASTACK_REVIEW_GATE=0`; neither name contains `KEY`, `SECRET` or `TOKEN`. `codex-hook.test.mjs` covers `gate.mjs` obeying `PANDASTACK_REVIEW_GATE=0` from its environment. |
| 14 | Trusted gate, `codex exec --ignore-user-config`, `git push origin main` | The push **went through** (`70439e9..e6b2e61`). With that flag, Codex runs no user hooks. `core/skills/native-runtime/codex-exec.mjs` always passes it, so native graph leaves are not gated. Autobuild's `runCodex`, which `/build-app` slice sessions also use, does not pass it. |
| 15 | Trusted gate at `pre_tool_use:0:0`; another `PreToolUse` entry inserted before it | Ours is now `pre_tool_use:1:0` and `untrusted`. Trust is keyed by the entry's place in the file, so rerun `install.sh --codex` after reordering, which trusts it at the new key. |
| 16 | Two trusted groups at `0:0` and `1:0`; the first group's `hooks` emptied to `[]` (left in place) | Codex accepts the empty group, and the second hook is still `1:0` and `trusted`. Uninstall therefore keeps a group it emptied when others follow it (BUGHUNT-F3), and drops it only from the end. |

## The installed path, end to end

1. **The helper against real Codex.** `codex-hook.mjs` against a throwaway `CODEX_HOME` whose `hooks.json` already
   held a foreign `SessionStart` hook:
   - `status` → `CODEX-GATE: missing` (exit 1);
   - `merge` → entry added;
   - `merge` again → "already has the review gate";
   - `status` → `untrusted` (exit 1);
   - `trust` → "trusted the review gate (…:pre_tool_use:0:0, sha256:fd1b79…)";
   - `status` → `trusted` (exit 0).

   The foreign hook was kept.
2. **The installer.** `install.sh --codex` with `HOME` set to a throwaway directory that has a `.codex` (with the
   `auth.json` symlink), and `CODEX_HOME` unset. It exited 0 and printed:
   ```
   codex hooks: added the review gate to <scratch>/home/.codex/hooks.json: PreToolUse Bash: node "<scratch>/home/.agents/skills/bughunt/gate.mjs"
   codex hooks: trusted the review gate (<scratch>/home/.codex/hooks.json:pre_tool_use:0:0, sha256:69ba26…)
   CODEX-GATE: trusted (<scratch>/home/.codex/hooks.json:pre_tool_use:0:0)
   done: 46 linked, 0 already linked
   ```
3. **Codex through the installed gate.** `codex exec -m gpt-6-astra` in that HOME, with no bypass flag, asked to run
   two commands:
   - `git push origin main` was blocked (`review gate: this pushes straight to origin/main…`).
   - `gh pr create --title t --body b` was blocked (`review gate: the base origin/main is not in this clone (fetch it
     first)…`). Because the throwaway clone had no fetched base, this is the gate's deny for an unresolvable PR,
     not its "no hunt" deny. `codex-hook.test.mjs` covers the "no hunt" deny with a fetched base and the captured
     payload.

   The remote's `main` was the same before and after (`08456f0…`).

## What this changes

- `install.sh --codex` registers, trusts and checks the gate. The plain `./install.sh` does too, in its Codex
  step. A gate that is not trusted fails `--codex` and makes the plain install warn.
- `gate.mjs`'s override text no longer says "start Claude Code with…". It names Claude Code or Codex.
- **Fixes from the branch's `/bughunt`** (three findings, each reproduced, each now a regression test):
  - **F1.** Install tests that set a temp `HOME` but inherited `CODEX_HOME` could register and trust the gate in a
    real Codex home. `install.sh` now writes only `PANDASTACK_CODEX_HOME` or `$HOME/.codex`. A `CODEX_HOME` that names
    another directory gets a warning that names `PANDASTACK_CODEX_HOME`.
  - **F2.** A failed `hooks.json` write now removes its temp file.
  - **F3.** Uninstall no longer shifts later groups to new trust keys (probe 16). It warns when a hook that shared
    our group moves.

## What this does not show

- **Other Codex releases.** Only 0.167.0 was probed.
- **The interactive TUI itself.** All runs were `codex exec`. The TUI reads the same `hooks.json` and the same
  `hooks.state`, which the binary strings show it writes itself, but no TUI session was driven.
- **Fail-closed behavior.** There isn't any. A crash or timeout lets the command run, as Claude Code does by
  default.
- **Edited entries.** A person who edits the entry makes Codex skip it until they trust it again. The installer
  refuses to trust an entry that is not exactly its own.
