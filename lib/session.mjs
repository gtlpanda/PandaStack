// Per-session state shared by the loop and the hooks (<stateDir>/session.json).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { statePath } from "./config.mjs";

export function readSession(config) {
  const file = statePath(config, "session.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

export function writeSession(config, session) {
  mkdirSync(statePath(config), { recursive: true });
  writeFileSync(statePath(config, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
}

export function readStopFailure(config) {
  const file = statePath(config, "stop-failure.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function clearStopFailure(config) {
  rmSync(statePath(config, "stop-failure.json"), { force: true });
}

export function isActive(env = process.env) {
  return env.AUTOBUILD_ACTIVE === "1" || env.HARNESS_ACTIVE === "1";
}

export function projectRootFromHookEnv(env = process.env, fallback = process.cwd()) {
  return path.resolve(env.CLAUDE_PROJECT_DIR ?? fallback);
}
