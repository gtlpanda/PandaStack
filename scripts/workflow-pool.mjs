// workflow-pool.mjs — runs workflow test files side by side for scripts/test-workflow.mjs.
// Each file runs alone in a child process (scripts/workflow-file-runner.mjs), at most
// `jobs` at once, longest first. Output is printed per file in the given (sorted) order as
// soon as every earlier file has finished, so a run reads the same however the children
// interleave. Every child gets the caller's environment plus a private
// AUTOBUILD_STATE_HOME, so a test that runs the autobuild loop cannot touch real state.
//
// A file counts as failed when its child:
//   - reports a failed test (the counts it writes to fd 3 at exit), or
//   - reports no counts (crashed, killed, or exited before the harness loaded), or
//   - exits non-zero although every test it counted passed.
// The last two add one failure each, so nothing that went wrong can be counted as passed.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUNNER = join(import.meta.dirname, 'workflow-file-runner.mjs')
// After a child exits, how long to wait for its pipes to close. A grandchild that kept
// stdout open must not hold the whole suite; its output after this point is dropped.
const PIPE_GRACE_MS = 5000

// PANDASTACK_TEST_JOBS: a positive integer; anything else is refused rather than guessed.
export function jobsFrom(value, defaultJobs) {
  if (value === undefined || value === '') return defaultJobs
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`PANDASTACK_TEST_JOBS must be a positive integer, got ${JSON.stringify(value)}`)
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

// Turns one finished child into {pass, fail, skipped, text}.
export function settle({ countsText, code, signal, output, label }) {
  let counts = null
  try {
    const parsed = JSON.parse(countsText)
    if ([parsed?.pass, parsed?.fail, parsed?.skipped].every(Number.isInteger)) counts = parsed
  } catch { /* no counts: handled below */ }
  let text = output
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

function runChild(file, { cwd, env, label }) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn(process.execPath, [RUNNER, file], { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
    let output = '', countsText = '', exit = null, finished = false
    child.stdout.on('data', b => { output += b })
    child.stderr.on('data', b => { output += b })
    child.stdio[3].on('data', b => { countsText += b })
    const finish = () => {
      if (finished) return
      finished = true
      for (const stream of [child.stdout, child.stderr, child.stdio[3]]) stream.destroy()
      resolve({ ...settle({ countsText, code: exit?.code ?? null, signal: exit?.signal ?? null, output, label }), ms: Date.now() - started })
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
export async function runPool(files, { jobs, cwd, env = process.env, timings = {}, labelOf = f => f, write = t => process.stdout.write(t), alone = [] }) {
  const stateHome = mkdtempSync(join(tmpdir(), 'workflow-tests-state-'))
  const childEnv = { ...env, AUTOBUILD_STATE_HOME: stateHome }
  const results = new Array(files.length)
  const index = new Map(files.map((f, i) => [f, i]))
  const solo = files.filter(f => alone.includes(f))
  const queue = scheduleOrder(files.filter(f => !alone.includes(f)), timings)
  let printed = 0
  const flush = () => {
    while (printed < files.length && results[printed]) write(results[printed++].text)
  }
  const runOne = async file => {
    results[index.get(file)] = await runChild(file, { cwd, env: childEnv, label: labelOf(file) })
    flush()
  }
  const worker = async () => {
    while (queue.length) await runOne(queue.shift())
  }
  try {
    for (const file of solo) await runOne(file)
    await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, queue.length)) }, worker))
  } finally {
    rmSync(stateHome, { recursive: true, force: true })
  }
  const total = { pass: 0, fail: 0, skipped: 0, timings: {} }
  files.forEach((f, i) => {
    total.pass += results[i].pass; total.fail += results[i].fail; total.skipped += results[i].skipped
    total.timings[f] = results[i].ms
  })
  return total
}
