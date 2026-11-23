// `autobuild ci <subcommand>`: the ci-optimizer's command line (spec/contracts/ci-optimizer-priority.md,
// "Output" and "Exit codes"). Human lines by default; with --json exactly one JSON document on
// stdout. Errors go to stderr as `autobuild ci: <CODE>: <message>` (and, under --json, also to
// stdout as {"error","message"}). Exit 0 success, 1 a failed check, 2 usage, 3 state or I/O.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE, findProjectRoot } from "../config.mjs";
import { SAFE_GIT } from "../proc.mjs";
import { analyze } from "./analyze.mjs";
import { captureBaseline, compareBaselines, detectRegression, isBaselineDocument, regressionLines, sec, signed } from "./baseline.mjs";
import { applyShardWeights, configIsCommitted, describeChange, measuredSeconds, planShardWeights, shardCountFromProfile } from "./apply.mjs";
import { loadProfile, projectConfig } from "./discover.mjs";
import { readTimings, TIMINGS_FILE } from "../gate-timings.mjs";
import { attemptKey, fetchGithubHistory, githubRepo, importedAttempts, isGithubRepo, mergeHistory, readHistory, writeHistory } from "./history.mjs";
import { computeMetrics, gateMetrics, noHistoryMetrics } from "./metrics.mjs";
import { sortedUnique, wholeNumberOf } from "./patterns.mjs";
import { ciPolicy } from "./policy.mjs";
import { buildReport, checkReportOut, renderReport, writeReportOut } from "./report.mjs";
import { CiError, readState, STATE_SCHEMA_VERSION, writeState } from "./state.mjs";
import { currentTriggers } from "./triggers.mjs";
import { changedFiles, planValidation, recordValidation, resolveBase, TIERS, treeState } from "./validate.mjs";
import { gateStepLines, runGate } from "../gate.mjs";

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

// ---------- ci history (spec/contracts/ci-optimizer-co-03.md) ----------

/** The --limit value, or the policy's historyLimit; a whole number from 1 to 100. */
function historyLimit(values, policy) {
  if (!values.has("--limit")) return policy.historyLimit;
  const text = values.get("--limit");
  const limit = wholeNumberOf(text);
  if (limit === null || limit < 1 || limit > 100) throw usageError(`--limit must be a whole number from 1 to 100, got ${JSON.stringify(text)}`);
  return limit;
}

/** The --repo value (owner/name), else the origin remote's GitHub repository, else REPO_UNKNOWN (exit 2). */
function historyRepo(values, root, env) {
  if (values.has("--repo")) {
    const repo = values.get("--repo");
    if (!isGithubRepo(repo)) throw usageError(`--repo must be owner/name, got ${JSON.stringify(repo)}`);
    return repo;
  }
  const repo = githubRepo(root, env);
  if (!repo) throw new CiError("REPO_UNKNOWN", "no --repo given and the origin remote is not a GitHub repository", 2);
  return repo;
}

/** The attempts of an import file (as given, resolved against cwd); unreadable or invalid is IMPORT_INVALID (exit 2). */
function readImport(given, cwd) {
  let text;
  try {
    text = readFileSync(path.resolve(cwd, given), "utf8");
  } catch (error) {
    throw new CiError("IMPORT_INVALID", `cannot read ${given}: ${error.code ?? error.message}`, 2);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    // The parser's message quotes the file's text; the error names only the file.
    throw new CiError("IMPORT_INVALID", `${given} is not valid JSON`, 2);
  }
  return importedAttempts(doc);
}

/** Merges `incoming` into the stored history, writes it, and reports the totals. */
function storeHistory({ root, env, json }, existing, incoming, source, label) {
  const before = existing?.attempts ?? [];
  const known = new Set(before.map(attemptKey));
  const attempts = mergeHistory(before, incoming);
  // New means stored now and absent before: a record the cap dropped is not counted.
  const added = attempts.filter((attempt) => !known.has(attemptKey(attempt))).length;
  writeHistory(root, { source, attempts }, env);
  if (json) return { code: 0, json: { total: attempts.length, new: added, source, attempts } };
  return { code: 0, lines: [`history: ${attempts.length} attempts (${added} new) from ${label}`] };
}

