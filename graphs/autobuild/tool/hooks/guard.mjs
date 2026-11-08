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
// PandaStack's shell reader (heredocs, quoting, bash -c, eval) and path resolution, shared with
// /build-app's guard and the review gate.
import { gitSubcommand, realish, simpleCommands } from "../../../build/skills/build-app/driver/hooks/guard-rules.mjs";

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
const REAL_ROOT = realish(ROOT);
const role = process.env.AUTOBUILD_ROLE ?? process.env.HARNESS_ROLE ?? "builder";
const tool = input.tool_name ?? "";
const params = input.tool_input ?? {};

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Autobuild guard: ${reason}` } }));
  process.exit(0);
}

// The kit itself (lib/, hooks/): a session never rewrites the tool that checks it.
const KIT_HOME = path.resolve(import.meta.dirname, "..");
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

/** Whether writing `file` is forbidden for this role: through its path as written, or through
 * symlinks to where it really lands (a link to a frozen dir, or out of the project). */
function isFrozen(file) {
  const lexical = path.resolve(ROOT, expand(file));
  return isFrozenAt(lexical, ROOT) || isFrozenAt(realish(lexical), REAL_ROOT);
}

/** Whether a directory is out of the project (temp dirs excepted) or in its .git, as written or through symlinks. */
function outsideOrGitDir(dir) {
  return [[dir, ROOT], [realish(dir), REAL_ROOT]].some(([absolute, root]) => {
    const rel = path.relative(root, absolute).split(path.sep).join("/");
    if (rel === ".git" || rel.startsWith(".git/")) return true;
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return false;
    return !TEMP_DIRS.some((temp) => absolute === temp || absolute.startsWith(`${temp}/`));
  });
}

function isFrozenAt(absolute, root) {
  const rel = path.relative(root, absolute).split(path.sep).join("/");
  // The project's git dir: a hook or config written there runs on every later commit, the owner's too.
  if (rel === ".git" || rel.startsWith(".git/")) return true;
  if (absolute === KIT_HOME || absolute.startsWith(`${KIT_HOME}/`)) return true;
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
  for (const { word, args } of simpleCommands(command)) {
    if (word !== "git") continue;
    const { opts, sub: words } = gitSubcommand(args);
    // Config set on the command line that runs code: an alias (any subcommand, or a shell
    // command with !), a hooks path, or an fsmonitor.
    const RUNS_CODE = /^(alias\.|core\.hookspath=|core\.fsmonitor=)/i;
    if (opts.some((opt, i) => RUNS_CODE.test(opt.replace(/^(-c\s*|--config-env=)/, "")) && /^(-c|--config-env=)/.test(opt) || (opt === "-c" && RUNS_CODE.test(opts[i + 1] ?? "")))) {
      deny("git config that runs code (an alias, core.hooksPath, core.fsmonitor) is not allowed on the command line.");
    }
    const sub = words[0] ?? "";
    const rest = words.slice(1).join(" ");
    // send-pack is push without the word (/build-app's guard denies it too).
    if (sub === "push" || sub === "send-pack") deny("git push is not allowed; the owner reviews and pushes.");
    if (GIT_DENIED.has(sub)) deny(`git ${sub} can discard, rewrite or fetch work. Allowed: git status/diff/log/show/add/commit.`);
    if ((sub === "branch" || sub === "tag") && /(^|\s)(-[a-zA-Z]*[dDmM]|--delete|--move)(\s|$)/.test(rest)) deny(`git ${sub} -d/-m is not allowed.`);
  }
  // A cd changes what a relative path means. cd out of the project (temp dirs excepted), into its
  // .git, or to a computed place is denied; after a cd inside the project, every path below is
  // checked from that directory as well as from the root (cd tests && echo x > a.test).
  const cdDirs = [];
  for (const { word, args } of simpleCommands(command)) {
    if (word !== "cd" && word !== "pushd") continue;
    const target = args.find((arg) => !arg.startsWith("-")) ?? "~";
    // The shell reader shows a command substitution as SUBST.
    if (/[$`]|SUBST/.test(target)) deny("cd to a computed directory is not allowed; use paths from the project root.");
    const dir = path.resolve(ROOT, expand(target));
    if (outsideOrGitDir(dir)) deny(`cd into ${target} is not allowed (outside the project, or its .git); use paths from the project root.`);
    cdDirs.push(dir);
  }
  if (/\brm\s+(?:-[^\s]*[rR]|--recursive)/.test(command) || /\brm\s+-[^\s]+\s+-[^\s]*[rR]/.test(command)) deny("recursive rm is not allowed.");
  if (/\bfind\b[^\n]*\s-delete\b/.test(command)) deny("find -delete is not allowed.");
  if (/(^|[\s;&|(])(curl|wget|npx|bunx|pip3?|pipx|apt(-get)?|brew|yarn|bun|gem|cargo|npm)(\s|$)/.test(command)) {
    deny("network fetches and installs outside the project's package manager are not allowed.");
  }
  if (/\bpnpm\s+(dlx|create)\b/.test(command)) deny("pnpm dlx/create download and run remote code; use `pnpm add` and `pnpm exec`.");
  if (/(^|[\s;&|(])docker(\s|$)/.test(command) && !/\bdocker\s+(ps|compose\s+ps)\b/.test(command)) deny("docker is managed by the owner; only `docker ps` is allowed.");

  const frozenHere = (token) => isFrozen(token) || cdDirs.some((dir) => isFrozen(path.resolve(dir, expand(token))));
  // A token is taken for a path when it looks like one, or when the command cd'd (then a bare name is one).
  const frozenTarget = (token) => Boolean(token) && !/^-/.test(token) && (/[/.~]/.test(token) || cdDirs.length > 0) && frozenHere(token);
  // Every write redirect: >, >>, >|, with or without an fd (1>, 2>>) or & (&>, >&file). Only fd
  // duplication (2>&1, >&2) and /dev/null are not a write to a file.
  for (const match of command.matchAll(/(?:^|[^<>])(?:\d+|&)?(>>|>\||>)(&?)\s*([^\s;&|<>]+)/g)) {
    const [, , dup, target] = match;
    if ((dup && /^\d+$/.test(target)) || target === "/dev/null") continue;
    if (frozenTarget(target)) deny(`redirecting output into ${target} is not allowed (frozen or outside the project).`);
  }
  // Files a command writes through its arguments: every tee operand, and --output (git log,
  // diff, format-patch, and others take it).
  for (const { word, args } of simpleCommands(command)) {
    const targets = word === "tee" ? args.filter((arg) => !arg.startsWith("-")) : [];
    args.forEach((arg, i) => {
      if (arg.startsWith("--output=")) targets.push(arg.slice("--output=".length));
      else if (arg === "--output" && args[i + 1]) targets.push(args[i + 1]);
    });
    for (const target of targets) if (frozenTarget(target)) deny(`${word} writing ${target} is not allowed (frozen or outside the project).`);
  }
  const mutating = /(^|[\s;&|(])(sed\s+-[^\s]*i|perl\s+-[^\s]*i|mv|cp|rm|unlink|truncate|chmod|chown|ln|touch|dd|install|patch|rsync)(\s|$)/;
  const scripting = /(^|[\s;&|(])(node\s+(-e|--eval|-p|--print)|python3?|ruby|perl\s+-e)(\s|$)/;
  const frozenNames = config.frozen.map((entry) => entry.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
  const frozenAnywhere = new RegExp(`(${[...frozenNames, KIT_HOME.replace(/[.+^${}()|[\]\\]/g, "\\$&"), "\\.claude/"].join("|")})`);
  if (scripting.test(command) && frozenAnywhere.test(command)) deny("inline scripts that reference frozen files are not allowed.");
  const mentionsFrozen = command.split(/[\s;&|()]+/).some((token) => frozenTarget(token));
  // In-place edits, whatever flags come first (sed -E -i, sed -e s/a/b/ -i, perl -pi).
  const inPlace = simpleCommands(command).some(({ word, args }) => (word === "sed" || word === "perl") && args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place")));
  if (mentionsFrozen && (mutating.test(command) || inPlace || scripting.test(command))) {
    deny("that command could modify frozen files or files outside the project. Read them freely; change the project's code instead.");
  }
  process.exit(0);
}
process.exit(0);
