// Process helpers: the run environment and synchronous command execution.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildEnv as sessionEnv } from "../../../build/skills/build-app/driver/proc.mjs";

/** The kit's own bin directory, so sessions and gate commands can always run `autobuild`. */
const KIT_BIN = path.resolve(import.meta.dirname, "..", "bin");

/** Already-validated launch selection for child config reloads, applied after project env. */
export function sessionConfigEnv(config) {
  // sessionSettings also accepts partial Claude configs outside the launch path.
  const backend = config.backend ?? "claude";
  return {
    AUTOBUILD_BACKEND: backend,
    AUTOBUILD_DELIVERY_MODE: config.deliveryMode ?? "full",
    AUTOBUILD_MODEL: config.model,
    AUTOBUILD_SUBAGENT_MODEL: config.subagentModel,
    AUTOBUILD_PROBE_MODEL: config.probeModel,
    [`AUTOBUILD_${backend.toUpperCase()}_BIN`]: config[`${backend}Bin`],
  };
}

/** The evidence directory relative to the project root, with forward slashes. */
export function evidenceRel(config) {
  return path.relative(config.root, config.evidenceDir).split(path.sep).join("/");
}

/** The session prompt's instruction on where run evidence goes (the literal project path). */
export function evidencePromptLine(config) {
  return `Write verification, provenance and QA output (logs, screenshots, receipts) under ${evidenceRel(config)}/ (gitignored; scripts also get its absolute path as AUTOBUILD_EVIDENCE_DIR); commit at most a manifest of hashes (\`autobuild evidence manifest --out <file>\`).`;
}

/**
 * The environment for tools and headless sessions:
 * - no inherited Claude session identity (nested sessions misbehave),
 * - configured PATH and LD_LIBRARY_PATH prefixes (e.g. a Node version, browser libraries),
 * - configured extra variables.
 */
export function buildEnv(config, extra = {}) {
  // /build-app's rule: drop the parent session's identity and settings env, keep how this
  // machine authenticates (CLAUDE_CODE_OAUTH_TOKEN) and which provider it uses (CLAUDE_CODE_USE_*).
  const env = sessionEnv();
  const prepend = (config.env.pathPrepend ?? []).filter((dir) => existsSync(dir));
  const inherited = (env.PATH ?? "").split(":").filter(Boolean);
  env.PATH = [...prepend, ...(inherited.includes(KIT_BIN) ? [] : [KIT_BIN]), ...inherited].join(":");
  const libs = (config.env.ldLibraryPath ?? []).filter((dir) => existsSync(dir));
  if (libs.length) env.LD_LIBRARY_PATH = [...libs, ...(env.LD_LIBRARY_PATH ? [env.LD_LIBRARY_PATH] : [])].join(":");
  if (config.evidenceDir) env.AUTOBUILD_EVIDENCE_DIR = config.evidenceDir;
  Object.assign(env, config.env.vars ?? {}, extra);
  return env;
}

export const SH_TIMEOUT_MS = 40 * 60 * 1000;

/** How a shell command runs in the project root: the one description `sh` and the gate's pool share. */
export function shSpec(config, command, options = {}) {
  return { argv: ["bash", "-c", command], cwd: config.root, cwdRel: ".", env: options.env ?? buildEnv(config), timeoutMs: options.timeoutMs ?? SH_TIMEOUT_MS };
}

/** Runs a spec ({argv, cwd, env, timeoutMs, notes?}) to completion; never throws. */
export function runSpec(spec, options = {}) {
  const started = Date.now();
  const result = spawnSync(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: spec.timeoutMs,
    stdio: options.inherit ? "inherit" : "pipe",
  });
  return { ok: result.status === 0, status: result.status, output: specOutput(spec, result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`, result.error), ms: Date.now() - started };
}

/** A step's output with the spawn error and the meaning of its exit status appended. */
export function specOutput(spec, status, output, error) {
  const note = spec.notes?.[status];
  return `${output}${error ? `\n${error.message ?? error}` : ""}${note ? `\n${note}` : ""}`;
}

/** Runs a shell command in the project root; never throws. */
export function sh(config, command, options = {}) {
  return runSpec(shSpec(config, command, options), options);
}

export function quote(arg) {
  return /^[A-Za-z0-9_./=:@+-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

// The loop's own git never runs repo hooks or an fsmonitor: a session could have planted either,
// and the loop must not run what a session wrote.
export const SAFE_GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

export function git(config, args) {
  return sh(config, ["git", ...SAFE_GIT, ...args].map(quote).join(" "));
}

/** The last `chars` characters, starting at a line boundary. */
export function tail(text, chars = 6000) {
  if (text.length <= chars) return text;
  const cut = text.slice(-chars);
  const newline = cut.indexOf("\n");
  return `…\n${newline >= 0 ? cut.slice(newline + 1) : cut}`;
}