async function history(context) {
  const { root, cwd, flags, values, env, json } = context;
  const fromGh = flags.has("--from-gh");
  if (fromGh && values.has("--import")) throw usageError("--from-gh and --import cannot be combined");
  if (!fromGh && (values.has("--repo") || values.has("--limit"))) throw usageError("--repo and --limit need --from-gh");

  if (fromGh) {
    const policy = ciPolicy(projectConfig(root, env));
    const limit = historyLimit(values, policy);
    const repo = historyRepo(values, root, env);
    const existing = readHistory(root, env);   // a refused state dir fails here, before any gh call
    const incoming = fetchGithubHistory({ repo, ghBin: env.AUTOBUILD_GH_BIN || policy.ghBin, limit, env });
    return storeHistory(context, existing, incoming, { provider: "github", repo }, `github ${repo}`);
  }
  if (values.has("--import")) {
    const given = values.get("--import");
    const incoming = readImport(given, cwd);
    const existing = readHistory(root, env);
    return storeHistory(context, existing, incoming, { provider: "import", file: path.basename(given) }, `import ${given}`);
  }

  const stored = readHistory(root, env);
  const attempts = stored?.attempts ?? [];
  if (json) return { code: 0, json: { total: attempts.length, new: 0, source: stored?.source ?? null, attempts } };
  return { code: 0, lines: [stored ? `history: ${attempts.length} attempts stored` : "history: none"] };
}

// ---------- ci metrics (spec/contracts/ci-optimizer-co-04.md) ----------

/** The --window value, or null (every attempt); a whole number of at least 1. */
function metricsWindow(values) {
  if (!values.has("--window")) return null;
  const text = values.get("--window");
  const window = wholeNumberOf(text);
  if (window === null || window < 1) throw usageError(`--window must be a whole number of at least 1, got ${JSON.stringify(text)}`);
  return window;
}

/** The project's gate timings; an unreadable file is TIMINGS_UNREADABLE (exit 3). */
function gateRecords(config) {
  try {
    return readTimings(config);
  } catch (error) {
    throw new CiError("TIMINGS_UNREADABLE", `cannot read ${path.join(config.logsDir, TIMINGS_FILE)}: ${error.code ?? error.message}`);
  }
}

const figure = (value) => (value === null ? "unknown" : String(value));

function metricsLines(doc, workflowName) {
  if (!doc.workflows.length) return [workflowName === null ? "metrics: the stored history has no attempts" : `metrics: no attempts for workflow ${JSON.stringify(workflowName)}`];
  const lines = [];
  for (const w of doc.workflows) {
    const chain = w.criticalPathJobs.length ? w.criticalPathJobs.join(" → ") : "none";
    lines.push(`workflow ${w.workflow}: ${w.runs} runs, wall p50 ${sec(w.wallSeconds.p50)} p90 ${sec(w.wallSeconds.p90)}, queue p50 ${sec(w.queueSeconds.p50)}, critical path p50 ${sec(w.criticalPathSeconds.p50)} (${chain}), efficiency ${figure(w.parallelEfficiency.p50)}, runner minutes ${w.runnerMinutes.total}, flake rate ${figure(w.reliability.flakeRate)}`);
    // Only these step lines are indented.
    for (const s of w.steps.slice(0, 5)) lines.push(`  ${s.job} / ${s.step}: p50 ${s.seconds.p50}s p90 ${s.seconds.p90}s (${s.samples})`);
  }
  if (doc.gate) lines.push(`gate: ${doc.gate.runs} full runs, wall p50 ${sec(doc.gate.wallSeconds.p50)} p90 ${sec(doc.gate.wallSeconds.p90)}, cache hit rate ${figure(doc.gate.cacheHitRate)}`);
  lines.push(`unknowns: ${listOrNone(doc.unknowns)}`);
  return lines;
}

async function metrics({ root, values, env, json }) {
  const window = metricsWindow(values);
  const config = projectConfig(root, env);
  const stored = readHistory(root, env);
  if (!stored) throw new CiError("NO_HISTORY", "no stored CI history; run `autobuild ci history --from-gh` or `--import FILE` first", 2);
  const workflowName = values.has("--workflow") ? values.get("--workflow") : null;
  const attempts = workflowName === null ? stored.attempts : stored.attempts.filter((attempt) => attempt.workflow === workflowName);
  const doc = computeMetrics(attempts, { rates: ciPolicy(config).ratesPerMinute, window });
  doc.gate = config ? gateMetrics(gateRecords(config)) : null;
  if (json) return { code: 0, json: doc };
  return { code: 0, lines: metricsLines(doc, workflowName) };
}

