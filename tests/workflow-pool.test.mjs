// The parallel workflow runner (scripts/workflow-pool.mjs, scripts/workflow-file-runner.mjs):
// counting, failure accounting and output order, on tiny fixture test files in a temp dir.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO, test } from '../scripts/workflow-harness.mjs'
import { MAX_TIMER_MS, descendants, killTree, positiveSetting, scheduleOrder, settle, runPool } from '../scripts/workflow-pool.mjs'

const HARNESS = pathToFileURL(join(REPO, 'scripts', 'workflow-harness.mjs')).href
// Writes fixture test files (name -> body); each body may use `test` from the real harness.
function fixtures(bodies) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-pool-'))
  const files = Object.entries(bodies).map(([name, body]) => {
    const file = join(dir, name)
    writeFileSync(file, `import { test } from ${JSON.stringify(HARNESS)}\n${body}\n`)
    return file
  })
  return { dir, files }
}
async function pool(bodies, options = {}) {
  const { dir, files } = fixtures(bodies)
  let out = ''
  try {
    const total = await runPool(files, { jobs: 4, cwd: REPO, labelOf: f => f.slice(dir.length + 1), write: t => { out += t }, ...options })
    return { ...total, out }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

await test('pool: counts passes, failures and skips from every child', async () => {
  const r = await pool({
    'a.test.mjs': "await test('a1', () => {}); await test('a2', () => {})",
    'b.test.mjs': "await test('b1', () => { throw new Error('boom') })",
    'c.test.mjs': "await test('c1', { skip: 'not here' }, () => {})",
  })
  assert.deepEqual([r.pass, r.fail, r.skipped], [2, 1, 1])
  assert.match(r.out, /FAIL b1\n {7}boom/)
})

await test('pool: an async test the file does not await still counts (counts are taken at exit)', async () => {
  const r = await pool({ 'late.test.mjs': "test('late', async () => { await new Promise(r => setTimeout(r, 200)); throw new Error('late failure') })" })
  assert.deepEqual([r.pass, r.fail], [0, 1])
  assert.match(r.out, /FAIL late/)
})

await test('pool: a file that throws on import is one failure named "<file> loads"', async () => {
  const r = await pool({ 'bad.test.mjs': "throw new Error('broken import')" })
  assert.deepEqual([r.pass, r.fail], [0, 1])
  assert.match(r.out, /FAIL \S*bad\.test\.mjs loads/)
})

await test('pool: a child that dies before reporting counts is a failure', async () => {
  const r = await pool({ 'dies.test.mjs': "await test('ran', () => {}); process.kill(process.pid, 'SIGKILL')" })
  assert.equal(r.fail, 1)
  assert.match(r.out, /dies\.test\.mjs reported no test counts \(exit SIGKILL\)/)
})

await test('pool: a non-zero exit after only passing tests adds a failure', async () => {
  const r = await pool({ 'exits.test.mjs': "await test('fine', () => {}); process.exitCode = 4" })
  assert.deepEqual([r.pass, r.fail], [1, 1])
  assert.match(r.out, /exits\.test\.mjs exited 4 after its tests passed/)
})

await test('pool: output is printed in the given file order, whatever order children finish in', async () => {
  const slow = ms => `await new Promise(r => setTimeout(r, ${ms})); await test('t${ms}', () => {})`
  const r = await pool({ '1.test.mjs': slow(600), '2.test.mjs': slow(10), '3.test.mjs': slow(300) })
  assert.deepEqual([...r.out.matchAll(/ok {3}t(\d+)/g)].map(m => m[1]), ['600', '10', '300'])
})

await test('pool: every child gets its own AUTOBUILD_STATE_HOME, removed after it, and the caller\'s other variables', async () => {
  const seen = join(mkdtempSync(join(tmpdir(), 'workflow-pool-homes-')), 'homes')
  const body = `import { appendFileSync, existsSync } from 'node:fs'
await test('env', () => {
  const home = process.env.AUTOBUILD_STATE_HOME
  if (!home?.includes('workflow-tests-state-') || !existsSync(home)) throw new Error('state home ' + home)
  if (process.env.POOL_PROBE !== 'kept') throw new Error('probe lost')
  appendFileSync(${JSON.stringify(seen)}, home + '\\n')
})`
  try {
    const r = await pool({ 'one.test.mjs': body, 'two.test.mjs': body }, { env: { ...process.env, AUTOBUILD_STATE_HOME: '/should/not/be/used', POOL_PROBE: 'kept' } })
    assert.deepEqual([r.pass, r.fail], [2, 0], r.out)
    const homes = readFileSync(seen, 'utf8').trim().split('\n')
    assert.equal(new Set(homes).size, 2, 'two children, two state homes')
    for (const home of homes) assert.equal(existsSync(home), false, `${home} removed after its child`)
  } finally { rmSync(dirname(seen), { recursive: true, force: true }) }
})

await test('pool: a file still running after the per-file timeout is killed and fails, by name', async () => {
  const r = await pool({ 'hangs.test.mjs': "await test('passes, then leaves a handle open', () => {}); setInterval(() => {}, 1000)" }, { fileTimeoutMs: 1500 })
  assert.deepEqual([r.pass, r.fail], [0, 1], r.out)
  assert.match(r.out, /hangs\.test\.mjs still running after 1500 ms \(PANDASTACK_TEST_FILE_TIMEOUT_MS\); killed/)
})

await test('positiveSetting: only a positive integer is accepted, named in the error; unset means the default', () => {
  assert.equal(positiveSetting('X', undefined, 8), 8)
  assert.equal(positiveSetting('X', '', 8), 8)
  assert.equal(positiveSetting('X', '1', 8), 1)
  assert.equal(positiveSetting('X', '12', 8), 12)
  for (const bad of ['0', '-2', '1.5', ' 3', '3 ', 'four', '07', '1e2']) assert.throws(() => positiveSetting('PANDASTACK_TEST_JOBS', bad, 8), /^Error: PANDASTACK_TEST_JOBS must be a positive integer/, bad)
  // Above the maximum is refused too: a timer delay over 2^31-1 ms would fire after 1 ms.
  assert.equal(positiveSetting('T', String(MAX_TIMER_MS), 8, MAX_TIMER_MS), MAX_TIMER_MS)
  for (const big of [String(MAX_TIMER_MS + 1), '3000000000', '99999999999999999999']) {
    assert.throws(() => positiveSetting('PANDASTACK_TEST_FILE_TIMEOUT_MS', big, 600000, MAX_TIMER_MS), /at most 2147483647/, big)
  }
})

await test('pool: a file timeout longer than a timer can hold acts as a long timeout, not 1 ms; a non-positive one is refused', async () => {
  const r = await pool({ 'slow.test.mjs': "await test('slow but fine', async () => { await new Promise(r => setTimeout(r, 400)) })" }, { fileTimeoutMs: 3e9 })
  assert.deepEqual([r.pass, r.fail], [1, 0], r.out)
  for (const fileTimeoutMs of [0, -5, 1.5, NaN]) {
    await assert.rejects(runPool([], { jobs: 1, cwd: REPO, fileTimeoutMs }), /fileTimeoutMs must be a whole number of ms of at least 1/, String(fileTimeoutMs))
  }
})

await test('scheduleOrder: longest recorded time first; size order until every file has a time', () => {
  const { dir, files } = fixtures({ 'small.test.mjs': '', 'big.test.mjs': '/*' + 'x'.repeat(5000) + '*/', 'mid.test.mjs': '/*' + 'x'.repeat(500) + '*/' })
  try {
    const [small, big, mid] = files
    assert.deepEqual(scheduleOrder(files, {}), [big, mid, small], 'by size with no timings')
    assert.deepEqual(scheduleOrder(files, { [small]: 900, [big]: 10, [mid]: 50 }), [small, mid, big], 'by recorded time')
    assert.deepEqual(scheduleOrder(files, { [small]: 900 }), [big, mid, small], 'partial timings fall back to size')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test('settle: malformed or missing counts never count as passing', () => {
  for (const countsText of ['', 'null', '{"pass":1}', '{"pass":"1","fail":0,"skipped":0}', 'not json']) {
    const r = settle({ countsText, code: 0, signal: null, output: '', label: 'x' })
    assert.deepEqual([r.pass, r.fail], [0, 1], countsText)
  }
  const ok = settle({ countsText: '{"pass":3,"fail":0,"skipped":1}', code: 0, signal: null, output: 'out\n', label: 'x' })
  assert.deepEqual([ok.pass, ok.fail, ok.skipped, ok.text], [3, 0, 1, 'out\n'])
})

await test('pool: "alone" files run first, one at a time, before any other file starts', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'workflow-pool-alone-')), 'spans')
  const span = name => `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, '${name} start ' + Date.now() + '\\n')
await new Promise(r => setTimeout(r, 150))
appendFileSync(${JSON.stringify(log)}, '${name} end ' + Date.now() + '\\n')
await test('${name}', () => {})`
  const { dir, files } = fixtures({ 'a.test.mjs': span('a'), 'b.test.mjs': span('b'), 'c.test.mjs': span('c'), 'd.test.mjs': span('d') })
  try {
    const [, b, , d] = files
    const r = await runPool(files, { jobs: 4, cwd: REPO, alone: [b, d], write: () => {} })
    assert.deepEqual([r.pass, r.fail], [4, 0])
    const at = {}
    for (const line of readFileSync(log, 'utf8').trim().split('\n')) { const [name, edge, t] = line.split(' '); at[`${name} ${edge}`] = Number(t) }
    assert.ok(at['b end'] <= at['d start'] || at['d end'] <= at['b start'], 'the alone files did not overlap')
    const lastAlone = Math.max(at['b end'], at['d end'])
    assert.ok(at['a start'] >= lastAlone && at['c start'] >= lastAlone, 'no other file started before the alone files finished')
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(dirname(log), { recursive: true, force: true }) }
})

// A process is dead for these checks once it is gone or a zombie waiting to be reaped.
function alive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch {
    if (existsSync('/proc')) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }
}
async function settles(pid) {
  for (let i = 0; i < 150 && alive(pid); i++) await new Promise(r => setTimeout(r, 20))
  return !alive(pid)
}
// The process group of `pid` (field 5 of /proc/<pid>/stat), or null without procfs.
function groupOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2])
  } catch { return null }
}
// Cleanup for a pid a test itself started and recorded: exact, real pids only.
function killStarted(pid) {
  if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
}
async function waitForFile(file) {
  for (let i = 0; i < 250 && !existsSync(file); i++) await new Promise(r => setTimeout(r, 20))
  return Number(readFileSync(file, 'utf8'))
}

