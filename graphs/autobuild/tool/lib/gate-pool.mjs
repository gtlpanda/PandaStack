// Runs gate steps side by side (gateConcurrency > 1). runGate is synchronous, so it starts this
// file as a child process, hands it the steps as JSON on stdin and reads the results from stdout.
// Rules:
//   - at most `concurrency` steps at once;
//   - steps that share a resource never overlap; a step that declares no resources runs alone,
//     and nothing later in the order starts before it;
//   - no new step starts while free memory is under the floor (plus what the step says it needs
//     and what recently started steps have reserved), unless nothing is running; with a floor
//     set, starts are also spaced out, so a burst cannot outrun the memory reading;
//   - with failFast, nothing new starts after the first failure; running steps finish.
// Each step runs in its own process group with its output in its own log file.

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KILL_GRACE_MS = 30_000;

/** MemAvailable in MiB, or null where /proc/meminfo does not exist (then memory never holds a step back). */
export function memAvailableMb(file = "/proc/meminfo") {
  try {
    const match = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync(file, "utf8"));
    return match ? Math.floor(Number(match[1]) / 1024) : null;
  } catch {
    return null;
  }
}

function launch(job) {
  const out = openSync(job.logFile, "w");
  const started = Date.now();
  return new Promise((resolve) => {
    let child, timer, killTimer, timedOut = false;
    const done = (status, error) => {
      clearTimeout(timer); clearTimeout(killTimer);
      closeSync(out);
      resolve({ ok: status === 0 && !timedOut, status, ms: Date.now() - started, timedOut, error: error?.message });
    };
    const kill = (signal) => { try { process.kill(-child.pid, signal); } catch { /* already gone */ } };
    try {
      child = spawn(job.spec.argv[0], job.spec.argv.slice(1), { cwd: job.spec.cwd, env: job.spec.env, detached: true, stdio: ["ignore", out, out] });
    } catch (error) { done(127, error); return; }
    job.kill = kill;
    timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS); }, job.spec.timeoutMs);
    child.once("error", (error) => done(127, error));
    child.once("close", (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

/**
 * Runs `jobs` (in priority order) and resolves to { results: {id: {ok, status, ms, timedOut}}, events }.
 * A job: { id, spec: {argv, cwd, env, timeoutMs}, logFile, resources: string[] | null, memoryMb }.
 * `run`, `memAvailable` and the timings are injectable for tests.
 */
export async function runPool(jobs, { concurrency = 1, failFast = false, minFreeMb = 0, run = launch, memAvailable = memAvailableMb, settleMs = 30_000, pollMs = 1000, startGapMs = 1000, onEvent = () => {} } = {}) {
  const pending = [...jobs];
  const running = new Map();
  const results = {};
  const events = [];
  const note = (type, job, extra = {}) => { const event = { type, id: job.id, at: Date.now(), ...extra }; events.push(event); onEvent(event); };
  let failed = false;
  let memoryHeld = false;
  let lastStart = 0;

  const reserved = () => [...running.values()].filter((entry) => Date.now() - entry.startedAt < settleMs).reduce((sum, entry) => sum + (entry.job.memoryMb ?? 0), 0);
  const blocker = (job) => {
    if (running.size >= concurrency) return "concurrency";
    const exclusive = job.resources == null;
    if (exclusive) return running.size ? "exclusive" : null;
    for (const entry of running.values()) {
      if (entry.job.resources == null) return "exclusive";
      if (entry.job.resources.some((name) => job.resources.includes(name))) return "resource";
    }
    if (running.size === 0) return null; // one step always runs, so the gate cannot stall
    const free = memAvailable();
    if (free == null) return null;
    if (minFreeMb > 0 && Date.now() - lastStart < startGapMs) return "memory";
    if (free - reserved() < minFreeMb + (job.memoryMb ?? 0)) return "memory";
    return null;
  };

  return new Promise((resolve) => {
    let timer = null;
    const finishIfIdle = () => {
      if (running.size === 0 && (pending.length === 0 || (failed && failFast))) { clearTimeout(timer); resolve({ results, events }); return true; }
      return false;
    };
    const tick = () => {
      clearTimeout(timer); timer = null;
      if (finishIfIdle()) return;
      memoryHeld = false;
      if (!(failed && failFast)) {
        for (let i = 0; i < pending.length; i += 1) {
          const job = pending[i];
          const why = blocker(job);
          if (why === "concurrency") break;
          // Memory holds back everything behind it too, so the order stays the order.
          if (why === "memory") { memoryHeld = true; if (!job.memoryNoted) { job.memoryNoted = true; note("memory-wait", job); } break; }
          // A step that must run alone keeps its place: nothing after it overtakes it.
          if (why === "exclusive" && job.resources == null) break;
          if (why) continue;
          pending.splice(i, 1); i -= 1;
          const entry = { job, startedAt: Date.now() };
          lastStart = entry.startedAt;
          running.set(job.id, entry);
          note("start", job);
          Promise.resolve(run(job)).catch((error) => ({ ok: false, status: 1, ms: Date.now() - entry.startedAt, error: String(error?.message ?? error) })).then((result) => {
            running.delete(job.id);
            results[job.id] = result;
            if (!result.ok) failed = true;
            note("end", job, { ok: result.ok });
            tick();
          });
        }
      }
      if (finishIfIdle()) return;
      // Memory frees up without any step ending, so look again; everything else waits for an end.
      if (memoryHeld) timer = setTimeout(tick, pollMs);
    };
    tick();
  });
}

async function main() {
  const { jobs, options } = JSON.parse(readFileSync(0, "utf8"));
  const stop = () => { for (const job of jobs) job.kill?.("SIGTERM"); setTimeout(() => process.exit(130), 2000).unref(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const { results, events } = await runPool(jobs, options);
  process.stdout.write(JSON.stringify({ results, events }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
