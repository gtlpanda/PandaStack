// Process helpers: the run environment and synchronous command execution.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The environment for tools and headless sessions:
 * - no inherited Claude session identity (nested sessions misbehave),
 * - configured PATH and LD_LIBRARY_PATH prefixes (e.g. a Node version, browser libraries),
 * - configured extra variables.
 */
export function buildEnv(config, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(key)) delete env[key];
  }
  const prepend = (config.env.pathPrepend ?? []).filter((dir) => existsSync(dir));
  if (prepend.length) env.PATH = [...prepend, env.PATH ?? ""].join(":");
  const libs = (config.env.ldLibraryPath ?? []).filter((dir) => existsSync(dir));
  if (libs.length) env.LD_LIBRARY_PATH = [...libs, ...(env.LD_LIBRARY_PATH ? [env.LD_LIBRARY_PATH] : [])].join(":");
  Object.assign(env, config.env.vars ?? {}, extra);
  return env;
}

/** Runs a shell command in the project root; never throws. */
export function sh(config, command, options = {}) {
  const started = Date.now();
  const result = spawnSync("bash", ["-c", command], {
    cwd: config.root,
    env: options.env ?? buildEnv(config),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeoutMs ?? 40 * 60 * 1000,
    stdio: options.inherit ? "inherit" : "pipe",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, status: result.status, output, ms: Date.now() - started };
}

export function quote(arg) {
  return /^[A-Za-z0-9_./=:@+-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

export function git(config, args) {
  return sh(config, ["git", ...args].map(quote).join(" "));
}

/** The last `chars` characters, starting at a line boundary. */
export function tail(text, chars = 6000) {
  if (text.length <= chars) return text;
  const cut = text.slice(-chars);
  const newline = cut.indexOf("\n");
  return `…\n${newline >= 0 ? cut.slice(newline + 1) : cut}`;
}
