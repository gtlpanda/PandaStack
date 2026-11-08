#!/usr/bin/env node
// StopFailure hook: records why a loop session ended on an API error (rate_limit for a
// usage limit, billing_error, overloaded, …) in <stateDir>/stop-failure.json, so the loop
// can wait for a reset instead of counting a failure. Output is ignored by Claude Code.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { findProjectRoot, loadConfig, statePath } from "../lib/config.mjs";
import { isActive, projectRootFromHookEnv } from "../lib/session.mjs";

if (!isActive()) process.exit(0);
try {
  const config = loadConfig(findProjectRoot(projectRootFromHookEnv()));
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  mkdirSync(statePath(config), { recursive: true });
  writeFileSync(statePath(config, "stop-failure.json"), `${JSON.stringify({ ...input, recordedAt: new Date().toISOString() }, null, 2)}\n`);
} catch {
  /* never fail the session over bookkeeping */
}
process.exit(0);
