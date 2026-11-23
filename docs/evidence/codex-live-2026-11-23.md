# Live Codex evidence, 2026-11-23

These live checks follow the Codex parity PR (#91). They are recorded apart from that PR's fake-codex
wiring proof. The user authorized them on 2026-11-23 ("Sure", in reply to the proposed smoke batch).

Setup:
- Codex CLI 0.167.0, logged in with ChatGPT, on Linux (WSL2).
- PandaStack at d0ef2f9 (the head of #91, merged unchanged as 1d3f89a), in a detached checkout.
- A temporary CODEX_HOME. Its `auth.json` was a symlink to the user's file, never a copy.
- A throwaway git repository as the working directory. Smoke 4 also used a temporary HOME.
- Every call: `codex exec --ignore-user-config --skip-git-repo-check -c 'approval_policy="never"'`,
  with stdin closed (`< /dev/null`) and a `timeout` of 180 to 420 s.
- Paths below are redacted: `<scratch>` is the session scratch directory, `<home>` the temporary
  HOME.

In total there were 10 live `codex exec` calls. The first attempt at smoke 1 is not counted: it left
stdin open, and `codex exec` waited on it ("Reading additional input from stdin...") until the timeout
killed it. That was a harness mistake, not a Codex failure, and nothing ran.

## 1. Host detection inside a real Codex session (1 call)

- **Call:** `-s read-only`, Codex's default model (it reported `model: gpt-6.2-sol`).
- **Prompt:** run `node <scratch>/probe.mjs`. The probe prints the CODEX_/CLAUDE environment keys and
  `detectHostProvider()` from `core/skills/native-runtime/host-provider.mjs`.
- **Environment Codex gave the command:** CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS, CODEX_CI,
  CODEX_HOME, CODEX_MANAGED_BY_NPM, CODEX_MANAGED_PACKAGE_ROOT, CODEX_SANDBOX_NETWORK_DISABLED,
  CODEX_SESSION_ID, **CODEX_THREAD_ID**, CODEX_TOOL_CALL_ID and CODEX_VERSION.
- **Leaked Claude variables:** all of the parent Claude Code session's variables were present too
  (CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_ENTRYPOINT and others), because Codex was launched
  from a Claude Code shell.
- **Result:** `DETECT {"provider":"codex","source":"ancestor"}`.

So:
- `CODEX_THREAD_ID` is confirmed in real Codex commands. It was an untested hypothesis in #91.
- The process-chain rule picks the innermost host in exactly the nested case that defeats a plain
  environment check.

## 2. The role-map model ids (3 calls)

`-m <id>` with the prompt "Reply with exactly the word OK and nothing else.":

| Model | Exit | Model line | Reply |
|---|---|---|---|
| gpt-6-astra | 0 | `model: gpt-6-astra` | OK |
| gpt-6.1-sol | 0 | `model: gpt-6.1-sol` | OK |
| gpt-6-luna | 0 | `model: gpt-6-luna` | OK |

Codex accepts all three ids that PandaStack maps from Opus/Fable, Sonnet and Haiku. The
roadmap's open item on model id acceptance is closed for these three.

Codex's own default model on this account reported as `gpt-6.2-sol`, which is newer than the
mapped `gpt-6.1-sol`. The mapped id still works.

## 3. The release-controlled network setting (2 calls)

- **Command in both calls:** `curl -s -o /dev/null -m 8 -w "HTTP=%{http_code}" https://api.github.com`
- **Model:** gpt-6-luna.

| Sandbox flags | Result |
|---|---|
| `-s workspace-write -c sandbox_workspace_write.network_access=true` | `HTTP=200` |
| `-s workspace-write` (control) | `HTTP=000` |

So:
- The `-c` override survives `--ignore-user-config`, which was untested in #91.
- The release leaves' network grant works in a real session, and the default has none.
- An earlier `codex sandbox` check (no model) also showed `gh api rate_limit` working with the flag,
  using the user's gh login.

## 4. Install, discovery and a skill run in a clean HOME (4 calls)

**Install:** `HOME=<home> ./install.sh --codex` exited 0 with `done: 45 linked, 0 already linked`,
into `<home>/.agents/skills`.

**4a. Discovery** (gpt-6-luna, read-only, no commands):
- Codex listed the PandaStack skills by name, alongside its own bundled skills.
- Asked which skill verifies a repository, it answered `VERIFY: verify`.
- Its free-form list left out findings, fix-scraper and workflow-state.

**4b. The three omissions, asked by name:**
- `findings: yes`, `fix-scraper: yes`, `workflow-state: yes`.
- A control name, `nonexistent-skill-xyz`, answered `no`.
- The omissions were the model's incomplete list, not a skill Codex failed to load. Their
  frontmatter is valid, and fix-scraper's description is the shortest of all.

**4c. A skill run end to end** (gpt-6.1-sol, `-s workspace-write`):
- **Repository:** a throwaway repo with a passing `scripts/test.sh`.
- **Prompt:** "Use the verify skill on this repository, following its SKILL.md exactly."
- **Command Codex ran:**
  `SKILL_DIR='<home>/.agents/skills/verify'; bash "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/verify.sh"`
- **Result:** `VERIFY: PASS`. The run's output contains no `.claude` path.
- The CP-03a `SKILL_DIR` rule resolves verify's helper from the Codex install on a machine path with no
  `~/.claude` involved.

## What this does not prove

- **No PandaStack graph pipeline ran on live Codex:** dev, release-pr, build-app, blueprint's full flow,
  or a full native bug hunt. Those catalog rows keep `LIVE_PROOF_MISSING`.
- **Only verify ran live** among the 39 `codex-skill` offerings. The others were proven discoverable
  (smoke 4a/4b), not run.
- **security-audit stays unavailable on Codex.** See docs/evidence/codex-sandbox-source-only-2026-11-23.md.

## Catalog change made with this record

- **verify:** its codex row drops `NATIVE_UNVERIFIED`, which it had kept only because the offline
  proof never ran its helper. Smoke 4c ran it live.
- **run-records and decisions:** they keep `NATIVE_UNVERIFIED`. Their helpers were not run.
