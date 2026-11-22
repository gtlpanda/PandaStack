// `autobuild ci <subcommand>`: the ci-optimizer's command line (spec/contracts/ci-optimizer-priority.md,
// "Output" and "Exit codes"). Human lines by default; with --json exactly one JSON document on
// stdout. Errors go to stderr as `autobuild ci: <CODE>: <message>` (and, under --json, also to
// stdout as {"error","message"}). Exit 0 success, 1 a failed check, 2 usage, 3 state or I/O.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { findProjectRoot } from "../config.mjs";
import { SAFE_GIT } from "../proc.mjs";
import { loadProfile, projectConfig } from "./discover.mjs";
import { CiError } from "./state.mjs";

const NOT_A_GIT_REPOSITORY = "NOT_A_GIT_REPOSITORY";
const usageError = (detail) => new CiError("USAGE", detail, 2);
const listOrNone = (items) => (items.length ? items.join(", ") : "none");

async function discover({ root, flags, env, json }) {
  const { profile, reused } = await loadProfile(root, { env, refresh: flags.has("--refresh"), config: projectConfig(root, env) });
  if (json) return { code: 0, json: { reused, profile } };
  return {
    code: 0,
    lines: [
      reused ? "ci profile: reused (inputs unchanged)" : "ci profile: written",
      `languages: ${listOrNone(profile.languages.map((l) => l.name))}`,
      `test frameworks: ${listOrNone(profile.testFrameworks.map((f) => f.name))}`,
      `ci: ${listOrNone(profile.ci.providers.map((p) => `${p.id}(${p.status})`))}`,
      `unknowns: ${listOrNone(profile.unknowns)}`,
    ],
  };
}

const SUBCOMMANDS = {
  discover: { flags: ["--refresh", "--json"], run: discover },
};
const USAGE = `usage: autobuild ci <${Object.keys(SUBCOMMANDS).join("|")}> [flags] [--json]`;

/**
 * The repository root: the directory of an autobuild.json found by findProjectRoot inside the
 * git work tree, else the git top level. Outside any git repository: NOT_A_GIT_REPOSITORY (exit 2).
 */
export function ciRoot(cwd, env = process.env) {
  const result = spawnSync("git", [...SAFE_GIT, "rev-parse", "--show-toplevel"], { cwd, env, encoding: "utf8" });
  const top = result.status === 0 ? result.stdout.trim() : "";
  if (!top) throw new CiError(NOT_A_GIT_REPOSITORY, "not in a git repository", 2);
  const realTop = realpathSync(top);
  let configRoot = null;
  try {
    configRoot = realpathSync(findProjectRoot(cwd));
  } catch {
    return realTop;   // no autobuild.json at or above cwd
  }
  return configRoot === realTop || configRoot.startsWith(`${realTop}${path.sep}`) ? configRoot : realTop;
}

function parse(args) {
  const [sub, ...rest] = args;
  if (sub === undefined || !Object.hasOwn(SUBCOMMANDS, sub)) throw usageError(sub === undefined ? USAGE : `unknown subcommand ${sub}; ${USAGE}`);
  const command = SUBCOMMANDS[sub];
  const unknown = rest.find((arg) => !command.flags.includes(arg));
  if (unknown !== undefined) throw usageError(`${unknown.startsWith("-") ? "unknown flag" : "unexpected argument"} ${unknown} for ci ${sub} (flags: ${command.flags.join(" ")})`);
  return { command, flags: new Set(rest) };
}

function report(error, json, out, err) {
  const known = error instanceof CiError;
  const code = known ? error.code : "ERROR";
  const detail = known ? error.detail : String(error?.message ?? error);
  err.write(code === NOT_A_GIT_REPOSITORY ? `autobuild ci: ${detail}\n` : `autobuild ci: ${code}: ${detail}\n`);
  if (json) out.write(`${JSON.stringify({ error: code, message: detail })}\n`);
  return known ? error.exit : 3;
}

/** Runs `autobuild ci <args>` and returns its exit code; never throws. */
export async function ciMain(args, { cwd = process.cwd(), env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const json = args.includes("--json");
  try {
    const { command, flags } = parse(args);
    const root = ciRoot(cwd, env);
    const result = await command.run({ root, flags, env, json });
    out.write(json ? `${JSON.stringify(result.json)}\n` : `${result.lines.join("\n")}\n`);
    return result.code;
  } catch (error) {
    return report(error, json, out, err);
  }
}
