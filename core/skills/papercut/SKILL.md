---
name: papercut
description: File a structured friction report when a tool, skill, flag, doc or command fights you - it exits 0 on an error, rejects a flag its help lists, returns nothing when it should match, needs a workaround, or you spent several turns on an unexpected error. Use it unprompted, the moment you notice the friction, then carry on with the task. Reports stay on this machine, grouped by tool so the owner can fix the cause. Also lists and summarizes what was filed.
allowed-tools: Bash, Read
---

# papercut

A papercut is a small, structured bug report that you, the agent, file about the
tools you use. File one whenever something you rely on misbehaves, even if you found
a way around it: the workaround costs the next session the same turns. Filing takes
one command and does not end your task.

Every command runs the helper beside this file:

```bash
node "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/papercut.mjs" summary
```

`SKILL_DIR` is the directory that holds this SKILL.md. Claude Code fills it in
through its `CLAUDE_SKILL_DIR` substitution, so there the helper commands in
this file run as written. Anywhere else (Codex, or this file read without that
substitution), start each command with `SKILL_DIR='<dir>';`, where `<dir>` is
the absolute path of the folder that holds this SKILL.md. A set `SKILL_DIR`
wins.

## When to file

File when the tool, not you, is at fault:

- a command exits 0 but printed an error, or exits nonzero with no message;
- a flag or option its own help or docs list is rejected;
- a query, search or lookup returns nothing (or the wrong thing) when it should match;
- the documented way fails and you needed a workaround (a different flag, an absolute
  path, a retry with other input);
- a skill's instructions are wrong, stale or contradict the tool they describe;
- you spent several turns on an unexpected error before understanding it.

Do not file:

- your own mistakes (a typo, a wrong path you chose, a misread instruction);
- expected failures: a test that should fail, a gate that refused for its stated
  reason, a missing credential the user must supply;
- the same report twice in one session: one report per distinct failure.

## Steps

1. **Collect the facts.** Write down the tool name, the exact command you ran, what
   you expected, what happened (the error text, trimmed), and what would fix it.
   Check: you can state the failure in one sentence without guessing its cause. If
   you cannot, keep the actual output and write "cause unknown" in the fix field.
2. **File the report.** Run, with your own values:

```bash
node "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/papercut.mjs" file \
  --agent claude --tool "evidence.mjs" \
  --tried "node evidence.mjs recheck .git/bughunt/key" \
  --expected "RECHECK: PASS for a reproduced finding" \
  --actual "RECHECK F1: ERROR, finding demoted reproduced -> confirmed" \
  --workaround "passed the state dir as an absolute path" \
  --fix "resolve a relative state dir before running"
```

   Use `--agent codex` in Codex. `--workaround` is optional; every other field is
   required. Check: the last line is `PAPERCUT: FILED <signature> <tool> -> <store>`.
3. **Return to your task.** Use the workaround if you have one. Check: mention the
   papercut in one line of your final report (tool and signature), so the person
   knows it was filed.

To review what was filed (for example when asked "what papercuts are there"):

```bash
node "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/papercut.mjs" summary
node "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/papercut.mjs" list --limit 20
```

`summary` groups reports by tool and signature (the same failure from many sessions
is one group with a count), newest first. `--json` prints either as JSON.

## What is stored

One JSON line per report in
`${PANDASTACK_PAPERCUT_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/pandastack}/papercuts.jsonl`
(directory 0700, file 0600): the time, the PandaStack commit, the agent, the
repository's directory name, your fields and the signature. Secrets in any field
(API keys, tokens, bearer and authorization headers, URL passwords) are redacted
before writing. Never paste prompt text, file contents or personal details into a
field; describe the failure instead. Nothing is sent anywhere.

## Error recovery

| Failure | Fix |
|---|---|
| `PAPERCUT: INVALID --<field> is required` | Add the named field; every field except `--workaround` is required. |
| `PAPERCUT: INVALID --<field> is N characters; the limit is M` | Cut the field to the error line and the essential context; drop stack traces past the first frame. |
| `PAPERCUT: INVALID --agent must be one of ...` | Pass `--agent claude` in Claude Code, `--agent codex` in Codex, `--agent other` elsewhere. |
| Shell quoting breaks a field (quotes, `$`, newlines) | Put the fields in a JSON object and run `papercut.mjs file --stdin` with it on stdin (a quoted heredoc: `<<'EOF'`). |
| `PAPERCUT: ERROR refusing a symlinked papercut store` | Do not work around it. Tell the person; the store path was replaced with a link. |
| `PAPERCUT: ERROR cannot create ...` or `cannot write ...` | Set `PANDASTACK_PAPERCUT_DIR` to a writable absolute directory for this run, and mention the error in your report. |
| `${SKILL_DIR:-...}` expands to nothing (`Cannot find module '/papercut.mjs'`) | Prefix the command with `SKILL_DIR='<absolute folder of this SKILL.md>';`. |
