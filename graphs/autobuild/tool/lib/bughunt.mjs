// The bug hunt at the end of an autobuild run: `/bughunt --fix` over the build branch (what a
// pull request from it would merge), in its own headless session, with the fixes landed on the
// branch only through the hunt's landing checks (graphs/hunt/skills/bughunt/land.mjs), the same
// ones /build-app uses:
//   - every commit is a `bughunt: fix F<n>` the hunt's ledger calls verified;
//   - no file that already existed under a frozen path changed (new regression tests may be added);
//   - the fix worktree is clean;
//   - `autobuild check` passes on the fixes before the branch fast-forwards.
// The session runs with /build-app's session settings (its guard opens only the hunt's state dir
// in .git), never with the loop's review settings, which forbid the Workflow tool.
// Off with `"bughunt": false` in autobuild.json or AUTOBUILD_BUGHUNT=0.
import { appendFileSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prepareHunt, readHunt, landHunt, keepAttempt, bughuntPrompt, bughuntLine, residualDisposition } from "../../../hunt/skills/bughunt/land.mjs";
import { sessionSettings, sliceArgs, runClaude, sessionVerdict, stopSessions, NO_BG_CEILING } from "../../../build/skills/build-app/driver/session.mjs";
import { defaultBase } from "../../../build/skills/build-app/driver/finish.mjs";
import { statePath } from "./config.mjs";
import { buildEnv, git, quote } from "./proc.mjs";

/** Exit code when the bug hunt needs a human: findings left open, or the hunt could not run or land. */
export const HUNT_EXIT = 12;

const HUNT_HOOKS = path.resolve(import.meta.dirname, "..", "..", "..", "build", "skills", "build-app", "driver", "hooks");
const CLI = path.resolve(import.meta.dirname, "cli.mjs");
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || "", ".claude");

export function huntEnabled(config, env = process.env) {
  return config.bughunt !== false && env.AUTOBUILD_BUGHUNT !== "0";
}

// The landing in progress, if any. It checks a branch out detached and restores the build branch
// when it ends, so a stop waits for it (it ends its verify early once stopped() is true).
let landing = null;

/** Ends a running hunt session and waits for a landing in progress to clean up (the loop's stop calls this). */
export const stopHunt = () => Promise.all([stopSessions(), landing ?? Promise.resolve()]);

