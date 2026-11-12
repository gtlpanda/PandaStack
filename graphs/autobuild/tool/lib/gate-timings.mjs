// Gate timings, kept for both backends: every gate run and every loop iteration appends one JSON
// line to <logsDir>/gate-timings.jsonl. Nothing is written when the logs directory is not
// gitignored: the file would dirty the tree the gate is checking.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { git } from "./proc.mjs";

export const TIMINGS_FILE = "gate-timings.jsonl";
const ignoredByGit = new Map();

/** The logs directory when it is safe to write there (inside git's ignore rules), else null. */
export function timingsDir(config) {
  if (!ignoredByGit.has(config.root)) {
    const rel = path.relative(config.root, path.join(config.root, config.logsDir)).split(path.sep).join("/");
    const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    ignoredByGit.set(config.root, inside && git(config, ["check-ignore", "-q", "--no-index", `${rel}/probe`]).ok);
  }
  return ignoredByGit.get(config.root) ? path.join(config.root, config.logsDir) : null;
}

/** Appends one record; never throws (a timing line must not fail a gate). */
export function appendTiming(config, record) {
  try {
    const dir = timingsDir(config);
    if (!dir) return false;
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, TIMINGS_FILE), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    return true;
  } catch {
    return false;
  }
}

export function readTimings(config) {
  const file = path.join(config.root, config.logsDir, TIMINGS_FILE);
  if (!existsSync(file)) return [];
  const records = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* a line cut short by a kill */ }
  }
  return records;
}

/** What the gate runs for one feature cost since `sinceIso`: seconds and step counts. */
export function gateTotals(records, { feature, sinceIso }) {
  const totals = { runs: 0, seconds: 0, run: 0, cached: 0, skipped: 0 };
  for (const record of records) {
    if (record.type !== "gate" || record.feature !== feature || record.at < sinceIso) continue;
    totals.runs += 1;
    totals.seconds += record.wallSeconds ?? 0;
    totals.cached += record.steps.filter((step) => step.cached).length;
    totals.run += record.steps.filter((step) => !step.cached).length;
    totals.skipped += (record.skipped ?? []).length;
  }
  return totals;
}

export const timingLine = ({ sessionSeconds, gateSeconds, run, cached, skipped }) => `session ${sessionSeconds}s, gate ${gateSeconds}s (${run} run, ${cached} cached, ${skipped} skipped)`;
