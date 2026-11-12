import { withTrackedRun, currentRunId } from '../../../../core/skills/run-records/tracking.mjs';
import { autobuildTracking } from '../../../../core/skills/run-records/adapters.mjs';
import { createDecisionTrace } from '../../../../core/skills/decisions/observations.mjs';
import { prepareDecisionGate, decisionRevision, validateDecisionFeature } from './decisions.mjs';
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
//   12 the bug hunt needs a human (findings left open, or it could not run or land)
//   13 the final review ended twice without its commit (the last features are unreviewed)
//   14 a managed decision could not safely release the selected builder
//   15 the provider refused the work (not retried)
//   16 every feature is flagged passing, but the final full gate (with CI parity) failed
//   130 interrupted
//
// Once every feature passes (and the final review ran), lib/bughunt.mjs runs /bughunt --fix over
// the branch and lands its verified fixes before the loop reports done.

import { claudeAgentSettings, readAgentConfig, validateConcurrency } from "../../../../scripts/agent-config.mjs";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, linkSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { statePath } from "./config.mjs";
import { countPassing, featureById, nextFeature, readBlockers, readFeatures, readProgress, writeFeatures, blockedClosure } from "./features.mjs";
import { frozenChanges, gitControlChanges, gitControlDigest, runGate } from "./gate.mjs";
import { huntEnabled, runBughunt, stopHunt } from "./bughunt.mjs";
import { classifyOutcome, parseResetTime, planLimitWait } from "./limits.mjs";
import { buildEnv, evidencePromptLine, sessionConfigEnv, git, sh, quote } from "./proc.mjs";
import { isOurs } from "../../../build/skills/build-app/driver/proc.mjs";
import { clearStopFailure, readStopFailure, writeSession } from "./session.mjs";
import { runCodex, readCodexResult } from "./codex.mjs";
import { checkCodexLaunch } from "./codex-installs.mjs";
import { observeContextLaunch } from './context-receipt.mjs';
import { finishCodexBuilder, finishCodexReview } from "./codex-gate.mjs";
import { runFeatureTests } from "./tests.mjs";
import { countUnreviewed } from "./review-baseline.mjs";

const HOME = path.resolve(import.meta.dirname, "..");
const CLI_FILE = path.join(HOME, "lib", "cli.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REVIEW_COMMIT = "^chore(review):";

// Running claude sessions, so stopping the loop stops them too instead of leaving them orphaned.
const sessions = new Set();
function track(child) {
  sessions.add(child);
  child.once("close", () => sessions.delete(child));
  child.once("error", () => sessions.delete(child));
  return child;
}

/** Ends every running session: SIGTERM, then SIGKILL for any still running after 30 s. */
async function stopSessions() {
  const hunt = stopHunt();
  const closed = [...sessions].map((child) => new Promise((resolve) => {
    child.once("close", resolve);
    child.kill("SIGTERM");
  }));
  await Promise.race([Promise.all(closed), sleep(30_000)]);
  for (const child of sessions) child.kill("SIGKILL");
  await hunt;
}

/** Logs and returns true when a session changed git's control files (hooks, config, info). */
function controlTampered(config, before, who, log) {
  const changed = gitControlChanges(config, before);
  if (changed.length) log(`${who}: GIT CONTROL FILES CHANGED (hooks, config or info under .git) — stopping for a human:\n${changed.join("\n")}`);
  return changed.length > 0;
}

/** The newest commit a review session made on this branch, or null when there is none. */
function lastReviewCommit(config) {
  const found = git(config, ["log", "-1", "--format=%H", `--grep=${REVIEW_COMMIT}`]);
  return found.ok && found.output.trim() ? found.output.trim() : null;
}

/** The commit that added `file`, or null. */
function firstCommitOf(config, file) {
  const found = git(config, ["log", "--diff-filter=A", "--format=%H", "--", file]);
  const oldest = found.ok ? found.output.trim().split("\n").filter(Boolean).pop() : null;
  return oldest || null;
}

/** How many features pass now but did not at `sha`: the work no review has seen yet. */
function passedSince(config, sha) {
  const then = git(config, ["show", `${sha}:${config.featuresFile}`]);
  return countUnreviewed(readFeatures(config).features, then.ok ? then.output : null);
}

function readPid(file) {
  try {
    return Number(readFileSync(file, "utf8").trim());
  } catch {
    return 0;
  }
}

/**
 * Takes the project's loop lock and returns the pid that holds it (this process when taken).
 * - The pid file is linked into place whole (link fails when it exists), so it is never read half written.
 * - A file held by a dead loop, or by a pid reused by another program (a pid counts only while its
 *   command line is this tool's cli.mjs), is moved aside first; if what was moved is not that stale
 *   pid, a rival loop took the lock meanwhile, and its file goes back.
 */
function takeLock(pidFile) {
  const mine = `${pidFile}.${process.pid}`;
  writeFileSync(mine, String(process.pid));
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        linkSync(mine, pidFile);
        return process.pid;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const pid = readPid(pidFile);
      if (pid === process.pid) return pid;
      if (isOurs(pid, CLI_FILE)) return pid;
      const aside = `${pidFile}.stale.${process.pid}`;
      try {
        renameSync(pidFile, aside);
      } catch {
        continue;
      }
      const moved = readPid(aside);
      if (moved !== pid && isOurs(moved, CLI_FILE)) {
        try {
          linkSync(aside, pidFile);
        } catch {
          /* a third loop took it; the next attempt reads that one */
        }
      }
      rmSync(aside, { force: true });
    }
    return readPid(pidFile) || process.pid;
  } finally {
    rmSync(mine, { force: true });
  }
}

