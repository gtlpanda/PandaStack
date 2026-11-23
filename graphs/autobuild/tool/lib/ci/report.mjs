// The per-repository CI report (spec/contracts/ci-optimizer-co-10.md): one JSON document built
// from what the other ci subcommands already compute (profile, metrics, findings, baseline,
// regression, triggers, validation), and its Markdown rendering. buildReport and renderReport are
// pure. The report applies nothing and never prints environment values: every figure comes from
// the stored state or the repository's own files. checkReportOut and writeReportOut guard the one
// repository write `ci report --out FILE` makes.

import { spawnSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, openSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SAFE_GIT } from "../proc.mjs";
import { regressionLines } from "./baseline.mjs";
import { oneLine, sortedUnique } from "./patterns.mjs";
import { CiError } from "./state.mjs";
import { workflowLabel } from "./triggers.mjs";

export const REPORT_SCHEMA_VERSION = 1;
const OUT_UNSAFE = "OUT_UNSAFE";
const UNREPORTED = "Not reported by the CI provider's API; not estimated.";
// Unknowns the CI provider's API cannot measure (priority contract, "Deferred").
const UNREPORTED_CODES = new Set(["CI_CACHE_HIT_RATE", "RUNNER_UTILIZATION"]);
const APPLIED_HEADING = "### Auto-applicable (low risk, run `autobuild ci apply`)";
const PROPOSED_HEADING = "### Proposed for review";
const TABLE_HEADER = "| Workflow | Runs | Wall p50 | Wall p90 | Queue p50 | Critical path p50 | Efficiency | Runner minutes | Flake rate |";
const TABLE_RULE = "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";

const list = (value) => (Array.isArray(value) ? value : []);
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isPresent = (value) => value !== null && value !== undefined;

// ---------- JSON ----------

/** The report document. Pure: the inputs are referenced, never mutated. */
export function buildReport({ profile, metrics, findings, baseline, regression, triggers, validation, generatedAt }) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt,
    repository: {
      root: profile?.root ?? null,
      languages: list(profile?.languages),
      testFrameworks: list(profile?.testFrameworks),
      providers: list(profile?.ci?.providers),
    },
    workflows: list(metrics?.workflows),
    gate: metrics?.gate ?? null,
    findings: list(findings),
    baseline: baseline ? { capturedAt: baseline.capturedAt ?? null, head: baseline.head ?? null } : null,
    regression: regression ?? null,
    triggers: triggers ?? null,
    validation: validation ?? null,
    unknowns: sortedUnique([...list(profile?.unknowns), ...list(metrics?.unknowns)]),
  };
}

// ---------- Markdown: figures ----------

/** Whole seconds with an `s` suffix, or `unknown`. */
const seconds = (value) => (isNumber(value) ? `${Math.round(value)}s` : "unknown");
/** A number as it is, or `unknown`. */
const figure = (value) => (isNumber(value) ? String(value) : "unknown");
/** A whole number, or `unknown`. */
const whole = (value) => (isNumber(value) ? String(Math.round(value)) : "unknown");
/** One table cell: one line, with `|` escaped so it cannot open a new column. */
const cell = (text) => oneLine(text).replace(/\|/g, "\\|");
const workflowCell = (name) => cell(workflowLabel(name)) || workflowLabel(null);
const shortSha = (sha) => (typeof sha === "string" && sha ? oneLine(sha).slice(0, 12) : "no commit");
const names = (items) => (items.length ? items.join(", ") : "none");

// ---------- Markdown: sections ----------

function validationLine(validation) {
  const tier = (record) => {
    if (!record || typeof record !== "object") return "not recorded";
    const outcome = record.ok === true ? "passed" : "failed";
    return `${outcome} at ${oneLine(record.at ?? "an unknown time")} on ${shortSha(record.head)}${record.dirty === true ? " with uncommitted changes" : ""}`;
  };
  if (!validation) return "- Validation of HEAD: none recorded";
  return `- Validation of HEAD: fast tier ${tier(validation.fast)}; full tier ${tier(validation.full)}`;
}

