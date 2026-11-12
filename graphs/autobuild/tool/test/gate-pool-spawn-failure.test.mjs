// A step that cannot be spawned (its working directory does not exist) fails only that step. The
// pool process must survive, report the other steps normally and keep the spawn error message.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Loading the module first: where it does not exist there is nothing to test, and that is not this bug.
await import("../lib/gate-pool.mjs");
const POOL = fileURLToPath(new URL("../lib/gate-pool.mjs", import.meta.url));

test("a spawn failure fails only that step and the pool still reports the others", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "autobuild-pool-spawn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const job = (id, cwd, argv) => ({
    id, spec: { argv, cwd, env: process.env, timeoutMs: 60_000 }, logFile: path.join(dir, `${id}.log`), resources: [`r-${id}`], memoryMb: 0,
  });
  const jobs = [
    job("good", dir, [process.execPath, "-e", "process.exit(0)"]),
    job("broken", path.join(dir, "missing-cwd"), [process.execPath, "-e", "process.exit(0)"]),
  ];
  const run = spawnSync(process.execPath, [POOL], {
    input: JSON.stringify({ jobs, options: { concurrency: 2, startGapMs: 0, pollMs: 10 } }),
    encoding: "utf8",
    timeout: 60_000,
  });
  let parsed = null;
  try { parsed = JSON.parse(run.stdout); } catch { /* reported below */ }
  assert.ok(parsed, `BUGHUNT-F2 the pool process died instead of reporting results (exit ${run.status}): ${run.stderr.split("\n").slice(0, 6).join(" | ")}`);
  assert.equal(parsed.results.good?.ok, true, "BUGHUNT-F2 a step that passed must still be reported as passed");
  assert.equal(parsed.results.broken?.ok, false, "BUGHUNT-F2 the step that could not spawn must be reported as failed");
  assert.match(String(parsed.results.broken?.error), /ENOENT/, "BUGHUNT-F2 the spawn error message must be kept");
});
