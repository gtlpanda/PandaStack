---
name: workflow-state
description: Write saved JSON state (an approved plan, interview answers) into a runnable copy of a workflow script, because workflow scripts cannot read files and large state is too big to retype as an argument. Used by the /dev and /blueprint orchestrators; not for direct use.
---

# workflow-state

A workflow script cannot read files, so an orchestrator that must hand a run
saved state (more than a few lines) writes it into a copy of the script and
runs the copy with the Workflow tool's `scriptPath`.

```bash
node "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/run-script.mjs" <SEAM> <state.json> <workflow.js> <out.js>
```

`SKILL_DIR` is the directory that holds this SKILL.md. Claude Code fills it in
through its `CLAUDE_SKILL_DIR` substitution, so there the helper commands in
this file run as written. Anywhere else (Codex, or this file read without that
substitution), start each command with `SKILL_DIR='<dir>';`, where `<dir>` is
the absolute path of the folder that holds this SKILL.md. A set `SKILL_DIR`
wins. With neither set, the command fails.

- The workflow carries the line `const <SEAM> = null` exactly once (for example
  `const INJECTED_PLAN = null`). The copy differs on that line only, which now
  holds the state.
- Success prints `run-script: wrote <absolute out.js> ...` and exits 0. Anything
  else (`run-script: FAIL <why>`, exit 1) writes nothing: report it and stop.
- Pass the workflow by its installed path (under Claude Code: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/workflows/<name>.js`).
- Never also pass the same state in the Workflow args; the workflows escalate
  when they get it twice.

## On Codex

Codex has no Workflow tool and no `scriptPath`, so the copy this helper writes
cannot be run there. The helper itself runs the same on Codex (it only reads and
writes files), but the hand-off it serves does not exist: there, a graph runs
only through the Codex entry the offering catalog gives it
(`spec/offering-capabilities.json`), not through this skill.