function repositorySection(report) {
  const { root, languages, testFrameworks } = report.repository;
  const frameworks = testFrameworks.map((f) => (f?.command ? `${oneLine(f.name)} (${oneLine(f.command)})` : oneLine(f?.name ?? "")));
  return [
    `- Root: ${root === null ? "unknown" : oneLine(root)}`,
    `- Languages: ${names(languages.map((l) => oneLine(l?.name ?? "")))}`,
    `- Test frameworks: ${names(frameworks)}`,
    validationLine(report.validation),
  ];
}

function ciConfigurationSection(report) {
  const providers = report.repository.providers;
  if (!providers.length) return ["No CI configuration found."];
  return providers.map((p) => {
    const status = p?.error ? `${oneLine(p.status)}: ${oneLine(p.error)}` : oneLine(p?.status ?? "unknown");
    return `- ${oneLine(p?.id ?? "unknown")} (${status}): ${names(list(p?.files).map(oneLine))}`;
  });
}

function measurementRow(w) {
  return `| ${[
    workflowCell(w.workflow),
    whole(w.runs),
    seconds(w.wallSeconds?.p50),
    seconds(w.wallSeconds?.p90),
    seconds(w.queueSeconds?.p50),
    seconds(w.criticalPathSeconds?.p50),
    figure(w.parallelEfficiency?.p50),
    whole(w.runnerMinutes?.total),
    figure(w.reliability?.flakeRate),
  ].join(" | ")} |`;
}

function measurementsSection(report) {
  const lines = report.workflows.length ? [TABLE_HEADER, TABLE_RULE, ...report.workflows.map(measurementRow)] : ["No CI history imported."];
  const gate = report.gate;
  if (gate) {
    lines.push("", `Local gate: ${whole(gate.runs)} full runs, wall p50 ${seconds(gate.wallSeconds?.p50)}, p90 ${seconds(gate.wallSeconds?.p90)}, cache hit rate ${figure(gate.cacheHitRate)}`);
  }
  return lines;
}

/** A regression line as Markdown: top-level lines are bullets, indented ones nested bullets. */
function regressionBullet(line) {
  return line.startsWith("  ") ? `  - ${oneLine(line)}` : `- ${oneLine(line)}`;
}

function baselineSection(report) {
  if (!report.baseline) return ["No baseline captured."];
  const lines = [`Baseline captured at ${oneLine(report.baseline.capturedAt ?? "an unknown time")} on ${shortSha(report.baseline.head)}.`, ""];
  const regression = report.regression;
  if (!regression) return [...lines, "Regressions: not evaluated."];
  return [...lines, ...regressionLines(regression).map(regressionBullet), "", `Regression: ${regression.regressed === true ? "yes" : "no"}.`];
}

function findingBullet(f) {
  const job = isPresent(f.job) ? `#${oneLine(f.job)}` : "";
  const saving = isNumber(f.estimatedSavingSeconds) ? ` — ~${Math.round(f.estimatedSavingSeconds)}s saved (estimate)` : "";
  return `- **${oneLine(f.rule)}** (${oneLine(f.risk)}) ${oneLine(f.target)}${job}: ${oneLine(f.summary)}${saving}`;
}

const bulletsOrNone = (items) => (items.length ? items.map(findingBullet) : ["- none"]);

function findingsSection(report) {
  const applied = report.findings.filter((f) => f.action === "apply");
  const proposed = report.findings.filter((f) => f.action !== "apply");
  return [APPLIED_HEADING, "", ...bulletsOrNone(applied), "", PROPOSED_HEADING, "", ...bulletsOrNone(proposed)];
}

function triggersSection(report) {
  const fired = list(report.triggers?.triggers);
  if (!report.triggers) return ["Not evaluated."];
  if (!fired.length) return ["No trigger fired."];
  return fired.map((t) => `- **${oneLine(t?.id ?? "unknown")}**: ${oneLine(t?.detail ?? "")}`);
}