export async function runLoop(config, options = {}) {
  return withTrackedRun(autobuildTracking(config, "autobuild"), async () => {
    let decisionTrace;
    try {
      decisionTrace = createDecisionTrace({ repo: realpathSync(config.root), revision: decisionRevision(config), invocationRunId: currentRunId() });
    } catch { /* Observations cannot change queue or work behavior. */ }
    try { return await runLoopWork(config, options, decisionTrace); }
    finally { try { decisionTrace?.close(); } catch { /* Missing closure is incomplete evidence. */ } }
  });
}

async function runLoopWork(config, options, decisionTrace) {
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

  // One loop per project (takeLock). Cleanup removes the pid file only while it is still ours.
  const pidFile = statePath(config, "loop.pid");
  const owner = takeLock(pidFile);
  if (owner !== process.pid) {
    log(`another autobuild loop (pid ${owner}) is running for this project`);
    return 11;
  }
  const cleanup = () => {
    if (readPid(pidFile) === process.pid) rmSync(pidFile, { force: true });
  };
  let interrupted = false;
  let waitingForDecision = false;
  const decisionAbort = new AbortController();
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    decisionAbort.abort();
    if (waitingForDecision) return;
    log("interrupted; stopping the running session");
    stopSessions().finally(() => {
      cleanup();
      process.exit(130);
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    // A previous handoff cannot describe a new attempt or a changed head.
    rmSync(statePath(config, "delivery-status.json"), { force: true });
    const pre = preflight(config, log);
    if (pre !== 0) return pre;
    if (config.deliveryMode === "pr-first") log("PR-FIRST: focused acceptance and commit checks run locally; full regressions, broad review and hunt are deferred to the PR. No merge or review clearance is granted.");
    if (config.backend === "codex") log(`Codex: ${config.model}; subagents ${config.subagentModel}; probes ${config.probeModel}; ${config.codex.sessionTimeoutMinutes} min/session. Dollar/turn caps and Claude tool hooks do not apply; ${config.deliveryMode === "pr-first" ? "focused commit" : "full"} gates run outside the session.`);
    else log(`loop ${runId}: up to ${limits.maxIterations} iterations; ${limits.maxTurns} turns and $${limits.maxBudgetUsd} (estimated) per session; review every ${limits.reviewEvery} features (${limits.reviewMaxTurns} turns, $${limits.reviewBudgetUsd}); model ${config.model} (subagents ${config.subagentModel}${config.subagentModelForce === false ? " by default" : ""})`);

    let iteration = 0;
    let noProgress = 0;
    let totalCost = 0;
    let transientStreak = 0;
    let limitWaitedMs = 0;

    // Reviews start from the last review commit, so neither a failed review nor a restart skips work.
    // With no review yet, the build starts where the feature list was added, so features a run
    // passed before a restart are still reviewed.
    let lastReviewSha = lastReviewCommit(config) ?? firstCommitOf(config, config.featuresFile) ?? git(config, ["rev-parse", "HEAD"]).output.trim();
    let completedSinceReview = passedSince(config, lastReviewSha);
    // `final`: the last features of a run are reviewed even when fewer than reviewEvery passed since the last review.
    // Returns 4 when the review session changed git's control files, else 0.
    const reviewIfDue = async ({ final = false } = {}) => {
      if (config.deliveryMode === "pr-first") return 0;
      if (completedSinceReview === 0) return 0;
      if (!final && completedSinceReview < limits.reviewEvery) return 0;
      const control = gitControlDigest(config);
      const reviewCode = await runReview(config, { since: lastReviewSha, iteration, runId, log });
      if (interrupted) return 0;
      if (controlTampered(config, control, "review", log)) return 4;
      if (reviewCode === 15) return 15;
      const reviewed = lastReviewCommit(config);
      if (reviewed && reviewed !== lastReviewSha) { lastReviewSha = reviewed; completedSinceReview = 0; }
      else log(`review: no chore(review) commit; the next review covers ${lastReviewSha.slice(0, 8)}..HEAD again`);
      return 0;
    };
    if (completedSinceReview > 0) log(`review: ${completedSinceReview} features passed since ${lastReviewSha.slice(0, 8)} without a review`);
    { const code = await reviewIfDue(); if (code !== 0) return code; }

    while (!interrupted && (iteration < limits.maxIterations || (config.deliveryMode === "pr-first" && readFeatures(config).features.every(feature => feature.passes)))) {
      const doc = readFeatures(config);
      const blockers = readBlockers(readProgress(config));
      const feature = nextFeature(doc, blockers);
      if (!feature) {
        if (doc.features.every((candidate) => candidate.passes)) {
          if (config.deliveryMode === "pr-first") {
            const beforeHead = git(config, ["rev-parse", "HEAD"]);
            const beforeDirty = git(config, ["status", "--porcelain"]);
            if (!beforeHead.ok || !beforeDirty.ok || beforeDirty.output.trim()) {
              log("PR handoff pending: commit retained changes before handing off a checked head.");
              return 2;
            }
            const beforeControl = gitControlDigest(config);
            const checked = runGate(config, { phase: "commit", failFast: true });
            if (controlTampered(config, beforeControl, "PR handoff", log)) return 4;
            if (!checked.ok) {
              log(`PR handoff checks failed: ${checked.steps.filter(step => !step.ok).map(step => `${step.name}: ${step.tail}`).join("\n")}`);
              return 2;
            }
            const head = git(config, ["rev-parse", "HEAD"]);
            const dirty = git(config, ["status", "--porcelain"]);
            if (!head.ok || !dirty.ok || dirty.output.trim() || head.output.trim() !== beforeHead.output.trim()) {
              log("PR handoff pending: checks changed the committed head or working tree; retained changes need review.");
              return 2;
            }
            const handoff = { version: 1, status: "ready_for_pr", head: head.output.trim(),
              uncommittedChanges: Boolean(dirty.output.trim()), featuresPassing: doc.features.length,
              fullGate: "pending", review: "pending", hunt: "deferred", mergeReady: false,
              deferred: checked.deferred, createdAt: new Date().toISOString() };
            writeFileSync(statePath(config, "delivery-status.json"), JSON.stringify(handoff, null, 2) + "\n", { mode: 0o600 });
            log(`PR-FIRST: committed head ${handoff.head.slice(0, 8)} is ready for a draft PR; full regressions and broad review remain pending. Not merge-ready.`);
            return 0;
          }
          if (limits.finalReview !== false && completedSinceReview > 0) {
            log(`review: final review, ${completedSinceReview} features passed since ${lastReviewSha.slice(0, 8)} without a review`);
            // A final review that ends without its commit is retried once; twice is a stop, never Done.
            for (let attempt = 1; completedSinceReview > 0; attempt += 1) {
              const before = lastReviewSha;
              { const code = await reviewIfDue({ final: true }); if (code !== 0) return code; }
              if (interrupted) return 130;
              if (lastReviewSha !== before) break;
              completedSinceReview = passedSince(config, lastReviewSha);
              if (attempt === 2) {
                log(`review: the final review ended twice without a chore(review) commit; the last features are unreviewed. Stopping; rerun \`autobuild run\` to retry it.`);
                return 13;
              }
            }
            if (interrupted) return 130;
          }
          if (huntEnabled(config)) {
            const hunted = await runBughunt(config, { log, runId, stopped: () => interrupted });
            if (interrupted) return 130;
            if (hunted !== 0) {
              log(`every feature passes, but the bug hunt needs attention (exit ${hunted}); see the bug hunt lines above and ${config.progressFile}.`);
              return hunted;
            }
          }
          // A session can end on a BLOCKER line after its flag was set, so the flags alone
          // never prove the gate: re-run it, CI parity included, before calling it done.
          if (interrupted) return 130;
          const final = runGate(config, { phase: "full", failFast: true });
          // runGate is synchronous: let a signal that arrived meanwhile reach its handler.
          await new Promise((resolve) => setImmediate(resolve));
          if (interrupted) return 130;
          if (!final.ok) {
            const failed = final.steps.filter((step) => !step.ok);
            log(`every feature is flagged passing, but the final full gate failed (${failed.map((step) => step.name).join(", ")}); not done:\n${failed.map((step) => step.tail).join("\n").slice(-4000)}`);
            return 16;
          }
          log("final full gate: PASS (CI parity included)");
          log("every feature passes. Done.");
          return 0;
        }
        log(`no feature can be built: the rest are blocked or depend on blocked features: ${[...blockedClosure(doc, blockers)].join(", ")}`);
        return 3;
      }

      let decisionGate;
      try {
        waitingForDecision = true;
        decisionGate = await prepareDecisionGate({ config, feature, trace: decisionTrace, signal: decisionAbort.signal });
      } catch (error) {
        log(`decision gate stopped: ${error.code ?? 'IO_ERROR'}`);
        return interrupted ? 130 : 14;
      } finally { waitingForDecision = false; }

      const passingBefore = countPassing(doc);
      const label = `${String(iteration + 1).padStart(2, "0")}-${feature.id}`;
      const iterLog = path.join(logsDir, `${runId}-iter-${label}${limitWaitedMs > 0 || transientStreak > 0 ? `-retry-${Date.now()}` : ""}.jsonl`);
      let exitCode, base, started, control, gateFailure;
      try {
        base = git(config, ["rev-parse", "HEAD"]).output.trim();
        writeSession(config, { role: "builder", featureId: feature.id, iteration: iteration + 1, baseSha: base, startedAt: new Date().toISOString(), progressAtStart: readProgress(config), stopAttempts: 0 });
        clearStopFailure(config);
        log(`iteration ${iteration + 1}: ${feature.id} — ${feature.title} (base ${base.slice(0, 8)}, ${passingBefore} passing)`);
        started = Date.now();
        control = gitControlDigest(config);
        exitCode = await runClaude(config, {
          role: "builder",
          prompt: decisionGate ? config.prompt + decisionGate.context : config.prompt,
          beforeLaunch: decisionGate ? () => {
            try { decisionGate.beforeLaunch(); }
            catch (error) { gateFailure = error; throw error; }
          } : undefined,
          onContextSupplied: decisionGate?.onContextSupplied,
          onContextUncertain: decisionGate?.onContextUncertain,
          appendSystemPrompt: builderSystemPrompt(config, feature, iteration + 1),
          maxTurns: limits.maxTurns,
          maxBudgetUsd: limits.maxBudgetUsd,
          allowedTools: config.allowedTools,
          logFile: iterLog,
        });
      } catch (error) {
        if (error !== gateFailure) throw error;
        log(`decision gate stopped: ${error.code ?? 'IO_ERROR'}`);
        return interrupted ? 130 : 14;
      } finally { decisionGate?.close(); }
      if (interrupted) return 130;
      const elapsed = Math.round((Date.now() - started) / 1000);
      const result = config.backend === "codex" ? readCodexResult(iterLog) : readResult(iterLog);
      totalCost += Number(result?.total_cost_usd ?? 0);

      // Independent verification: never trust the session's own account.
      if (controlTampered(config, control, `iteration ${iteration + 1}`, log)) return 4;
      const frozen = frozenChanges(config, base);
      if (frozen.changed.length > 0) {
        log(`iteration ${iteration + 1}: FROZEN FILES CHANGED — stopping for a human:\n${frozen.changed.join("\n")}`);
        return 4;
      }
      if (config.backend === "codex") {
        const finished = finishCodexBuilder(config, { feature, base, docBefore: doc, exitCode, result, log });
        if (finished === 4) return 4;
      }
      if (classifyOutcome({ result }).kind === 'provider_refusal') {
        log('provider_refusal/nonretryable: Provider declined this work; automatic retry is blocked.');
        return 15;
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
          if (git(config, ["add", config.featuresFile]).ok) git(config, ["commit", "-q", "-m", `chore(autobuild): ${feature.id} test fails after the session; passes reverted`]);
        }
      } else if (blockerNow && !blockers.has(feature.id)) {
        outcome = "BLOCKED";
        git(config, ["add", config.progressFile]);
        if (!git(config, ["diff", "--cached", "--quiet"]).ok) git(config, ["commit", "-q", "-m", `chore(${feature.id}): BLOCKER logged`]);
      }

      // A passes flag without its feat commit is not a pass: left in the tree, nextFeature would skip it.
      if (passes && !committed) {
        const fresh = readFeatures(config);
        featureById(fresh, feature.id).passes = false;
        writeFeatures(config, fresh);
        log(`iteration ${iteration + 1}: ${feature.id} was marked passing but has no feat(${feature.id}) commit; passes reset`);
      }

      const summary = config.backend === "codex" ? `${result?.subtype ?? "no_result"}, ${JSON.stringify(result?.usage ?? {})} tokens, ${elapsed}s` : `${result?.subtype ?? "no_result"}, ${result?.num_turns ?? 0} turns, $${Number(result?.total_cost_usd ?? 0).toFixed(2)} est, ${(result?.permission_denials ?? []).length} permission denials, ${elapsed}s`;

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
            // The cap covers every wait for this feature, so a probe that succeeds while the real
            // session stays limited cannot retry forever.
            const leftHours = limits.maxLimitWaitHours - limitWaitedMs / 3_600_000;
            if (leftHours <= 0) {
              log(`usage limit: ${limits.maxLimitWaitHours} h of waiting spent on ${feature.id}. Stopping; rerun \`autobuild run\` later (finished work is committed).`);
              return 8;
            }
            const waited = await probeUntilAvailable(config, log, limits, sleepMs, leftHours);
            limitWaitedMs += waited.ms;
            if (waited.code === 15) return 15;
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
      { const code = await reviewIfDue(); if (code !== 0) return code; }
    }
    if (interrupted) return 130;
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
  try { if (config.decisions !== undefined) validateDecisionFeature(config, readFeatures(config)); }
  catch {
    log('preflight: invalid decisions featureId or configuration');
    return 5;
  }
  if (readFeatures(config).features.length === 0) {
    log(`preflight: ${config.featuresFile} lists no features; write the feature list and its frozen tests first (the /autobuild skill)`);
    failed = true;
  }
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
  const bin = config.backend === "codex" ? config.codexBin : config.claudeBin;
  const claude = sh(config, `command -v ${quote(bin)}`);
  if (!claude.ok) {
    log(`preflight: ${bin} not found on PATH`);
    failed = true;
  } else if (config.backend === "codex") {
    // Log which Codex runs. Refuse only when it is older than another install on PATH;
    // a lone outdated Codex is logged, not refused.
    const codex = checkCodexLaunch(bin, buildEnv(config).PATH, config.root);
    log(`preflight: ${codex.message}`);
    if (!codex.ok) failed = true;
  }
  for (const check of config.preflight ?? []) {
    const result = sh(config, check.command, { timeoutMs: 120_000 });
    if (!result.ok) {
      log(`preflight: ${check.name} failed${check.hint ? ` (${check.hint})` : ""}`);
      failed = true;
    }
  }
  if (config.evidenceDir) {
    try { mkdirSync(config.evidenceDir, { recursive: true }); } catch (error) {
      log(`preflight: cannot create the evidence directory ${config.evidenceDir}: ${error.code ?? error.message}`);
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
${evidencePromptLine(config)}
When the feature is done: mark it passing (\`autobuild mark-passed ${feature.id}\` or the project's wrapper), append to ${config.progressFile}, commit "feat(${feature.id}): …", then stop. The Stop hook runs ${config.deliveryMode === "pr-first" ? "focused acceptance and commit checks; full regressions and review remain pending for the PR" : "the full gate"}; if it blocks, fix what it reports.${custom}`;
}

/** Settings injected into loop sessions: the hooks the project doesn't own, plus deny rules for frozen paths. */
export function sessionSettings(config) {
  const agents = readAgentConfig();
  const native = claudeAgentSettings(agents);
  const concurrent = String(validateConcurrency(config.maxConcurrentSubagents ?? agents.maxConcurrentSubagents));
  const hook = (file, timeout, extra = {}) => [{ hooks: [{ type: "command", command: `node "${path.join(HOME, "hooks", file)}"`, timeout, ...extra }] }];
  const hooks = { StopFailure: hook("stop-failure.mjs", 30) };
  if (config.hooks === "inject") {
    hooks.PreToolUse = [{ matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash", hooks: [{ type: "command", command: `node "${path.join(HOME, "hooks", "guard.mjs")}"`, timeout: 30, onFailure: "block" }] }];
    hooks.Stop = hook("stop-gate.mjs", 2700);
  }
  // A deny rule cannot carve out an exception, so a frozen dir holding a writable file gets no
  // dir-wide rule; the guard hook still keeps the rest of that dir frozen.
  const writable = config.writable ?? [];
  const deny = config.frozen
    .filter((entry) => !writable.includes(entry))
    .flatMap((entry) => (writable.some((file) => file.startsWith(`${entry}/`)) ? [`Edit(/${entry})`] : [`Edit(/${entry})`, `Edit(/${entry}/**)`]));
  // The subagent model lives here, not in the process env: a user's ~/.claude/settings.json `env`
  // overrides the process env, and these --settings override the user's.
  const env = { ...native.env, CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: concurrent, CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: concurrent, CLAUDE_CODE_SUBAGENT_MODEL: config.subagentModel, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: config.subagentModelForce === false ? "0" : "1", CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: config.subagentModelForce === false ? "" : config.subagentModel };
  // Hooks and mark-passed reload configuration without the original CLI args.
  // Pin the accepted selection in --settings as well as the child process environment.
  Object.assign(env, sessionConfigEnv(config));
  return { ...native, model: config.model ?? native.model, env, hooks, permissions: { deny: [...deny, "Bash(git push)", "Bash(git push *)", "Bash(rm -rf *)", "Bash(curl *)", "Bash(wget *)", "Bash(npx *)"] } };
}

async function runClaude(config, options) {
  if (config.backend === "codex") return runClaudeWork(config, options);
  return withTrackedRun(autobuildTracking(config, "session"), () => runClaudeWork(config, options));
}

async function runClaudeWork(config, { role, prompt, appendSystemPrompt, maxTurns, maxBudgetUsd, allowedTools, logFile, beforeLaunch, onContextSupplied, onContextUncertain }) {
  if (config.backend === "codex") {
    const feedback = statePath(config, "codex-feedback.txt");
    if (role === "builder" && existsSync(feedback)) prompt += `\nPrevious gate feedback:\n${readFileSync(feedback, "utf8")}`;
    return runCodex(config, { role, prompt, appendSystemPrompt, logFile, beforeLaunch, onContextSupplied, onContextUncertain }, track);
  }
  const settingsFile = statePath(config, `session-settings.json`);
  writeFileSync(settingsFile, `${JSON.stringify(sessionSettings(config), null, 2)}\n`);
  const env = buildEnv(config, {
    AUTOBUILD_ACTIVE: "1",
    HARNESS_ACTIVE: "1",
    AUTOBUILD_ROLE: role,
    HARNESS_ROLE: role,
    AUTOBUILD_HOME: HOME,
    ...sessionConfigEnv(config),
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
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
    beforeLaunch?.();
    return await new Promise((resolve) => {
      const child = track(spawn(config.claudeBin, args, { cwd: config.root, env, stdio: ["ignore", out, err] }));
      observeContextLaunch(child, { onContextSupplied, onContextUncertain });
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
async function probeUntilAvailable(config, log, limits, sleepMs, maxWaitHours = limits.maxLimitWaitHours) {
  const started = Date.now();
  const deadline = started + maxWaitHours * 3_600_000;
  while (Date.now() < deadline) {
    log(`usage limit: reset time unknown; probing again in ${limits.probeEveryMinutes} min`);
    await sleepMs(limits.probeEveryMinutes * 60_000);
    const probeLog = statePath(config, "probe.jsonl");
    const env = buildEnv(config, { CLAUDE_CODE_RETRY_WATCHDOG: "0" });
    const code = config.backend === "codex" ? await runCodex(config, { role: "probe", prompt: "Reply OK.", logFile: probeLog }, track) : await new Promise((resolve) => {
      const out = openSync(probeLog, "w");
      const child = track(spawn(config.claudeBin, ["-p", "Reply with OK.", "--model", config.probeModel, "--max-turns", "1", "--tools", "", "--strict-mcp-config", "--output-format", "stream-json", "--verbose"], { cwd: config.root, env, stdio: ["ignore", out, out] }));
      child.on("close", (exitCode) => {
        closeSync(out);
        resolve(exitCode ?? 1);
      });
      child.on("error", () => {
        closeSync(out);
        resolve(127);
      });
    });
    const result = config.backend === "codex" ? readCodexResult(probeLog) : readResult(probeLog);
    const errored = result && (result.is_error || result.subtype !== "success") ? result : null;
    const verdict = classifyOutcome({ result: errored });
    if (verdict.kind === 'provider_refusal') {
      log('provider_refusal/nonretryable: Provider declined this work; automatic retry is blocked.');
      return { ok: false, code: 15, ms: Date.now() - started };
    }
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
    `Review session for the autonomous build. Review everything committed in ${since}..HEAD (git log, git diff) in two passes. ` +
    `(1) Drift: compare it against the project's spec and the contracts of the features built there: required behaviour the code does not do, broken architecture rules, shortcuts that only satisfy the tests, decisions not recorded. ` +
    `(2) Defects: read the changed code as a hostile reviewer and look for real bugs the frozen tests would not catch, including bugs the contract itself allows: concurrent writers and races, a crash or restart part-way (what state is left behind and whether it recovers), retries and idempotency, errors swallowed or turned into a false success, partial writes, stale or contradictory state shown to a person, authorization and tenant isolation, unvalidated input. ` +
    `Report a defect only with a concrete failure scenario and file:line, and say when it is reasoned from the code rather than reproduced. Run \`autobuild check --skip-browser\` and include its result. ` +
    `Append each finding as one line to ${config.progressFile}: 'REVIEW ${date}: DEFECT <file:line> <title> — <scenario; suggested fix>' for a bug in built code, 'REVIEW ${date}: PROPOSED-FEATURE <title> — <why>' for missing work, or 'BLOCKER <ID>: <why>' only for a pending feature whose test or contract is wrong. ` +
    `If there are no findings, append 'REVIEW ${date}: no drift or defects found'. Do not change code, tests or the feature list. Commit only ${config.progressFile} with message 'chore(review): drift review after ${iteration} iterations'. Then stop.`;
  log(`review: comparing ${since.slice(0, 8)}..${base.slice(0, 8)}`);
  const exitCode = await runClaude(config, {
    role: "review",
    prompt,
    appendSystemPrompt: `No human is present. Never ask questions. You may only write ${config.progressFile}.`,
    maxTurns: config.limits.reviewMaxTurns,
    maxBudgetUsd: config.limits.reviewBudgetUsd,
    allowedTools: config.reviewTools,
    logFile: reviewLog,
  });
  const result = config.backend === "codex" ? readCodexResult(reviewLog) : readResult(reviewLog);
  if (config.backend === "codex") finishCodexReview(config, { base, exitCode, result, log });
  if (classifyOutcome({ result }).kind === 'provider_refusal') {
    log('review: provider_refusal/nonretryable; Provider declined this work; automatic retry is blocked.');
    return 15;
  }
  const dirty = git(config, ["status", "--porcelain"]).output.trim();
  if (dirty) log(`review: left uncommitted changes:\n${dirty}`);
  log(`review: done (${result?.subtype ?? "no_result"}, ${result?.num_turns ?? 0} turns); log ${path.relative(config.root, reviewLog)}`);
}