await test('descendants: walks parent links down from the root, never returning the root or pid 0/1', () => {
  const table = [
    { pid: 1, ppid: 0 }, { pid: 50, ppid: 1 }, { pid: 51, ppid: 1 },
    { pid: 100, ppid: 50 }, { pid: 101, ppid: 100 }, { pid: 102, ppid: 101 }, { pid: 103, ppid: 100 },
    { pid: 200, ppid: 51 },
  ]
  assert.deepEqual(descendants(50, table).sort((a, b) => a - b), [100, 101, 102, 103])
  assert.deepEqual(descendants(101, table), [102])
  assert.deepEqual(descendants(102, table), [], 'a leaf has none')
  assert.deepEqual(descendants(999, table), [], 'an unknown root has none')
  assert.deepEqual(descendants(50, []), [], 'an empty table has none')
  // Bad rows cannot widen the result: a loop back to the root, and rows naming pid 0 or 1.
  const odd = [{ pid: 60, ppid: 70 }, { pid: 70, ppid: 60 }, { pid: 1, ppid: 60 }, { pid: 0, ppid: 60 }]
  assert.deepEqual(descendants(60, odd), [70])
})

await test('killTree: refuses pid 0, 1, a negative pid and this process; kills the root when the table cannot be read', async () => {
  const unreadable = () => { throw Object.assign(new Error('no ps'), { code: 'ENOENT' }) }
  for (const root of [0, 1, -1, process.pid, 1.5, NaN]) assert.equal(killTree(root, { table: unreadable }), null, String(root))
  const { spawn } = await import('node:child_process')
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    const exited = new Promise(resolve => sleeper.once('exit', (code, signal) => resolve(signal)))
    assert.match(killTree(sleeper.pid, { table: unreadable }), new RegExp(`could not list processes below ${sleeper.pid} \\(ENOENT\\); killed only ${sleeper.pid}`))
    assert.equal(await exited, 'SIGKILL')
  } finally { killStarted(sleeper.pid) }
})

