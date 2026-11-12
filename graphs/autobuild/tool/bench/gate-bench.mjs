#!/usr/bin/env node
// A benchmark of the gate's schedule on a throwaway project of slow steps (sleeps), shaped like a
// real 53-step gate measured at 3136 s serial: six long browser suites (278-521 s), two long CI
// suites (200 and 210 s) and 45 short steps. One real minute is one second here (SCALE=60).
// It measures scheduling only: sleeps do not compete for CPU, memory, ports or a database.
//
//   node graphs/autobuild/tool/bench/gate-bench.mjs [--scale 60] [--concurrency 2,4,6]
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; };
const SCALE = Number(arg("--scale", "60"));
const LEVELS = arg("--concurrency", "2,4,6").split(",").map(Number);
process.env.AUTOBUILD_STATE_HOME = mkdtempSync(path.join(tmpdir(), "autobuild-bench-state-"));

const { project, head } = await import("../test-fixtures/project.mjs");
const { loadConfig } = await import("../lib/config.mjs");
const { runGate } = await import("../lib/gate.mjs");
const { dropCache } = await import("../lib/gate-cache.mjs");

// name, real seconds, area (its `paths` and database). Areas p114 and p112 each back two entries.
const LONG = [["browser P21", 521, "p21"], ["browser P211", 456, "p211"], ["browser P2-2", 338, "p112"], ["browser P25", 305, "p25"], ["browser P29", 283, "p29"], ["browser P28", 278, "p28"],
  ["ci: security + e2e", 210, "ci-e2e"], ["ci: acceptance", 200, "ci-acc"]];
const AREAS = ["p21", "p211", "p112", "p25", "p29", "p28", "p114", "p13", "p14", "p15", "p16", "p17", "p18", "p19", "p110"];
const SHORT = Array.from({ length: 45 }, (_, i) => [`suite ${String(i + 1).padStart(2, "0")}`, i === 0 ? 14 : 12, AREAS[i % AREAS.length]]);
const ENTRIES = [...LONG.slice(0, 6), ...SHORT.slice(1), ...LONG.slice(6), SHORT[0]]; // the 14 s CI unit suite sits last, as CI parity does
const scaled = (seconds) => (seconds / SCALE).toFixed(3);

function build({ keys, concurrency = 1, failing = null }) {
  const root = project(["F-1", "F-2"]);
  // Every area exists, so each entry's `paths` names real files (a glob matching nothing is run, not skipped).
  for (const area of [...AREAS, "shared"]) { mkdirSync(path.join(root, area), { recursive: true }); writeFileSync(path.join(root, area, "index.js"), "1\n"); }
  execFileSync("git", ["-C", root, "add", "-A"]); execFileSync("git", ["-C", root, "commit", "-q", "-m", "areas"]);
  const config = loadConfig(root, {});
  config.runners.unit.command = "true";
  config.gate = ENTRIES.map(([name, seconds, area]) => ({
    name,
    command: `sleep ${scaled(seconds)}${name === failing ? "; exit 1" : ""}`,
    ...(keys ? { resources: [`db:${area}`], ...(name.startsWith("ci:") || name === "suite 01" ? {} : { paths: [`${area}/**`, "shared/**"] }) } : {}),
  }));
  if (keys) Object.assign(config, { gateConcurrency: concurrency, gateOrder: "fastest", gateCache: true, gateMinFreeMb: 0 });
  dropCache(config);
  return { root, config };
}
const timed = (fn) => { const started = Date.now(); const result = fn(); return { seconds: (Date.now() - started) / 1000, result }; };
const touch = (root, file) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); appendFileSync(path.join(root, file), `${Date.now()}\n`); };
const rows = [];
const row = (name, seconds, note) => { rows.push([name, seconds, note]); console.log(`${name.padEnd(58)} ${seconds.toFixed(1).padStart(6)} s  ${note}`); };
const serialSum = ENTRIES.reduce((sum, [, seconds]) => sum + seconds, 0);

console.log(`fixture: ${ENTRIES.length} gate entries, ${serialSum} s serial at real scale, ${scaled(serialSum)} s here (1 real minute = ${(60 / SCALE).toFixed(2)} s)\n`);

