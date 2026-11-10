import { withTrackedRun } from '../../../../core/skills/run-records/tracking.mjs';
import { autobuildTracking } from '../../../../core/skills/run-records/adapters.mjs';
// Codex sessions use the saved CLI login. No Claude flags, hooks or API fallback.
import { codexConcurrencyArgs } from "../../../../scripts/agent-config.mjs";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { buildEnv } from "./proc.mjs";

export function codexArgs(config, { prompt, appendSystemPrompt = "", role = "builder", outputFile, schemaFile } = {}) {
  const probe = role === "probe";
  const args = ["exec", "--json", "--color", "never", "--sandbox", probe ? "read-only" : "workspace-write",
    "-c", 'approval_policy="never"', "--model", probe ? config.probeModel : config.model,
    "-c", `model_reasoning_effort=${JSON.stringify(probe ? "high" : config.codex.reasoningEffort)}`,
    "-c", `agents.default_subagent_model=${JSON.stringify(config.subagentModel)}`];
  args.push(...codexConcurrencyArgs(config.maxConcurrentSubagents));
  if (outputFile) args.push("--output-last-message", outputFile);
  if (schemaFile) args.push("--output-schema", schemaFile);
  const rules = probe ? "Do not use tools. Reply OK." : [
    "AUTOBUILD CODEX BACKEND: Read AGENTS.md and CLAUDE.md if present, and the project spec/contracts.",
    "No human is present. Do the authorized work without questions. Never push, change branches, edit git control files, or launch Claude.",
    `Frozen paths (never edit): ${JSON.stringify(config.frozen)}. Writable exceptions: ${JSON.stringify(config.writable)}.`,
    "Leave git staging, commits and feature passes flags to the outer harness. This overrides the Claude-specific mark-passed/commit/Stop-hook procedure.",
    "Run tests, fix failures, append the required progress entry, and stop. The outer harness reruns the full gate and commits only verified work.",
    `If delegating, use ${config.subagentModel} for subagents. Keep them on this working copy with separate files.`,
  ].join("\n");
  args.push("-");
  return { args, input: `${prompt}\n\n${appendSystemPrompt}\n\n${rules}\n` };
}

export async function runCodex(config, options, track = (child) => child) {
  if (options.role === "probe") return runCodexWork(config, options, track);
  return withTrackedRun(autobuildTracking(config, "session"), () => runCodexWork(config, options, track));
}

async function runCodexWork(config, options, track) {
  const { args, input } = codexArgs(config, options);
  const out = openSync(options.logFile, "w");
  const err = openSync(`${options.logFile}.stderr`, "w");
  const env = buildEnv(config, { AUTOBUILD_BACKEND: "codex", AUTOBUILD_ACTIVE: "1", AUTOBUILD_ROLE: options.role });
  // A nested CLI must not attach itself to its parent's thread.
  delete env.CODEX_THREAD_ID;
  try {
    return await new Promise((resolve) => {
      const child = track(spawn(config.codexBin, args, { cwd: config.root, env, detached: true, stdio: ["pipe", out, err] }));
      const killGroup = (signal) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
      };
      let timedOut = false;
      let killTimer;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), 5000);
      }, (options.role === "probe" ? 2 : config.codex.sessionTimeoutMinutes) * 60_000);
      const finish = (code) => { clearTimeout(timer); clearTimeout(killTimer); killGroup("SIGKILL"); resolve(timedOut ? 124 : code); };
      child.once("close", (code) => finish(code ?? 1));
      child.once("error", () => finish(127));
      child.stdin.on("error", () => {}); // early CLI failure can close stdin before the prompt is sent
      child.stdin.end(input);
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

/** Normalize only protocol events, never text inside a tool result or assistant message. */
export function readCodexResult(file) {
  if (!existsSync(file)) return null;
  let result = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "turn.completed") result = { subtype: "success", is_error: false, num_turns: 1, usage: event.usage };
    if (event.type === "turn.failed" || event.type === "error") {
      result = { subtype: "error_during_execution", is_error: true, result: event.error?.message ?? event.message ?? "Codex failed" };
    }
  }
  return result;
}
