#!/usr/bin/env node
// Stop hook for autobuild loop sessions. Inert unless AUTOBUILD_ACTIVE=1 (or HARNESS_ACTIVE=1).
//   - review sessions, or a new `BLOCKER <ID>:` line for the current feature → allow
//   - otherwise run the full gate (fail fast):
//       fails                       → block, with the failure output
//       passes, bookkeeping missing → block, with what is missing
//         (passes:true via `autobuild mark-passed`, a progress entry, a feat(<ID>) commit, a clean tree)
//       done                        → allow
//   - after limits.maxStopBlocks attempts → {"continue": false} ends the session
// stdout is pure JSON or empty (Claude Code hook contract).

import { readFileSync } from "node:fs";
import { findProjectRoot, loadConfig } from "../lib/config.mjs";
import { readFeatures, readProgress } from "../lib/features.mjs";
import { runGate } from "../lib/gate.mjs";
import { git } from "../lib/proc.mjs";
import { isActive, projectRootFromHookEnv, readSession, writeSession } from "../lib/session.mjs";

const REASON_LIMIT = 9000;
const allow = () => process.exit(0);
function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: reason.slice(0, REASON_LIMIT) }));
  process.exit(0);
}

if (!isActive()) allow();
let config;
try {
  config = loadConfig(findProjectRoot(projectRootFromHookEnv()));
} catch {
  allow();
}
const session = readSession(config);
if (!session || session.role === "review") allow();

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  input = {};
}

const id = session.featureId;
const escaped = id.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
const progress = readProgress(config);
const blockerLine = new RegExp(`^BLOCKER ${escaped}:`, "m");
if (!blockerLine.test(session.progressAtStart ?? "") && blockerLine.test(progress)) allow();

const maxBlocks = Number(process.env.AUTOBUILD_MAX_STOP_BLOCKS ?? process.env.HARNESS_MAX_STOP_BLOCKS ?? config.limits.maxStopBlocks);
session.stopAttempts = (session.stopAttempts ?? 0) + 1;
session.lastStopHookActive = Boolean(input.stop_hook_active);
writeSession(config, session);
if (session.stopAttempts > maxBlocks) {
  process.stdout.write(JSON.stringify({ continue: false, stopReason: `Stop gate: ${id} still not done after ${maxBlocks} attempts. Ending this session; the loop records no progress.` }));
  process.exit(0);
}

const started = Date.now();
const summary = runGate(config, { featureId: id, baseSha: session.baseSha, failFast: true });
const seconds = Math.round((Date.now() - started) / 1000);
session.lastGate = { at: new Date().toISOString(), ok: summary.ok, seconds, steps: summary.steps.map(({ name, ok, seconds: s }) => ({ name, ok, seconds: s })) };
writeSession(config, session);

if (!summary.ok) {
  const failed = summary.steps.filter((step) => !step.ok);
  block(
    [
      `Stop gate for ${id}: FAILED (attempt ${session.stopAttempts}/${maxBlocks}, ${seconds}s). Keep working until the gate passes.`,
      "Fix the code, not the frozen tests. If a frozen test or contract is genuinely wrong, append one line",
      `\`BLOCKER ${id}: <the exact failing assertion and why it cannot be satisfied>\` to ${config.progressFile}, commit it, and stop.`,
      "",
      ...failed.map((step) => `### ${step.name}\n${step.tail}`),
    ].join("\n"),
  );
}

const missing = [];
const feature = readFeatures(config).features.find((candidate) => candidate.id === id);
if (!feature?.passes) missing.push(`${config.featuresFile} does not mark ${id} passing: run \`autobuild mark-passed ${id}\` (or the project's wrapper).`);
if (!new RegExp(`^## ${escaped} `, "m").test(progress)) missing.push(`${config.progressFile} has no "## ${id} — …" entry: append one.`);
const status = git(config, ["status", "--porcelain"]);
if (status.output.trim() !== "") missing.push(`The working tree is not clean; commit everything for ${id}:\n${status.output.trim().split("\n").slice(0, 30).join("\n")}`);
const head = git(config, ["log", "-1", "--format=%s"]);
if (!head.output.trim().startsWith(`feat(${id}):`)) missing.push(`The last commit must be "feat(${id}): …" (it is "${head.output.trim()}").`);
if (missing.length > 0) block(`Stop gate for ${id}: tests pass, but the feature is not finished:\n- ${missing.join("\n- ")}`);
allow();