// ---------- ci apply (spec/contracts/ci-optimizer-co-05.md) ----------

/** The --shards value (a whole number of at least 2), else null; anything else is a usage error. */
function shardsFlag(values) {
  if (!values.has("--shards")) return null;
  const text = values.get("--shards");
  const count = wholeNumberOf(text);
  if (count === null || count < 2) throw usageError(`--shards must be a whole number of at least 2, got ${JSON.stringify(text)}`);
  return count;
}

/** --shards, else the CO-01 profile's sharded test matrix, else SHARD_COUNT_UNKNOWN (exit 2). */
async function applyShardCount(root, env, config, given) {
  if (given !== null) return given;
  const { profile } = await loadProfile(root, { env, config });
  const count = shardCountFromProfile(profile);
  if (count === null) throw new CiError("SHARD_COUNT_UNKNOWN", "no workflow job runs tests with --shard over a matrix; pass --shards N", 2);
  return count;
}

function applyLines(plan, verdict) {
  return [
    `shards: ${plan.shardCount}`,
    `slowest shard before: ${plan.before.maxShardSeconds}s, after: ${plan.after.maxShardSeconds}s (computed from measured durations)`,
    ...plan.changes.map((change) => `  ${describeChange(change)}`),
    `unmeasured: ${listOrNone(plan.unmeasured)}`,
    ...verdict,
  ];
}

const APPLY_OUTCOMES = {
  "dry-run": { code: 0, lines: ["apply: dry run (nothing written)"] },
  "no-improvement": { code: 1, lines: ["apply: refused (the slowest shard would not get faster)"] },
  dirty: { code: 1, lines: ["apply: refused (autobuild.json has uncommitted changes)"] },
};

async function apply({ root, flags, values, env, json }) {
  const given = shardsFlag(values);
  const config = projectConfig(root, env);
  if (!config) throw new CiError("NO_AUTOBUILD_CONFIG", `ci apply needs ${CONFIG_FILE} in the project root`, 2);
  const shardCount = await applyShardCount(root, env, config, given);
  const records = gateRecords(config);
  // gateMetrics owns the "full-phase gate record" rule; it is null when there is none.
  if (gateMetrics(records) === null) {
    throw new CiError("NO_TIMINGS", `no full-phase gate runs in ${path.join(config.logsDir, TIMINGS_FILE)}; run \`autobuild check\` first`, 2);
  }
  const plan = planShardWeights(config.gate, measuredSeconds(records), shardCount);
  // Precedence: a dry run never writes; then no improvement; then an uncommitted autobuild.json.
  let reason = null;
  if (flags.has("--dry-run")) reason = "dry-run";
  else if (!plan.improves) reason = "no-improvement";
  else if (!configIsCommitted(root, env)) reason = "dirty";
  if (reason === null) applyShardWeights(root, plan);
  const outcome = reason === null ? { code: 0, lines: ["apply: wrote autobuild.json", "revert: git checkout -- autobuild.json"] } : APPLY_OUTCOMES[reason];
  if (json) return { code: outcome.code, json: { plan, applied: reason === null, reason } };
  return { code: outcome.code, lines: applyLines(plan, outcome.lines) };
}

// ---------- ci analyze (spec/contracts/ci-optimizer-co-06.md) ----------

/** CO-04 metrics over each workflow's newest `baselineRuns` stored attempts, or the no-history document. */
function analysisMetrics(root, env, policy) {
  const stored = readHistory(root, env);
  if (!stored) return noHistoryMetrics();
  return computeMetrics(stored.attempts, { rates: policy.ratesPerMinute, window: policy.baselineRuns });
}

/** `{ plan }` from CO-05, or null: it needs autobuild.json and a shard count from the profile; only then are timings read. */
function analysisGate(config, profile) {
  const shardCount = config ? shardCountFromProfile(profile) : null;
  if (shardCount === null) return null;
  return { plan: planShardWeights(config.gate, measuredSeconds(gateRecords(config)), shardCount) };
}

