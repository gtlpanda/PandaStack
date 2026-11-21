// workflow-pool.mjs — runs workflow test files side by side for scripts/test-workflow.mjs.
// Each file runs alone in a child process (scripts/workflow-file-runner.mjs), at most
// `jobs` at once, longest first. Output is printed per file in the given (sorted) order as
// soon as every earlier file has finished, so a run reads the same however the children
// interleave. Every child gets the caller's environment plus its own AUTOBUILD_STATE_HOME
// (made for it, removed after it), so a test that runs the autobuild loop can touch neither
// real state nor another child's.
//
// A file counts as failed when its child:
//   - reports a failed test (the counts it writes to fd 3 at exit), or
//   - reports no counts (crashed, killed, or exited before the harness loaded), or
//   - exits non-zero although every test it counted passed, or
//   - runs past the per-file timeout (a handle left open keeps a child alive; the old serial
//     run hid that by ending with process.exit). The child is killed.
// The last three add one failure each, so nothing that went wrong can be counted as passed.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUNNER = join(import.meta.dirname, 'workflow-file-runner.mjs')
// After a child exits, how long to wait for its pipes to close. A grandchild that kept
// stdout open must not hold the whole suite; its output after this point is dropped.
const PIPE_GRACE_MS = 5000

// The longest delay setTimeout honours; Node turns anything larger into 1 ms.
export const MAX_TIMER_MS = 2 ** 31 - 1

// A positive-integer setting from the environment (PANDASTACK_TEST_JOBS,
// PANDASTACK_TEST_FILE_TIMEOUT_MS): unset means the default; anything else, or anything above
// `max`, is refused rather than guessed.
export function positiveSetting(name, value, defaultValue, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === '') return defaultValue
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > max) throw new Error(`${name} must be a positive integer of at most ${max}, got ${JSON.stringify(value)}`)
  return Number(value)
}

// Longest first: recorded milliseconds when every file has one, otherwise file size
// (the large files are the slow ones in this repo). Ties keep the given order.
export function scheduleOrder(files, timings = {}) {
  const known = files.every(f => Number.isFinite(timings[f]))
  const weight = f => (known ? timings[f] : sizeOf(f))
  return files.map((f, i) => ({ f, i, w: weight(f) })).sort((a, b) => b.w - a.w || a.i - b.i).map(x => x.f)
}
function sizeOf(file) {
  try { return statSync(file).size } catch { return 0 }
}

// The files of shard `index` (1-based) of `count`, for AUTOBUILD_SHARD. Every shard must compute
// the same split, so it uses file size (the same on every checkout of one commit), never
// recorded timings: largest first, each to the lightest shard (ties: the lowest shard). The
// result keeps the given order. Every file lands in exactly one shard.
export function shardFiles(files, { index, count }) {
  const loads = new Array(count).fill(0)
  const owner = new Map()
  const bySize = files.map((f, i) => ({ f, i, w: sizeOf(f) })).sort((a, b) => b.w - a.w || a.i - b.i)
  for (const { f, w } of bySize) {
    const target = loads.indexOf(Math.min(...loads))
    loads[target] += w
    owner.set(f, target + 1)
  }
  return files.filter(f => owner.get(f) === index)
}

// Turns one finished child into {pass, fail, skipped, text}.
export function settle({ countsText, code, signal, output, label, timedOutMs = null }) {
  let counts = null
  try {
    const parsed = JSON.parse(countsText)
    if ([parsed?.pass, parsed?.fail, parsed?.skipped].every(Number.isInteger)) counts = parsed
  } catch { /* no counts: handled below */ }
  let text = output
  if (timedOutMs !== null) {
    text += `  FAIL ${label} still running after ${timedOutMs} ms (PANDASTACK_TEST_FILE_TIMEOUT_MS); killed\n`
    return { pass: counts?.pass ?? 0, fail: (counts?.fail ?? 0) + 1, skipped: counts?.skipped ?? 0, text }
  }
  if (!counts) {
    text += `  FAIL ${label} reported no test counts (exit ${code ?? signal})\n`
    return { pass: 0, fail: 1, skipped: 0, text }
  }
  let { pass, fail, skipped } = counts
  if ((code !== 0 || signal) && fail === 0) {
    text += `  FAIL ${label} exited ${code ?? signal} after its tests passed\n`
    fail += 1
  }
  return { pass, fail, skipped, text }
}

function runChild(file, { cwd, env, label, timeoutMs }) {
  return new Promise(resolve => {
    const started = Date.now()
    const stateHome = mkdtempSync(join(tmpdir(), 'workflow-tests-state-'))
    const child = spawn(process.execPath, [RUNNER, file], { cwd, env: { ...env, AUTOBUILD_STATE_HOME: stateHome }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
    let output = '', countsText = '', exit = null, finished = false, timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', b => { output += b })
    child.stderr.on('data', b => { output += b })
    child.stdio[3].on('data', b => { countsText += b })
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      for (const stream of [child.stdout, child.stderr, child.stdio[3]]) stream.destroy()
      rmSync(stateHome, { recursive: true, force: true })
      resolve({ ...settle({ countsText, code: exit?.code ?? null, signal: exit?.signal ?? null, output, label, timedOutMs: timedOut ? timeoutMs : null }), ms: Date.now() - started })
    }
    child.once('error', error => { output += `${error.message}\n`; exit ??= { code: null, signal: 'spawn-error' }; finish() })
    child.once('exit', (code, signal) => { exit = { code, signal }; setTimeout(finish, PIPE_GRACE_MS).unref() })
    child.once('close', (code, signal) => { exit ??= { code, signal }; finish() })
  })
}

// files: absolute paths in report order. Returns {pass, fail, skipped, timings}.
// write(text) receives each file's output, in report order.
// alone: files that must not share the machine (tests with sub-second wall-clock budgets).
// They run first, one at a time, before any other file starts.
// fileTimeoutMs: how long one file may run before its child is killed and the file fails.
export const DEFAULT_FILE_TIMEOUT_MS = 10 * 60 * 1000
export async function runPool(files, { jobs, cwd, env = process.env, timings = {}, labelOf = f => f, write = t => process.stdout.write(t), alone = [], fileTimeoutMs = DEFAULT_FILE_TIMEOUT_MS }) {
  if (!Number.isInteger(fileTimeoutMs) || fileTimeoutMs < 1) throw new Error(`fileTimeoutMs must be a whole number of ms of at least 1, got ${fileTimeoutMs}`)
  // A longer delay than a timer can hold is clamped to the longest one, so it stays a long timeout.
  const timeoutMs = Math.min(fileTimeoutMs, MAX_TIMER_MS)
  const results = new Array(files.length)
  const index = new Map(files.map((f, i) => [f, i]))
  const solo = files.filter(f => alone.includes(f))
  const queue = scheduleOrder(files.filter(f => !alone.includes(f)), timings)
  let printed = 0
  const flush = () => {
    while (printed < files.length && results[printed]) write(results[printed++].text)
  }
  const runOne = async file => {
    results[index.get(file)] = await runChild(file, { cwd, env, label: labelOf(file), timeoutMs })
    flush()
  }
  const worker = async () => {
    while (queue.length) await runOne(queue.shift())
  }
  for (const file of solo) await runOne(file)
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, queue.length)) }, worker))
  const total = { pass: 0, fail: 0, skipped: 0, timings: {} }
  files.forEach((f, i) => {
    total.pass += results[i].pass; total.fail += results[i].fail; total.skipped += results[i].skipped
    total.timings[f] = results[i].ms
  })
  return total
}
