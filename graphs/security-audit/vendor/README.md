# Vendored upstream code

`cloudflare-security-audit/` is [Cloudflare's security-audit skill](https://github.com/cloudflare/security-audit-skill),
copied byte for byte. Copyright (c) 2025-2026 Cloudflare, Inc., MIT licensed. The MIT notice is kept
in `cloudflare-security-audit/LICENSE` and the credit is repeated here, as the license requires.
PandaStack wraps this work and does not claim it.

## What is vendored, exactly

22 files, 322,698 bytes: `LICENSE` (1,078), `README.md` (6,950), and the 20 files (314,670 bytes) of
`skills/security-audit/`. That is every file the upstream repo has at the pinned commit. `UPSTREAM.json`
is ours and is not counted: it sits in the same directory and holds the pin.

## The pin

`cloudflare-security-audit/UPSTREAM.json` records the repo, the commit, the commit date, the day it
was pinned, the license, and the git blob hash, size, and mode of every file. Nothing here follows
`main`: the copy changes only when a person changes it.

    node graphs/security-audit/vendor/check-vendor.mjs            # offline; part of scripts/test.sh
    node graphs/security-audit/vendor/check-vendor.mjs --online   # manual: is the pin still current?

The offline check recomputes each blob hash (`sha1("blob <size>\0" + bytes)`, no git needed) and
fails naming every changed, missing, or unlisted file. A file mode is recorded but not enforced:
the two validators are executable upstream, and a checkout that drops the bit changes nothing here
because they are always run as `node <file>`. `.gitattributes` turns line-ending conversion off for
this tree, so a Windows checkout cannot change the bytes. `--online` fetches commit history only
(no file contents) from the pinned repo, reports whether the pin is current or how far behind
`main` is, and never updates anything. It needs the network and is never run in CI.

## Update policy

A manual pull request, never a script that runs on its own. Upstream's validators and its prose
are the evidence bar for every audit, so a bump gets a human read.

1. Clone upstream and check out the new commit (`$CLONE`, `$SHA`).
2. Replace the tree: `rm -r cloudflare-security-audit/{LICENSE,README.md,skills}`, then
   `git -C "$CLONE" archive "$SHA" LICENSE README.md skills/security-audit | tar -x -C cloudflare-security-audit`.
3. Regenerate the `files` object of `UPSTREAM.json` from upstream's own git tree, not from the copies:

       git -C "$CLONE" ls-tree -r -l "$SHA" | jq -R -s 'split("\n") | map(select(length > 0) | capture("^(?<mode>[0-7]+) blob (?<blob>[0-9a-f]{40}) +(?<size>[0-9]+)\t(?<path>.+)$") | {key: .path, value: {blob, size: (.size | tonumber), mode}}) | from_entries'

   Then set `commit`, `commitDate`, `commitSubject`, `pinnedOn`, and `skillsTree`
   (`git -C "$CLONE" rev-parse "$SHA:skills/security-audit"`).
4. Run `scripts/test.sh`: the drift check, and upstream's own `*.test.cjs` through `upstream.mjs`.
5. Re-read the diff of upstream's prose and schema against what PandaStack injects into prompts,
   and say in the PR what changed.

## What is not vendored, and what never happens

- Upstream's git history. Only the files at the pinned commit are here.
- Anything upstream adds later, until an update PR brings it in.
- Nothing under `vendor/` is installed. `install.sh` links only `skills/`, `agents/`, `workflows/`,
  `commands/`, and `bin/` entries, so upstream's own skill file never lands in a `skills/` directory:
  its description asks to be used for ordinary security questions, and it would collide with a
  copy someone installed with `npx skills add`. PandaStack reads it as data.
- No vendored file is edited, wrapped in place, or patched. Every difference lives in PandaStack
  code (`graphs/security-audit/skills/security-audit/upstream.mjs` and the files that follow it).
