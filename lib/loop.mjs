// The autobuild loop: one fresh headless Claude session per feature, until every feature
// passes, the iteration cap is hit, NO_PROGRESS_LIMIT sessions in a row make no progress,
// or something needs a human. A usage limit is a pause, not a failure: the loop sleeps
// until the reset (or probes) and retries the same feature without counting it.
//
// Exit codes:
//   0 every feature passes       2 no progress (limit hit)    3 the rest are blocked
//   4 frozen files changed       5 preflight failed           6 total budget reached
//   7 max iterations reached     8 usage limit resets too far away (rerun later)
//   9 billing / spend limit      10 auth problem              11 another loop is running
//   130 interrupted

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { statePath } from "./config.mjs";
import { countPassing, featureById, nextFeature, readBlockers, readFeatures, readProgress, writeFeatures, blockedClosure } from "./features.mjs";
import { frozenChanges } from "./gate.mjs";
import { classifyOutcome, parseResetTime, planLimitWait } from "./limits.mjs";
import { buildEnv, git, sh } from "./proc.mjs";
import { clearStopFailure, readStopFailure, writeSession } from "./session.mjs";
import { runFeatureTests } from "./tests.mjs";

const HOME = path.resolve(import.meta.dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runLoop(config, options = {}) {
  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const logsDir = path.join(config.root, config.logsDir);
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(statePath(config), { recursive: true });
  const loopLog = path.join(logsDir, `loop-${runId}.log`);
  const log = (message) => {
    const line = `[${new Date().toISOString().replace(/\.\d+Z$/, "Z")}] ${message}`;
    console.log(line);
    appendFileSync(loopLog, `${line}\n`);
  };
  const limits = config.limits;
  const sleepMs = (ms) => sleep(Math.min(ms, Number(process.env.AUTOBUILD_MAX_SLEEP_MS ?? ms)));

  // One loop per project.
  const pidFile = statePath(config, "loop.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive && pid !== process.pid) {
      log(`another autobuild loop (pid ${pid}) is running for this project`);
      return 11;
    }
  }
  writeFileSync(pidFile, String(process.pid));
  const cleanup = () => rmSync(pidFile, { force: true });
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    log("interrupted");
    cleanup();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const pre = preflight(config, log);
    if (pre !== 0) return pre;
    log(`loop ${runId}: up to ${limits.maxIterations} iterations; ${limits.maxTurns} turns and $${limits.maxBudgetUsd} (estimated) per session; review every ${limits.reviewEvery} features; model ${config.model} (subagents ${config.subagentModel})`);

    let iteration = 0;
    let noProgress = 0;
    let completedSinceReview = 0;
    let lastReviewSha = git(config, ["rev-parse", "HEAD"]).output.trim();
    let totalCost = 0;
    let transientStreak = 0;
    let limitWaitedMs = 0;

    while (iteration < limits.maxIterations && !interrupted) {
      const doc = readFeatures(config);
      const blockers = readBlockers(readProgress(config));
      const feature = nextFeature(doc, blockers);
      if (!feature) {
        if (doc.features.every((candidate) => candidate.passes)) {
          log("every feature passes. Done.");
          return 0;
        }
        log(`no feature can be built: the rest are blocked or depend on blocked features: ${[...blockedClosure(doc, blockers)].join(", ")}`);
        return 3;
      }

      const base = git(config, ["rev-parse", "HEAD"]).output.trim();
      const passingBefore = countPassing(doc);
      const label = `${String(iteration + 1).padStart(2, "0")}-${feature.id}`;
      const iterLog = path.join(logsDir, `${runId}-iter-${label}${limitWaitedMs > 0 || transientStreak > 0 ? `-retry-${Date.now()}` : ""}.jsonl`);
      writeSession(config, { role: "builder", featureId: feature.id, iteration: iteration + 1, baseSha: base, startedAt: new Date().toISOString(), progressAtStart: readProgress(config), stopAttempts: 0 });
      clearStopFailure(config);

      log(`iteration ${iteration + 1}: ${feature.id} — ${feature.title} (base ${base.slice(0, 8)}, ${passingBefore} passing)`);
      const started = Date.now();
      const exitCode = await runClaude(config, {
        role: "builder",
        prompt: config.prompt,
        appendSystemPrompt: builderSystemPrompt(config, feature, iteration + 1),
        maxTurns: limits.maxTurns,
        maxBudgetUsd: limits.maxBudgetUsd,
        allowedTools: config.allowedTools,
        logFile: iterLog,
      });
      const elapsed = Math.round((Date.now() - started) / 1000);
      const result = readResult(iterLog);
      totalCost += Number(result?.total_cost_usd ?? 0);

      // Independent verification: never trust the session's own account.
      const frozen = frozenChanges(config, base);
      if (frozen.changed.length > 0) {
        log(`iteration ${iteration + 1}: FROZEN FILES CHANGED — stopping for a human:\n${frozen.changed.join("\n")}`);
        return 4;
      }
      const committed = git(config, ["log", `${base}..HEAD`, "--format=%s"]).output.split("\n").some((line) => line.startsWith(`feat(${feature.id}):`));
      const passes = featureById(readFeatures(config), feature.id).passes === true;
      const blockerNow = readBlockers(readProgress(config)).has(feature.id);
      let outcome = "INCOMPLETE";
      if (passes && committed) {
        const check = runFeatureTests(config, [feature]);
        if (check.every((step) => step.ok)) {
          outcome = "PASSED";
        } else {
          outcome = "FLAG_REVERTED";
          const fresh = readFeatures(config);
          featureById(fresh, feature.id).passes = false;
          writeFeatures(config, fresh);
          sh(config, `git add ${config.featuresFile} && git commit -q -m "chore(autobuild): ${feature.id} test fails after the session; passes reverted"`);
        }
      } else if (blockerNow && !blockers.has(feature.id)) {
        outcome = "BLOCKED";
        sh(config, `git add ${config.progressFile} && git diff --cached --quiet || git commit -q -m "chore(${feature.id}): BLOCKER logged"`);
      }

      const summary = `${result?.subtype ?? "no_result"}, ${result?.num_turns ?? 0} turns, $${Number(result?.total_cost_usd ?? 0).toFixed(2)} est, ${(result?.permission_denials ?? []).length} permission denials, ${elapsed}s`;

      // A session that ended on an API problem rather than its own work.
      if (outcome === "INCOMPLETE") {
        // Only error channels are read: the transcript itself may discuss "limits" (product code, tests).
        const errored = result && (result.is_error || result.subtype !== "success") ? result : null;
        const verdict = classifyOutcome({ stopFailure: readStopFailure(config), result: errored, text: stderrOf(iterLog) });
        if (verdict.kind === "usage_limit") {
          const resetAt = parseResetTime(verdict.message);
          const plan = planLimitWait({ resetAt, maxWaitHours: limits.maxLimitWaitHours - limitWaitedMs / 3_600_000, marginMinutes: limits.limitMarginMinutes, probeEveryMinutes: limits.probeEveryMinutes });
          log(`iteration ${iteration + 1}: usage limit (${verdict.message || "no message"}); ${summary}; not counted`);
          if (plan.action === "give_up") {
            log(`the limit resets around ${plan.resumeAt.toISOString()}, beyond the ${limits.maxLimitWaitHours} h wait cap. Stopping; rerun \`autobuild run\` after the reset (finished work is committed).`);
            return 8;
          }
          if (plan.action === "wait") {
            log(`waiting until ${plan.resumeAt.toISOString()} (reset ${resetAt.toISOString()} + ${limits.limitMarginMinutes} min), then retrying ${feature.id}`);
            limitWaitedMs += plan.waitMs;
            await sleepMs(plan.waitMs);
          } else {
            const waited = await probeUntilAvailable(config, log, limits, sleepMs);
            limitWaitedMs += waited.ms;
            if (!waited.ok) {
              log(`usage still unavailable after ${limits.maxLimitWaitHours} h of probing. Stopping; rerun \`autobuild run\` later.`);
              return 8;
            }
          }
          continue;
        }
        if (verdict.kind === "billing") {
          log(`iteration ${iteration + 1}: spend or credit limit (${verdict.message}). Stopping; the loop never spends past a limit.`);
          return 9;
        }
        if (verdict.kind === "auth") {
          log(`iteration ${iteration + 1}: authentication problem (${verdict.message}). Stopping; log in again, then rerun.`);
          return 10;
        }
        if (verdict.kind === "transient" && transientStreak < limits.maxTransientRetries) {
          transientStreak += 1;
          log(`iteration ${iteration + 1}: API overloaded or server error (${verdict.message}); ${summary}; waiting ${limits.transientWaitMinutes} min, retry ${transientStreak}/${limits.maxTransientRetries}, not counted`);
          await sleepMs(limits.transientWaitMinutes * 60_000);
          continue;
        }
      }
      transientStreak = 0;
      limitWaitedMs = 0;
      iteration += 1;

      const dirty = git(config, ["status", "--porcelain"]).output.trim();
      if (outcome !== "PASSED" && dirty) log(`iteration ${iteration}: uncommitted work left in the tree (kept for the next attempt):\n${dirty.split("\n").slice(0, 30).join("\n")}`);
      log(`iteration ${iteration}: ${feature.id} ${outcome} (exit ${exitCode}, ${summary}, passing ${passingBefore}→${countPassing(readFeatures(config))}); log ${path.relative(config.root, iterLog)}`);

      if (outcome === "PASSED") {
        noProgress = 0;
        completedSinceReview += 1;
      } else {
        noProgress += 1;
      }
      if (limits.totalBudgetUsd && totalCost >= limits.totalBudgetUsd) {
        log(`estimated total $${totalCost.toFixed(2)} reached totalBudgetUsd $${limits.totalBudgetUsd}. Stopping.`);
        return 6;
      }
      if (noProgress >= limits.noProgressLimit) {
        log(`${noProgress} consecutive iterations without progress. Stopping for a human.`);
        return 2;
      }
      if (completedSinceReview >= limits.reviewEvery) {
        await runReview(config, { since: lastReviewSha, iteration, runId, log });
        lastReviewSha = git(config, ["rev-parse", "HEAD"]).output.trim();
        completedSinceReview = 0;
      }
    }
    log(`maxIterations=${limits.maxIterations} reached (estimated total $${totalCost.toFixed(2)}). Stopping.`);
    return 7;
  } finally {
    cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function preflight(config, log) {
  let failed = false;
  if (config.branch) {
    const branch = git(config, ["rev-parse", "--abbrev-ref", "HEAD"]).output.trim();
    if (branch !== config.branch) {
      log(`preflight: on branch '${branch}'; this project's loop runs only on '${config.branch}'`);
      failed = true;
    }
  }
  const dirty = git(config, ["status", "--porcelain"]).output.trim();
  if (dirty) {
    const frozen = frozenChanges(config, "HEAD");
    if (frozen.changed.length > 0) {
      log(`preflight: frozen files have uncommitted changes; a human must resolve them first:\n${frozen.changed.join("\n")}`);
      failed = true;
    } else {
      log(`preflight: uncommitted changes from an earlier attempt are kept for the next session:\n${dirty.split("\n").slice(0, 20).join("\n")}`);
    }
  }
  const claude = sh(config, `command -v ${config.claudeBin}`);
  if (!claude.ok) {
    log(`preflight: ${config.claudeBin} not found on PATH`);
    failed = true;
  }
  for (const check of config.preflight ?? []) {
    const result = sh(config, check.command, { timeoutMs: 120_000 });
    if (!result.ok) {
      log(`preflight: ${check.name} failed${check.hint ? ` (${check.hint})` : ""}`);
      failed = true;
    }
  }
  if (failed) {
    log("preflight FAILED");
    return 5;
  }
  if (config.install) {
    log(`preflight: ${config.install}`);
    const install = sh(config, config.install, { timeoutMs: 15 * 60_000 });
    if (!install.ok) {
      log(`preflight: install failed:\n${install.output.slice(-2000)}`);
      return 5;
    }
  }
  log(`preflight OK (project node ${sh(config, "node --version").output.trim()}, HEAD ${git(config, ["rev-parse", "--short", "HEAD"]).output.trim()})`);
  return 0;
}

function builderSystemPrompt(config, feature, iteration) {
  const custom = config.systemPrompt ? `\n${config.systemPrompt}` : "";
  return `AUTONOMOUS BUILD LOOP, iteration ${iteration} of at most ${config.limits.maxIterations}. The feature for this session is ${feature.id} (chosen by autobuild).
No human is present. Never ask questions or wait for input; make the reasonable call and record it in the decision log.
Follow the project's autonomous-build rules in CLAUDE.md exactly. Where they conflict with user-level instructions (plan mode, asking before acting, worktree isolation, retro/changelog after each change), the project rules win in this session.
Do not use plan mode. Subagents work on the working copy (no worktree isolation).
When the feature is done: mark it passing (\`autobuild mark-passed ${feature.id}\` or the project's wrapper), append to ${config.progressFile}, commit "feat(${feature.id}): …", then stop. The Stop hook runs the full gate; if it blocks, fix what it reports.${custom}`;
}

/** Settings injected into loop sessions: the hooks the project doesn't own, plus deny rules for frozen paths. */
export function sessionSettings(config) {
  const hook = (file, timeout, extra = {}) => [{ hooks: [{ type: "command", command: `node "${path.join(HOME, "hooks", file)}"`, timeout, ...extra }] }];
  const hooks = { StopFailure: hook("stop-failure.mjs", 30) };
  if (config.hooks === "inject") {
    hooks.PreToolUse = [{ matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash", hooks: [{ type: "command", command: `node "${path.join(HOME, "hooks", "guard.mjs")}"`, timeout: 30, onFailure: "block" }] }];
    hooks.Stop = hook("stop-gate.mjs", 2700);
  }
  const deny = config.frozen.filter((entry) => !(config.writable ?? []).includes(entry)).flatMap((entry) => [`Edit(/${entry})`, `Edit(/${entry}/**)`]);
  return { hooks, permissions: { deny: [...deny, "Bash(git push)", "Bash(git push *)", "Bash(rm -rf *)", "Bash(curl *)", "Bash(wget *)", "Bash(npx *)"] } };
}

async function runClaude(config, { role, prompt, appendSystemPrompt, maxTurns, maxBudgetUsd, allowedTools, logFile }) {
  const settingsFile = statePath(config, `session-settings.json`);
  writeFileSync(settingsFile, `${JSON.stringify(sessionSettings(config), null, 2)}\n`);
  const env = buildEnv(config, {
    AUTOBUILD_ACTIVE: "1",
    HARNESS_ACTIVE: "1",
    AUTOBUILD_ROLE: role,
    HARNESS_ROLE: role,
    AUTOBUILD_HOME: HOME,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_SUBAGENT_MODEL: config.subagentModel,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    CLAUDE_CODE_RETRY_WATCHDOG: "1",
    CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: String(config.limits.watchdogMaxWaitMs),
  });
  const args = [
    "-p", prompt,
    "--model", config.model,
    "--max-turns", String(maxTurns),
    "--max-budget-usd", String(maxBudgetUsd),
    "--permission-mode", "dontAsk",
    "--settings", settingsFile,
    "--allowedTools", ...allowedTools,
    "--disallowedTools", ...config.disallowedTools,
    "--strict-mcp-config",
    "--append-system-prompt", appendSystemPrompt,
    "--output-format", "stream-json", "--verbose", "--include-hook-events",
  ];
  const out = openSync(logFile, "w");
  const err = openSync(`${logFile}.stderr`, "w");
  try {
    return await new Promise((resolve) => {
      const child = spawn(config.claudeBin, args, { cwd: config.root, env, stdio: ["ignore", out, err] });
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(127));
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

function readResult(file) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").trim().split("\n").reverse();
  for (const line of lines) {
    if (!line.includes('"type":"result"')) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function stderrOf(file) {
  const candidate = `${file}.stderr`;
  return existsSync(candidate) ? readFileSync(candidate, "utf8").slice(-20000) : "";
}

/** Probes every probeEveryMinutes with a one-turn session until usage is available again. */
async function probeUntilAvailable(config, log, limits, sleepMs) {
  const started = Date.now();
  const deadline = started + limits.maxLimitWaitHours * 3_600_000;
  while (Date.now() < deadline) {
    log(`usage limit: reset time unknown; probing again in ${limits.probeEveryMinutes} min`);
    await sleepMs(limits.probeEveryMinutes * 60_000);
    const probeLog = statePath(config, "probe.jsonl");
    const env = buildEnv(config, { CLAUDE_CODE_RETRY_WATCHDOG: "0" });
    const code = await new Promise((resolve) => {
      const out = openSync(probeLog, "w");
      const child = spawn(config.claudeBin, ["-p", "Reply with OK.", "--model", config.probeModel, "--max-turns", "1", "--tools", "", "--strict-mcp-config", "--output-format", "stream-json", "--verbose"], { cwd: config.root, env, stdio: ["ignore", out, out] });
      child.on("close", (exitCode) => {
        closeSync(out);
        resolve(exitCode ?? 1);
      });
      child.on("error", () => {
        closeSync(out);
        resolve(127);
      });
    });
    const result = readResult(probeLog);
    const errored = result && (result.is_error || result.subtype !== "success") ? result : null;
    const verdict = classifyOutcome({ result: errored });
    if (code === 0 && result?.subtype === "success" && !result?.is_error && verdict.kind === "normal") {
      log("usage limit: available again; resuming");
      return { ok: true, ms: Date.now() - started };
    }
    if (verdict.kind === "usage_limit") {
      const resetAt = parseResetTime(verdict.message);
      if (resetAt) {
        const plan = planLimitWait({ resetAt, maxWaitHours: (deadline - Date.now()) / 3_600_000, marginMinutes: limits.limitMarginMinutes });
        if (plan.action === "wait") {
          log(`usage limit: the probe reports a reset at ${resetAt.toISOString()}; waiting until ${plan.resumeAt.toISOString()}`);
          await sleepMs(plan.waitMs);
          return { ok: true, ms: Date.now() - started };
        }
      }
    }
  }
  return { ok: false, ms: Date.now() - started };
}

async function runReview(config, { since, iteration, runId, log }) {
  const base = git(config, ["rev-parse", "HEAD"]).output.trim();
  const reviewLog = path.join(config.root, config.logsDir, `${runId}-review-after-iter-${String(iteration).padStart(2, "0")}.jsonl`);
  writeSession(config, { role: "review", featureId: "REVIEW", iteration, baseSha: base, startedAt: new Date().toISOString(), progressAtStart: readProgress(config), stopAttempts: 0 });
  clearStopFailure(config);
  const date = new Date().toISOString().slice(0, 10);
  const prompt =
    config.review.prompt?.replaceAll("{since}", since).replaceAll("{iteration}", String(iteration)).replaceAll("{date}", date) ??
    `Review session for the autonomous build. Compare everything committed in ${since}..HEAD (git log, git diff) against the project's spec and the contracts of the features built there. Look for drift: required behaviour the code does not do, broken architecture rules, shortcuts that only satisfy the tests, decisions not recorded. Run \`autobuild check --skip-browser\` and include its result. Append each finding as one line to ${config.progressFile}: 'REVIEW ${date}: PROPOSED-FEATURE <title> — <why>' for missing work, or 'BLOCKER <ID>: <why>' only for a pending feature whose test or contract is wrong. If there are no findings, append 'REVIEW ${date}: no drift found'. Do not change code, tests or the feature list. Commit only ${config.progressFile} with message 'chore(review): drift review after ${iteration} iterations'. Then stop.`;
  log(`review: comparing ${since.slice(0, 8)}..${base.slice(0, 8)}`);
  await runClaude(config, {
    role: "review",
    prompt,
    appendSystemPrompt: `No human is present. Never ask questions. You may only write ${config.progressFile}.`,
    maxTurns: config.limits.reviewMaxTurns,
    maxBudgetUsd: config.limits.reviewBudgetUsd,
    allowedTools: config.reviewTools,
    logFile: reviewLog,
  });
  const result = readResult(reviewLog);
  const dirty = git(config, ["status", "--porcelain"]).output.trim();
  if (dirty) log(`review: left uncommitted changes:\n${dirty}`);
  log(`review: done (${result?.subtype ?? "no_result"}, ${result?.num_turns ?? 0} turns); log ${path.relative(config.root, reviewLog)}`);
}