function findingLine(f) {
  return `[${f.risk}/${f.action}] ${f.rule} ${f.target}${f.job === null ? "" : `#${f.job}`}: ${f.summary}`;
}

/** The profile, the analysis metrics and the findings `ci analyze` reports; `ci report` builds on the same inputs. */
async function analysisInputs(root, env, config, policy) {
  const { profile } = await loadProfile(root, { env, config });
  const metricsDoc = analysisMetrics(root, env, policy);
  const findings = analyze({ profile, metrics: metricsDoc, gate: analysisGate(config, profile), config, policy });
  return { profile, metrics: metricsDoc, findings };
}

async function analyzeRepo({ root, env, json }) {
  const config = projectConfig(root, env);
  const { profile, metrics: metricsDoc, findings } = await analysisInputs(root, env, config, ciPolicy(config));
  const unknowns = sortedUnique([...profile.unknowns, ...metricsDoc.unknowns]);
  // A finding is not a failed check: analyze exits 0 whatever it finds.
  if (json) return { code: 0, json: { findings, unknowns } };
  const toApply = findings.filter((f) => f.action === "apply").length;
  return { code: 0, lines: [...findings.map(findingLine), `findings: ${findings.length} (${toApply} to apply, ${findings.length - toApply} to propose)`] };
}

// ---------- ci validate (spec/contracts/ci-optimizer-co-07.md) ----------

function validateTier(values) {
  const tier = values.has("--tier") ? values.get("--tier") : "fast";
  if (!TIERS.includes(tier)) throw usageError(`--tier must be fast or full, got ${JSON.stringify(tier)}`);
  return tier;
}

function validationHeader(plan, base, changed) {
  if (plan.tier === "fast") return `validation tier: fast (affected; base ${base.ref} ${base.sha.slice(0, 12)}; ${changed.length} files changed)`;
  return plan.escalated ? `validation tier: full (escalated: ${plan.reasons.join(", ")})` : "validation tier: full (requested)";
}

function validationVerdict(plan, ok) {
  if (!ok) return "VALIDATION: FAIL";
  return plan.tier === "fast" ? "VALIDATION: PASS (fast tier, not merge validation)" : "VALIDATION: PASS (full gate)";
}

async function validate({ root, flags, values, env, json }) {
  const tier = validateTier(values);
  const config = projectConfig(root, env);
  if (!config) throw new CiError("NO_AUTOBUILD_CONFIG", `ci validate needs ${CONFIG_FILE} in the project root`, 2);
  // An explicit --base that does not resolve is NO_BASE (an escalation), not a usage error.
  const base = resolveBase(config, values.has("--base") ? values.get("--base") : null);
  // Without a base, or when git cannot list the change, `changed` is null: planValidation's NO_BASE.
  const changed = tier === "fast" && base ? changedFiles(config, base.sha) : null;
  const plan = planValidation({ config, root, changed, tier });
  // A refused state directory or file fails here, before the gate spends its time.
  readState(root, "validation", env);
  // The tree as validated: read before the gate's steps run.
  const tree = treeState(config);
  const failFast = flags.has("--fail-fast");
  const gate = plan.tier === "fast"
    ? runGate(config, { phase: "full", scope: "affected", affectedBase: base.sha, caller: "ci-validate", ciParity: false, failFast })
    : runGate(config, { phase: "full", caller: "ci-validate", failFast });
  recordValidation(root, { schemaVersion: STATE_SCHEMA_VERSION, head: tree.head, dirty: tree.dirty, tier: plan.tier, ok: gate.ok, at: new Date().toISOString(), base: base?.sha ?? null, reasons: plan.reasons }, env);
  const code = gate.ok ? 0 : 1;
  if (json) return { code, json: { plan, gate, ok: gate.ok } };
  return { code, lines: [validationHeader(plan, base, changed), ...gateStepLines(gate), validationVerdict(plan, gate.ok)] };
}

// ---------- ci baseline and ci compare (spec/contracts/ci-optimizer-co-08.md) ----------