// --- before: no scheduling keys ---
{
  const { root, config } = build({ keys: false });
  const base = head(root);
  touch(root, "p21/feature.js");
  const full = timed(() => runGate(config, { featureId: "F-1", baseSha: base, failFast: true }));
  row("before  per-feature gate (no keys: serial, everything)", full.seconds, `${full.result.steps.length} steps run`);
  appendFileSync(path.join(root, "PROGRESS.md"), "\nREVIEW: no drift\n");
  const review = timed(() => runGate(config, { baseSha: base, failFast: true }));
  row("before  post-review gate (progress file only changed)", review.seconds, `${review.result.steps.length} steps run`);
  rmSync(root, { recursive: true, force: true });
}
{
  const { root, config } = build({ keys: false, failing: "suite 01" });
  const failed = timed(() => runGate(config, { featureId: "F-1", failFast: true }));
  row("before  time to a failing 14 s suite (last in config order)", failed.seconds, `ok=${failed.result.ok}`);
  rmSync(root, { recursive: true, force: true });
}
console.log("");

// --- after: resources + paths on every entry, gateOrder fastest, gateCache, gateConcurrency N ---
for (const concurrency of LEVELS) {
  const { root, config } = build({ keys: true, concurrency });
  const base = head(root);
  const full = timed(() => runGate(config, { featureId: "F-1", baseSha: base, failFast: true }));
  row(`after   full gate, concurrency ${concurrency} (every Nth feature)`, full.seconds, `${full.result.steps.length} steps run, ok=${full.result.ok}`);
  touch(root, "p13/feature.js");
  const small = timed(() => runGate(config, { featureId: "F-1", baseSha: base, failFast: true, scope: "affected" }));
  row(`after   per-feature gate, change in a short-suite area, c=${concurrency}`, small.seconds, `${small.result.steps.filter((s) => !s.cached).length} run, ${small.result.skipped.length} skipped`);
  touch(root, "p21/feature.js");
  const browser = timed(() => runGate(config, { featureId: "F-1", baseSha: base, failFast: true, scope: "affected" }));
  row(`after   per-feature gate, change in the slowest browser area, c=${concurrency}`, browser.seconds, `${browser.result.steps.filter((s) => !s.cached).length} run, ${browser.result.skipped.length} skipped`);
  execFileSync("git", ["-C", root, "add", "-A"]); execFileSync("git", ["-C", root, "commit", "-q", "-m", "feat"]);
  const whole = timed(() => runGate(config, { baseSha: base, failFast: true }));
  appendFileSync(path.join(root, "PROGRESS.md"), "\nREVIEW: no drift\n");
  const review = timed(() => runGate(config, { baseSha: base, failFast: true }));
  row(`after   post-review gate (progress file only changed), c=${concurrency}`, review.seconds, `${review.result.steps.filter((s) => s.cached).length} reused, ${review.result.steps.filter((s) => !s.cached).length} run (whole gate before it: ${whole.seconds.toFixed(1)} s)`);
  rmSync(root, { recursive: true, force: true });
  console.log("");
}
{
  const { root, config } = build({ keys: true, concurrency: 4, failing: "suite 01" });
  const first = timed(() => runGate(config, { featureId: "F-1", failFast: true }));
  const second = timed(() => runGate(config, { featureId: "F-1", failFast: true }));
  row("after   time to the failing 14 s suite, first time seen, c=4", first.seconds, `ok=${first.result.ok}, ${first.result.notRun.length} not run`);
  row("after   time to the failing 14 s suite, once it has failed, c=4", second.seconds, `ok=${second.result.ok}, ${second.result.notRun.length} not run`);
  rmSync(root, { recursive: true, force: true });
}
writeFileSync(path.join(process.env.AUTOBUILD_STATE_HOME, "bench.json"), JSON.stringify({ scale: SCALE, rows }));
console.log(`\nmultiply by ${SCALE} for the real-scale equivalent`);
rmSync(process.env.AUTOBUILD_STATE_HOME, { recursive: true, force: true });