// A fixture body that starts a grandchild, which starts its own child; both record their pids,
// the grandchild records its process group, then the file passes a test and hangs.
const spawnsTreeAndHangs = dir => {
  const great = `const { writeFileSync } = require('node:fs'); writeFileSync(${JSON.stringify(join(dir, 'great.pid'))}, String(process.pid)); setInterval(() => {}, 1000)`
  const grand = `const { spawn } = require('node:child_process'); const { readFileSync, writeFileSync } = require('node:fs')
spawn(process.execPath, ['-e', ${JSON.stringify(great)}], { stdio: 'ignore' })
let group = ''; try { const s = readFileSync('/proc/self/stat', 'utf8'); group = s.slice(s.lastIndexOf(')') + 2).split(' ')[2] } catch {}
writeFileSync(${JSON.stringify(join(dir, 'group'))}, group)
writeFileSync(${JSON.stringify(join(dir, 'grand.pid'))}, String(process.pid))
setInterval(() => {}, 1000)`
  // The file passes its test only once the whole tree is up, so the timeout cannot win the race.
  return `import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], { stdio: 'ignore' })
while (!existsSync(${JSON.stringify(join(dir, 'great.pid'))}) || !existsSync(${JSON.stringify(join(dir, 'grand.pid'))})) await new Promise(r => setTimeout(r, 20))
await test('starts a process tree, then hangs', () => {})
setInterval(() => {}, 1000)`
}