/** HEAD's sha in `root`, or null in a repository without commits. */
function headSha(root, env) {
  const result = spawnSync("git", [...SAFE_GIT, "rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root, env, encoding: "utf8" });
  const sha = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

async function captureCurrentBaseline({ root, env, json }) {
  const config = projectConfig(root, env);
  const stored = readHistory(root, env);
  // Checked before discovery, so a refused capture writes nothing.
  if (!stored) throw new CiError("NO_HISTORY", "no stored CI history; run `autobuild ci history --from-gh` or `--import FILE` first", 2);
  const { profile } = await loadProfile(root, { env, config });
  const head = headSha(root, env);
  const doc = captureBaseline({
    attempts: stored.attempts,
    profile,
    timings: config ? gateRecords(config) : [],
    policy: ciPolicy(config),
    head,
    at: new Date().toISOString(),
  });
  writeState(root, "baseline", doc, env);
  if (json) return { code: 0, json: doc };
  return { code: 0, lines: [`baseline: captured at ${head === null ? "no commit" : head.slice(0, 12)}, ${doc.workflows.length} workflows`] };
}

async function baseline(context) {
  const { root, flags, env, json } = context;
  if (flags.has("--capture")) {
    if (flags.has("--fail-on-regression")) throw usageError("--fail-on-regression cannot be combined with --capture");
    return captureCurrentBaseline(context);
  }
  const stored = readState(root, "baseline", env);
  if (!isBaselineDocument(stored)) throw new CiError("NO_BASELINE", "no stored baseline; run `autobuild ci baseline --capture` first", 2);
  const policy = ciPolicy(projectConfig(root, env));
  const attempts = readHistory(root, env)?.attempts ?? [];
  const regression = detectRegression({ baseline: stored, attempts, policy });
  const code = flags.has("--fail-on-regression") && regression.regressed ? 1 : 0;
  if (json) return { code, json: { baseline: stored, regression } };
  return { code, lines: regressionLines(regression) };
}

/** The baseline document in `given` (resolved against cwd); missing, unreadable or invalid is BASELINE_INVALID (exit 2). */
function readBaselineFile(given, cwd) {
  let text;
  try {
    text = readFileSync(path.resolve(cwd, given), "utf8");
  } catch (error) {
    throw new CiError("BASELINE_INVALID", `cannot read ${given}: ${error.code ?? error.message}`, 2);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    // The parser's message quotes the file's text; the error names only the file.
    throw new CiError("BASELINE_INVALID", `${given} is not valid JSON`, 2);
  }
  if (!isBaselineDocument(doc)) throw new CiError("BASELINE_INVALID", `${given} is not a baseline document`, 2);
  return doc;
}

function compareLines(result) {
  const lines = result.workflows.map((w) => `${w.workflow}: before p50 ${sec(w.before)}, after p50 ${sec(w.after)} (${signed(w.deltaSeconds, "s")}, ${signed(w.deltaPercent, "%")})`);
  const removed = Object.values(result.removed).flat();
  const added = Object.values(result.added).flat();
  if (added.length) lines.push(`added: ${added.join(", ")}`);
  lines.push(result.preserved ? "checks preserved: yes" : `checks preserved: NO (${removed.join(", ")})`);
  return lines;
}

async function compare({ cwd, values, json }) {
  for (const flag of ["--before", "--after"]) {
    if (!values.has(flag)) throw usageError(`ci compare needs ${flag} FILE`);
  }
  const result = compareBaselines(readBaselineFile(values.get("--before"), cwd), readBaselineFile(values.get("--after"), cwd));
  const code = result.preserved ? 0 : 1;
  if (json) return { code, json: result };
  return { code, lines: compareLines(result) };
}

// ---------- ci triggers (spec/contracts/ci-optimizer-co-09.md) ----------

/** Evaluates the lifecycle triggers offline; writes nothing and exits 0 whether or not one fires. */
async function triggers({ root, flags, env, json }) {
  const policy = ciPolicy(projectConfig(root, env));
  const { fire, triggers: fired, currentDigest } = await currentTriggers(root, { policy, env, explicit: flags.has("--explicit") });
  if (json) return { code: 0, json: { fire, triggers: fired, currentDigest } };
  if (!fire) return { code: 0, lines: ["ci-optimizer: no trigger"] };
  return { code: 0, lines: [`ci-optimizer: evaluate (${fired.map((t) => `${t.id}: ${t.detail}`).join("; ")})`] };
}

// ---------- ci report (spec/contracts/ci-optimizer-co-10.md) ----------

/** The stored baseline when baseline.json holds a valid one, and its regression over the stored history; else nulls. */
function storedRegression(root, env, policy) {
  const stored = readState(root, "baseline", env);
  if (!isBaselineDocument(stored)) return { baseline: null, regression: null };
  const attempts = readHistory(root, env)?.attempts ?? [];
  return { baseline: stored, regression: detectRegression({ baseline: stored, attempts, policy }) };
}

/** The report over everything stored for the repository; needs no history. Writes only the profile, and FILE with --out. */
async function reportRepo({ root, cwd, values, env, json }) {
  const given = values.has("--out") ? values.get("--out") : null;
  // A refused --out fails before anything is gathered or written.
  const outFile = given === null ? null : checkReportOut(given, { cwd, root, env });
  const config = projectConfig(root, env);
  const policy = ciPolicy(config);
  // Evaluated before analysisInputs stores the profile, so onboarding and ci-config-changed can still show.
  const { fire, triggers: fired } = await currentTriggers(root, { policy, env });
  const { profile, metrics: metricsDoc, findings } = await analysisInputs(root, env, config, policy);
  const { baseline: baselineDoc, regression } = storedRegression(root, env, policy);
  const doc = buildReport({
    profile,
    metrics: { ...metricsDoc, gate: config ? gateMetrics(gateRecords(config)) : null },
    findings,
    baseline: baselineDoc,
    regression,
    triggers: { fire, triggers: fired },
    validation: readState(root, "validation", env),
    generatedAt: new Date().toISOString(),
  });
  const markdown = json ? null : renderReport(doc);
  if (outFile === null) return json ? { code: 0, json: doc } : { code: 0, lines: [markdown.trimEnd()] };
  writeReportOut(outFile, json ? `${JSON.stringify(doc, null, 2)}\n` : markdown, given);
  return json ? { code: 0, json: { wrote: given } } : { code: 0, lines: [`report: wrote ${given}`] };
}

// `flags` are booleans; each of `values` takes the next argument.
const SUBCOMMANDS = {
  discover: { flags: ["--refresh", "--json"], values: [], run: discover },
  history: { flags: ["--from-gh", "--json"], values: ["--repo", "--limit", "--import"], run: history },
  metrics: { flags: ["--json"], values: ["--workflow", "--window"], run: metrics },
  apply: { flags: ["--dry-run", "--json"], values: ["--shards"], run: apply },
  analyze: { flags: ["--json"], values: [], run: analyzeRepo },
  validate: { flags: ["--fail-fast", "--json"], values: ["--tier", "--base"], run: validate },
  baseline: { flags: ["--capture", "--fail-on-regression", "--json"], values: [], run: baseline },
  compare: { flags: ["--json"], values: ["--before", "--after"], run: compare },
  triggers: { flags: ["--explicit", "--json"], values: [], run: triggers },
  report: { flags: ["--json"], values: ["--out"], run: reportRepo },
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
  const flags = new Set();
  const values = new Map();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (command.values.includes(arg)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) throw usageError(`${arg} needs a value for ci ${sub}`);
      if (values.has(arg)) throw usageError(`${arg} given more than once for ci ${sub}`);
      values.set(arg, value);
      i++;
    } else if (command.flags.includes(arg)) {
      flags.add(arg);
    } else {
      const known = [...command.flags, ...command.values.map((name) => `${name} <value>`)].join(" ");
      throw usageError(`${arg.startsWith("-") ? "unknown flag" : "unexpected argument"} ${arg} for ci ${sub} (flags: ${known})`);
    }
  }
  return { command, flags, values };
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
    const { command, flags, values } = parse(args);
    const root = ciRoot(cwd, env);
    const result = await command.run({ root, cwd, flags, values, env, json });
    out.write(json ? `${JSON.stringify(result.json)}\n` : `${result.lines.join("\n")}\n`);
    return result.code;
  } catch (error) {
    return report(error, json, out, err);
  }
}
