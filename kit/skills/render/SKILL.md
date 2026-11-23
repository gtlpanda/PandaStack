---
name: render
description: Read-only Render API access. Use when the user asks to "check render logs", "see render logs", "render status", "render deploys", "what's on render", "fetch render logs", "render env", or otherwise wants visibility into a deployed Render service. Supports listing services, fetching logs with grep + time range, listing deploys, and listing env-var names (NOT values). Works across any project that uses Render — no per-project setup required after first init.
version: 0.1.0
---

# Render API Access

Read-only wrapper around the Render REST API (https://api.render.com/v1). It is installed once at user level (by `install.sh` for Claude Code, or `install.sh --codex` for Codex), so it works in any project without per-project install.

## Setup (one-time)

API key lives at `~/.config/render/api-key` with mode 600 (owner read-only). The wrapper script reads it on every invocation.

Create the key file:
```bash
mkdir -p ~/.config/render
chmod 700 ~/.config/render
# Paste your Render API key (from https://dashboard.render.com/account/api-keys)
printf "rnd_XXXXXXXXXXXXXXXX" > ~/.config/render/api-key
chmod 600 ~/.config/render/api-key
```

The wrapper exits with an error if the file is missing OR has wider-than-600 permissions.

## Commands

Run the `render` wrapper that sits in this skill's folder, with `bash`: it is not on PATH, and every shell call starts fresh, so an alias would not last. The examples below use the folder variable `SKILL_DIR`.

`SKILL_DIR` is the directory that holds this SKILL.md. Claude Code fills it in
through its `CLAUDE_SKILL_DIR` substitution, so there the helper commands in
this file run as written. Anywhere else (Codex, or this file read without that
substitution), start each command with `SKILL_DIR='<dir>';`, where `<dir>` is
the absolute path of the folder that holds this SKILL.md. A set `SKILL_DIR`
wins. With neither set, the command fails.

### `render services`
List all services the API key can see. Output: `ID  NAME  TYPE  URL  SUSPENDED  UPDATED`.

```bash
bash "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/render" services
# ID          NAME              TYPE         URL          SUSPENDED      UPDATED
# srv-abc123  supple-picks      web_service  https://...  not_suspended  2026-05-26T01:41:07Z
# srv-def456  cherryrock-folio  web_service  https://...  not_suspended  2026-05-20T17:02:11Z
```

### `render logs <service-name-or-id> [options]`
Fetch logs for a service.

Options:
- `--since <duration>` — relative time (e.g. `1h`, `30m`, `2d`). Default: `15m`.
- `--until <duration>` — relative end time. Default: `now`.
- `--filter <text>` — server-side text search (plain text, matched by Render; not a pattern).
- `--grep <pattern>` — local `grep -E` after the fetch (use this for patterns).
- `--limit <n>` — max log lines (default 100, max 1000).
- `--level <info|warn|error>` — filter by log level.

```bash
bash "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/render" logs supple-picks --since 30m --grep "EARLY_RETURN"
bash "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/render" logs supple-picks --since 1h --level warn
```

### `render deploys <service>`
List the 10 most recent deploys: `ID  STATUS  COMMIT  CREATED  FINISHED  MESSAGE`.

```bash
bash "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/render" deploys supple-picks
# dep-xyz   live      553172c  2026-05-26T01:38:02Z  2026-05-26T01:41:07Z  PR #91 merge
```

### `render env <service>`
List env-var NAMES only (NOT values). For secrets safety, the wrapper never fetches plaintext values.

```bash
bash "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/render" env supple-picks
# DATABASE_URL
# EBAY_CLIENT_ID
# OPENAI_API_KEY
```

## How to invoke

When the user asks anything log-related about Render:
1. Run the `services` command first to confirm the service exists + grab the canonical name/id.
2. Run the `logs <name>` command with appropriate `--since` + `--grep` filters based on what they're debugging.
3. If they need to see deploys (e.g., "did my push deploy?"), use the `deploys` command.

The wrapper is read-only by design — no command can change Render state. Trust accordingly.

## Implementation

The wrapper is the `render` file in this skill's folder (bash + curl + jq). Reads the API key, makes the appropriate `/v1/...` call, formats the response. No external dependencies beyond `curl` + `jq` (both standard on macOS).

## Adding new commands

If you find yourself wanting a new operation:
1. Edit the `render` file in this skill's folder — add a case branch
2. Render API docs: https://api-docs.render.com/reference/introduction
3. Keep operations READ-ONLY — never add POST/PUT/PATCH/DELETE to this wrapper without an explicit user prompt to "promote render to read-write." The scope is debugging visibility, not deployment control.

## Why not MCP?

A bash wrapper is sufficient for read-only visibility and avoids the MCP install/restart loop. If we later need a native tool surface (e.g., streaming log monitor with structured output), upgrade to a Python MCP server then.
