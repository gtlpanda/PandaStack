#!/usr/bin/env node
// PreToolUse guard for autobuild loop sessions. Inert unless AUTOBUILD_ACTIVE=1 (or HARNESS_ACTIVE=1).
// Permission rules are not a security boundary (`git -C . push` slips past `Bash(git push *)`),
// so every Edit/Write/Bash call is inspected and these are denied:
//   - edits to frozen paths (autobuild.json "frozen", plus the config, the feature list and the state dir);
//     review sessions may only write the progress log;
//   - writes outside the project, except the temp directory;
//   - shell writes to frozen paths (redirects, tee, sed -i, mv, cp, rm, inline scripts, …);
//   - git push and history- or work-discarding git commands;
//   - recursive rm and network fetches or installs outside the package manager.

import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { findProjectRoot, loadConfig } from "../lib/config.mjs";
import { isActive, projectRootFromHookEnv } from "../lib/session.mjs";

if (!isActive()) process.exit(0);

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
let config;
try {
  config = loadConfig(findProjectRoot(projectRootFromHookEnv()));
} catch {
  process.exit(0);
}
const ROOT = config.root;
const role = process.env.AUTOBUILD_ROLE ?? process.env.HARNESS_ROLE ?? "builder";
const tool = input.tool_name ?? "";
const params = input.tool_input ?? {};

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Autobuild guard: ${reason}` } }));
  process.exit(0);
}

const TEMP_DIRS = [...new Set(["/tmp", tmpdir()].map((dir) => path.resolve(dir)))];

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}(/.*)?$`);
}
const FROZEN = config.frozen.map((entry) => globToRegExp(entry.replace(/\/$/, "")));
const WRITABLE = (config.writable ?? []).map((entry) => globToRegExp(entry));

function expand(file) {
  const raw = String(file ?? "").replace(/^['"]|['"]$/g, "");
  if (raw === "~" || raw.startsWith("~/")) return path.join(homedir(), raw.slice(2));
  return raw.replace(/^\$\{?HOME\}?(?=\/|$)/, homedir());
}

/** Whether writing `file` is forbidden for this role. */
function isFrozen(file) {
  const absolute = path.resolve(ROOT, expand(file));
  const rel = path.relative(ROOT, absolute).split(path.sep).join("/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) return !TEMP_DIRS.some((dir) => absolute === dir || absolute.startsWith(`${dir}/`));
  if (role === "review") return rel !== config.progressFile;
  if (WRITABLE.some((pattern) => pattern.test(rel))) return false;
  return FROZEN.some((pattern) => pattern.test(rel));
}

if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const file = params.file_path ?? params.notebook_path ?? "";
  if (isFrozen(file)) {
    const rel = path.relative(ROOT, path.resolve(ROOT, expand(file)));
    deny(
      rel === config.featuresFile
        ? `${config.featuresFile} is updated only by \`autobuild mark-passed <ID>\` after the feature's test passes.`
        : `${rel} is frozen in loop sessions. Change the project's code instead; if a frozen test is wrong, log a BLOCKER in ${config.progressFile}.`,
    );
  }
  process.exit(0);
}

if (tool === "Bash") {
  const command = String(params.command ?? "");

  const GIT_DENIED = new Set(["push", "reset", "checkout", "restore", "clean", "stash", "rebase", "filter-branch", "filter-repo", "update-ref",
    "switch", "worktree", "rm", "mv", "config", "remote", "gc", "prune", "reflog", "am", "apply", "cherry-pick", "revert", "merge", "pull", "fetch", "clone", "submodule"]);
  for (const match of command.matchAll(/\bgit\s+((?:(?:-C|-c|--git-dir|--work-tree)\s+\S+\s+|--[\w-]+(?:=\S+)?\s+)*)([a-z][a-z-]*)([^\n;&|]*)/g)) {
    const sub = match[2];
    const rest = match[3] ?? "";
    if (sub === "push") deny("git push is not allowed; the owner reviews and pushes.");
    if (GIT_DENIED.has(sub)) deny(`git ${sub} can discard, rewrite or fetch work. Allowed: git status/diff/log/show/add/commit.`);
    if ((sub === "branch" || sub === "tag") && /\s-[a-zA-Z]*[dDmM]/.test(rest)) deny(`git ${sub} -d/-m is not allowed.`);
  }
  if (/\brm\s+(?:-[^\s]*[rR]|--recursive)/.test(command) || /\brm\s+-[^\s]+\s+-[^\s]*[rR]/.test(command)) deny("recursive rm is not allowed.");
  if (/\bfind\b[^\n]*\s-delete\b/.test(command)) deny("find -delete is not allowed.");
  if (/(^|[\s;&|(])(curl|wget|npx|bunx|pip3?|pipx|apt(-get)?|brew|yarn|bun|gem|cargo|npm)(\s|$)/.test(command)) {
    deny("network fetches and installs outside the project's package manager are not allowed.");
  }
  if (/\bpnpm\s+(dlx|create)\b/.test(command)) deny("pnpm dlx/create download and run remote code; use `pnpm add` and `pnpm exec`.");
  if (/(^|[\s;&|(])docker(\s|$)/.test(command) && !/\bdocker\s+(ps|compose\s+ps)\b/.test(command)) deny("docker is managed by the owner; only `docker ps` is allowed.");

  const frozenTarget = (token) => Boolean(token) && !/^-/.test(token) && /[/.~]/.test(token) && isFrozen(token);
  for (const match of command.matchAll(/(?:^|[^0-9&>])>{1,2}\s*([^\s;&|<>]+)/g)) {
    const target = match[1];
    if (target.startsWith("&") || target === "/dev/null") continue;
    if (frozenTarget(target)) deny(`redirecting output into ${target} is not allowed (frozen or outside the project).`);
  }
  for (const match of command.matchAll(/\btee\s+(?:-a\s+)?([^\s;&|]+)/g)) {
    if (frozenTarget(match[1])) deny(`tee into ${match[1]} is not allowed (frozen or outside the project).`);
  }
  const mutating = /(^|[\s;&|(])(sed\s+-[^\s]*i|perl\s+-[^\s]*i|mv|cp|rm|unlink|truncate|chmod|chown|ln|touch|dd|install|patch|rsync)(\s|$)/;
  const scripting = /(^|[\s;&|(])(node\s+(-e|--eval|-p|--print)|python3?|ruby|perl\s+-e)(\s|$)/;
  const frozenNames = config.frozen.map((entry) => entry.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
  const frozenAnywhere = new RegExp(`(${[...frozenNames, "\\.autobuild", "\\.claude/"].join("|")})`);
  if (scripting.test(command) && frozenAnywhere.test(command)) deny("inline scripts that reference frozen files are not allowed.");
  const mentionsFrozen = command.split(/[\s;&|()]+/).some((token) => frozenTarget(token));
  if (mentionsFrozen && (mutating.test(command) || scripting.test(command))) {
    deny("that command could modify frozen files or files outside the project. Read them freely; change the project's code instead.");
  }
  process.exit(0);
}
process.exit(0);