/** Every tracked file under a frozen path, except the writable ones: what the fixes may not change. */
export function frozenFiles(config) {
  const paths = config.frozen.filter((entry) => !(config.writable ?? []).includes(entry));
  if (!paths.length) return [];
  return git(config, ["ls-files", "--", ...paths]).output.split("\n").map((line) => line.trim()).filter(Boolean);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Runs the hunt once per head and returns an exit code: 0 when it passed (or had nothing to
 * review), HUNT_EXIT when it needs a human, 8/9/10 when the API stopped it, 130 when stopped.
 */
export async function runBughunt(config, { log, runId, stopped = () => false }) {
  const repo = realpathSync(config.root);
  const record = statePath(config, "bughunt.json");
  const target = git(config, ["rev-parse", "--abbrev-ref", "HEAD"]).output.trim();
  const head0 = git(config, ["rev-parse", "HEAD"]).output.trim();
  const previous = readJson(record);
  if (previous && previous.head === head0 && Number.isInteger(previous.code)) {
    log(`bug hunt: already ran at ${head0.slice(0, 8)} (${previous.disposition ?? "skipped"}); not repeated`);
    return previous.code;
  }
  if (target === "HEAD") {
    log("bug hunt: HEAD is detached; check out the build branch and rerun");
    return HUNT_EXIT;
  }
  const dirty = git(config, ["status", "--porcelain"]).output.trim();
  if (dirty) {
    log(`bug hunt: not run, the tree has uncommitted changes (commit or remove them, then rerun):\n${dirty.split("\n").slice(0, 20).join("\n")}`);
    return HUNT_EXIT;
  }
  const base = config.bughuntBase || defaultBase(repo);
  const resolves = (ref) => git(config, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).ok;
  if (!resolves(base) && !resolves(`origin/${base}`)) {
    log(`bug hunt: no base branch ${base} to compare ${target} against; set "bughuntBase" in autobuild.json (the branch a PR would merge into), or "bughunt": false`);
    return HUNT_EXIT;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const prep = prepareHunt({ repo, target, base, stamp, log });
  if (prep.skip) {
    log(`bug hunt: nothing to review (${prep.skip})`);
    writeFileSync(record, `${JSON.stringify({ head: head0, code: 0, disposition: null })}\n`);
    return 0;
  }
  if (prep.error) {
    log(`bug hunt: could not start (${prep.error}${prep.detail ? `: ${prep.detail}` : ""}${prep.branch ? ` on ${prep.branch}` : ""})`);
    return HUNT_EXIT;
  }

  const frozen = frozenFiles(config);
  const guardFile = statePath(config, "hunt-guard.json");
  const settingsFile = statePath(config, "hunt-settings.json");
  const stopFailure = statePath(config, "hunt-stop-failure.json");
  writeFileSync(guardFile, `${JSON.stringify({ repo, frozen, writable: [], writableDirs: [prep.stateDir] }, null, 2)}\n`);
  writeFileSync(settingsFile, `${JSON.stringify(sessionSettings(HUNT_HOOKS), null, 2)}\n`);
  rmSync(stopFailure, { force: true });
  const logFile = path.join(config.root, config.logsDir, `${runId}-bughunt.jsonl`);
  const prompt = bughuntPrompt({ repo, stateDir: prep.stateDir, configDir: CONFIG_DIR, branch: prep.branch, label: "an autobuild run", scope: `the branch ${target}` });
  log(`bug hunt: /bughunt --fix over ${target} against ${base} (state ${prep.stateDir}; up to $${config.limits.bughuntBudgetUsd})`);
  const code = await runClaude({
    bin: config.claudeBin,
    repo,
    logFile,
    timeoutMs: config.limits.bughuntTimeoutMinutes * 60_000,
    args: [...sliceArgs({ prompt, model: config.model, settingsFile }), "--max-budget-usd", String(config.limits.bughuntBudgetUsd)],
    env: buildEnv(config, { ...NO_BG_CEILING, HARNESS_BUILD_ACTIVE: "1", HARNESS_BUILD_GUARD: guardFile, HARNESS_BUILD_STOP_FAILURE: stopFailure }),
  });
  const keep = (why) => `${why}; its branch is kept as ${keepAttempt(repo, prep.branch, stamp)}`;
  if (stopped()) {
    log(keep("bug hunt: stopped by request"));
    return 130;
  }

  const { ledger, lastRun, finished } = readHunt({ stateDir: prep.stateDir, key: prep.key, head: prep.head });
  if (!finished) {
    const verdict = sessionVerdict(logFile, stopFailure);
    const byKind = { usage_limit: 8, billing: 9, auth: 10 };
    log(keep(`bug hunt: did not finish (exit ${code}${lastRun ? `; its last run: ${lastRun.status}${lastRun.reason ? `: ${lastRun.reason}` : ""}` : "; it saved no run"}${verdict.message ? `, ${verdict.message}` : ""}); rerun \`autobuild run\` to retry it`));
    return byKind[verdict.kind] ?? HUNT_EXIT;
  }

  // Passes only on the gate's own last line, never on an exit code alone: a CLI that ran nothing exits 0 too.
  const verifyCommand = `${quote(process.execPath)} ${quote(CLI)} check --base HEAD | awk '{ print } END { if ($0 == "GATE: PASS") print "VERIFY: PASS" }'`;
  landing = landHunt({ repo, integration: target, prep, frozen, verifyCommand, ledger, stopped }).finally(() => {
    landing = null;
  });
  const landed = await landing;
  if (landed.stopped) {
    log(keep("bug hunt: stopped by request during its checks"));
    return 130;
  }
  if (landed.problems) {
    log(keep(`bug hunt: its fixes did not pass the checks, nothing landed: ${landed.problems.join("; ")}`));
    return HUNT_EXIT;
  }
  if (landed.ffFailed) {
    log(keep(`bug hunt: its fixes could not be fast-forwarded onto ${target}`));
    return HUNT_EXIT;
  }

  const result = residualDisposition(ledger);
  const fixed = ledger.findings.filter((f) => !f.stale && f.fix_status === "verified").map((f) => f.finding_id);
  const open = ledger.findings.filter((f) => !f.stale && ["reproduced", "confirmed"].includes(f.verification_status) && f.fix_status !== "verified").map((f) => f.finding_id);
  const date = new Date().toISOString().slice(0, 10);
  const entry = `BUGHUNT ${date}: ${result.disposition}; fixed ${fixed.length ? fixed.join(", ") : "none"}; open ${open.length ? open.join(", ") : "none"}${result.because.length ? ` (${result.because.join(", ")})` : ""}; report ${path.join(prep.stateDir, "report.md")}`;
  appendFileSync(path.join(config.root, config.progressFile), `\n${entry}\n`);
  git(config, ["add", config.progressFile]);
  git(config, ["commit", "-q", "-m", `chore(bughunt): ${result.disposition}`]);
  const exit = result.disposition === "pass" ? 0 : HUNT_EXIT;
  writeFileSync(record, `${JSON.stringify({ head: git(config, ["rev-parse", "HEAD"]).output.trim(), code: exit, disposition: result.disposition })}\n`);
  log(`bug hunt: ${landed.commits} verified fix(es) landed on ${target}; ${result.disposition}\n${bughuntLine(ledger, landed.commits > 0)}`);
  return exit;
}
