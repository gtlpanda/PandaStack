// After the pool process gets SIGINT/SIGTERM it must not start the steps still waiting in the queue.
// Stopping kills the running steps; their end must not make the scheduler launch the next ones, or
// they stay behind as detached process groups after the pool exits.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Loading the module first: where it does not exist there is nothing to test, and that is not this bug.
await import("../lib/gate-pool.mjs");
const POOL = fileURLToPath(new URL("../lib/gate-pool.mjs", import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, limitMs = 20_000) {
  const deadline = Date.now() + limitMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

test("a stop signal does not let the pool start queued steps", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "autobuild-pool-stop-"));
  const pidFile = (id) => path.join(dir, `${id}.pid`);
  // Each step records its pid (it leads its own process group) and then idles until killed.
  const idle = (id) => [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(pidFile(id))}, String(process.pid)); setInterval(() => {}, 1000);`];
  const job = (id) => ({
    id, spec: { argv: idle(id), cwd: dir, env: process.env, timeoutMs: 60_000 }, logFile: path.join(dir, `${id}.log`), resources: ["shared"], memoryMb: 0,
  });
  // "queued" shares a resource with "running", so it waits in the queue while "running" runs.
  const jobs = [job("running"), job("queued")];
  let pool = null;
  t.after(() => {
    for (const id of ["running", "queued"]) {
      try { process.kill(-Number(readFileSync(pidFile(id), "utf8")), "SIGKILL"); } catch { /* never started or already gone */ }
    }
    try { pool?.kill("SIGKILL"); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  });

  pool = spawn(process.execPath, [POOL], { stdio: ["pipe", "ignore", "ignore"] });
  const exited = new Promise((resolve) => pool.once("exit", (code, signal) => resolve({ code, signal })));
  pool.stdin.end(JSON.stringify({ jobs, options: { concurrency: 2, failFast: false, startGapMs: 0, pollMs: 10 } }));

  await waitFor(() => existsSync(pidFile("running")), "the first step to start");
  pool.kill("SIGINT");
  await exited;

  assert.equal(existsSync(pidFile("queued")), false,
    "BUGHUNT-F6 a queued step was started after the stop signal and is left running as an orphan when the pool exits");
});