function unknownsSection(report) {
  if (!report.unknowns.length) return ["- none"];
  return report.unknowns.map((code) => `- ${oneLine(code)}${UNREPORTED_CODES.has(code) ? ` — ${UNREPORTED}` : ""}`);
}

const SECTIONS = [
  ["## Repository", repositorySection],
  ["## CI configuration", ciConfigurationSection],
  ["## Measurements", measurementsSection],
  ["## Baseline and regressions", baselineSection],
  ["## Findings", findingsSection],
  ["## Triggers", triggersSection],
  ["## Unknowns", unknownsSection],
];

/** The report as Markdown, ending with a newline. Pure. */
export function renderReport(report) {
  const lines = ["# CI performance report", "", `Generated ${oneLine(report.generatedAt ?? "at an unknown time")}.`];
  for (const [heading, body] of SECTIONS) lines.push("", heading, "", ...body(report));
  return `${lines.join("\n")}\n`;
}

// ---------- --out ----------

const refuse = (given, why) => new CiError(OUT_UNSAFE, `--out ${given} ${why}; refusing to write it`, 2);

function lstatOrNull(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new CiError("OUT_IO", `cannot inspect --out path: ${error.code ?? error.message}`);
  }
}

/** `file` with its deepest existing ancestor resolved through any symbolic links. */
function realTarget(file) {
  const rest = [];
  let current = file;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw new CiError("OUT_IO", `cannot resolve --out path: ${error.code ?? error.message}`);
      const parent = path.dirname(current);
      if (parent === current) return file;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The repository's git directories, real paths: the work tree's `.git` entry (a directory, or a
 * file in a linked work tree), the git directory and the common directory. Fails closed.
 */
function gitDirs(root, env) {
  const result = spawnSync("git", [...SAFE_GIT, "rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], { cwd: root, env, encoding: "utf8" });
  const [top, gitDir, commonDir] = result.status === 0 ? result.stdout.split("\n").map((line) => line.trim()) : [];
  if (!top || !gitDir || !commonDir) throw new CiError(OUT_UNSAFE, "cannot locate the repository's .git directory; refusing to write --out", 2);
  return [path.join(top, ".git"), gitDir, path.resolve(root, commonDir)].map(realTarget);
}

const isInside = (file, dir) => file === dir || file.startsWith(`${dir}${path.sep}`);

/**
 * The absolute path `given` names (resolved against `cwd`), when it is safe to write: not an
 * existing symbolic link, directory or other non-regular file, and not inside the repository's
 * .git directory, even through a linked parent. Otherwise OUT_UNSAFE (exit 2).
 */
export function checkReportOut(given, { cwd, root, env = process.env }) {
  const file = path.resolve(cwd, given);
  const stat = lstatOrNull(file);
  if (stat?.isSymbolicLink()) throw refuse(given, "is a symbolic link");
  if (stat?.isDirectory()) throw refuse(given, "is a directory");
  if (stat && !stat.isFile()) throw refuse(given, "is not a regular file");
  const real = realTarget(file);
  if (gitDirs(root, env).some((dir) => isInside(real, dir))) throw refuse(given, "is inside the repository's .git directory");
  return file;
}

/**
 * Writes `text` to `file` (checked by checkReportOut) with mode 0644. O_NOFOLLOW refuses a link
 * planted after the check; the file is truncated only once it is known to be a regular file.
 */
export function writeReportOut(file, text, given) {
  let fd;
  try {
    // O_NONBLOCK: a FIFO planted after the check fails to open instead of hanging the command.
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
    if (!fstatSync(fd).isFile()) throw refuse(given, "is not a regular file");
    fchmodSync(fd, 0o644);   // the creation mode passes through the umask, and an existing file keeps its own
    ftruncateSync(fd, 0);
    writeFileSync(fd, text);
  } catch (error) {
    if (error instanceof CiError) throw error;
    if (error.code === "ELOOP") throw refuse(given, "is a symbolic link");
    if (error.code === "EISDIR") throw refuse(given, "is a directory");
    throw new CiError("OUT_IO", `cannot write ${given}: ${error.code ?? error.message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