await test('pool: a timeout kills every process below the file, and children stay in the caller\'s process group (bughunt F2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-pool-tree-'))
  let grand = null, great = null
  try {
    const r = await pool({ 'spawns.test.mjs': spawnsTreeAndHangs(dir) }, { fileTimeoutMs: 6000 })
    assert.deepEqual([r.pass, r.fail], [0, 1], r.out)
    assert.match(r.out, /ok {3}starts a process tree, then hangs/, 'the whole tree was up before the timeout')
    assert.match(r.out, /spawns\.test\.mjs still running after 6000 ms/)
    grand = await waitForFile(join(dir, 'grand.pid'))
    great = await waitForFile(join(dir, 'great.pid'))
    assert.equal(await settles(grand), true, `grandchild ${grand} outlived its timed-out file`)
    assert.equal(await settles(great), true, `great-grandchild ${great} outlived its timed-out file`)
    const mine = groupOf(process.pid)
    if (mine !== null) assert.equal(Number(readFileSync(join(dir, 'group'), 'utf8')), mine, 'the test tree ran in the caller\'s process group')
  } finally {
    killStarted(grand); killStarted(great)
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('pool: a child that exits in time is not timed out, even while a grandchild keeps its output open', async () => {
  // After the child exits it has been reaped, so its pid may already belong to another process:
  // the timeout must never fire for it (no kill by a stale pid) and the file is not a timeout.
  // 3000 ms: inside the 5 s pipe grace (so an armed timer would fire), with room for a slow start.
  const dir = mkdtempSync(join(tmpdir(), 'workflow-pool-exited-'))
  const pidFile = join(dir, 'holder.pid')
  const body = `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: ['ignore', 'inherit', 'ignore'] })
writeFileSync(${JSON.stringify(pidFile)}, String(holder.pid))
holder.unref()
await test('passes and exits at once', () => {})`
  let holder = null
  try {
    const r = await pool({ 'exits.test.mjs': body }, { fileTimeoutMs: 3000 })
    holder = await waitForFile(pidFile)
    assert.deepEqual([r.pass, r.fail], [1, 0], r.out)
    assert.doesNotMatch(r.out, /still running/)
    assert.equal(alive(holder), true, 'the pool sent no kill after the child had exited')
  } finally {
    killStarted(holder)
    rmSync(dir, { recursive: true, force: true })
  }
})
