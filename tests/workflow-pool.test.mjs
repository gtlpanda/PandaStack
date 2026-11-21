// The parallel workflow runner (scripts/workflow-pool.mjs, scripts/workflow-file-runner.mjs):
// counting, failure accounting and output order, on tiny fixture test files in a temp dir.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO, test } from '../scripts/workflow-harness.mjs'
import { jobsFrom, scheduleOrder, settle, runPool } from '../scripts/workflow-pool.mjs'

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

await test('pool: every child gets a private AUTOBUILD_STATE_HOME and the caller\'s other variables', async () => {
  const body = "await test('env', () => { if (!process.env.AUTOBUILD_STATE_HOME?.includes('workflow-tests-state-')) throw new Error('state home ' + process.env.AUTOBUILD_STATE_HOME); if (process.env.POOL_PROBE !== 'kept') throw new Error('probe lost') })"
  const r = await pool({ 'env.test.mjs': body }, { env: { ...process.env, AUTOBUILD_STATE_HOME: '/should/not/be/used', POOL_PROBE: 'kept' } })
  assert.deepEqual([r.pass, r.fail], [1, 0], r.out)
})

await test('jobsFrom: only a positive integer is accepted; unset means the default', () => {
  assert.equal(jobsFrom(undefined, 8), 8)
  assert.equal(jobsFrom('', 8), 8)
  assert.equal(jobsFrom('1', 8), 1)
  assert.equal(jobsFrom('12', 8), 12)
  for (const bad of ['0', '-2', '1.5', ' 3', '3 ', 'four', '07', '1e2']) assert.throws(() => jobsFrom(bad, 8), /positive integer/, bad)
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
appendFileSync(${JSON.stringify(log)}, '${name} start ' + (performance.timeOrigin + performance.now()) + '\\n')
await new Promise(r => setTimeout(r, 150))
appendFileSync(${JSON.stringify(log)}, '${name} end ' + (performance.timeOrigin + performance.now()) + '\\n')
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
