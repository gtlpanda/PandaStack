// test-workflow.mjs — run every graph's workflow tests against scripted agents,
// then check every workflow file loads. Test files: tests/*.test.mjs and
// graphs/<name>/tests/*.test.mjs. Ends with TEST-WORKFLOW: N passed, M failed[, K skipped].
//
// Files run side by side, one child process each (scripts/workflow-pool.mjs), as many at
// once as PANDASTACK_TEST_JOBS (default: the machine's available parallelism). A file still
// running after PANDASTACK_TEST_FILE_TIMEOUT_MS (default 10 minutes) is killed and fails.
// PANDASTACK_TEST_JOBS=1 keeps the original serial run: every file imported, in order,
// into this one process. Use it to bisect an interaction between files.
// AUTOBUILD_SHARD=i/n (set by `autobuild check --shard` on a shardable step) runs only this
// shard's part of the test files; the n parts together are every file, each exactly once.
import { readdirSync, existsSync, realpathSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO, test, load, summary, entryDirs } from './workflow-harness.mjs'
import { DEFAULT_FILE_TIMEOUT_MS, MAX_TIMER_MS, positiveSetting, runPool, shardFiles } from './workflow-pool.mjs'
import { parseShard } from '../graphs/autobuild/tool/lib/shard.mjs'

function testFiles() {
  const graphs = existsSync(join(REPO, 'graphs')) ? readdirSync(join(REPO, 'graphs')).map(g => join('graphs', g)) : []
  return ['', ...graphs]
    .map(d => join(REPO, d, 'tests'))
    .filter(d => existsSync(d))
    .flatMap(d => readdirSync(d).filter(f => f.endsWith('.test.mjs')).map(f => join(d, f)))
}
const relative = f => f.slice(REPO.length + 1)

// Files whose tests assert sub-second wall-clock budgets (a 300 ms expiry, a 100 ms wait, a
// 2300 ms bound). Under a fully loaded machine those budgets can be missed: decision-managed and
// decision-routing each failed once in five 32-job runs. They run first, alone, so the budgets
// are measured on a quiet machine; their thresholds stay as they are.
const ALONE = ['tests/decision-managed.test.mjs', 'tests/decision-routing.test.mjs',
  'tests/native-codex-exec.test.mjs', 'tests/decision-output.test.mjs'].map(f => join(REPO, f))

// Per-file durations from the last run, for longest-first scheduling. logs/ is gitignored;
// a missing or unreadable file only means the pool falls back to ordering by file size.
const TIMINGS = join(REPO, 'logs', 'workflow-timings.json')
function readTimings() {
  try {
    const saved = JSON.parse(readFileSync(TIMINGS, 'utf8'))
    return Object.fromEntries(Object.entries(saved).map(([f, ms]) => [join(REPO, f), ms]))
  } catch { return {} }
}
function saveTimings(timings) {
  try {
    mkdirSync(join(REPO, 'logs'), { recursive: true })
    writeFileSync(TIMINGS, `${JSON.stringify(Object.fromEntries(Object.entries(timings).map(([f, ms]) => [relative(f), ms])), null, 2)}\n`)
  } catch { /* timings are a scheduling hint, never a result */ }
}

// macOS keeps the temp dir under a symlink (/var -> /private/var). The code under test refuses
// symlinked paths or resolves them, by design, so every fixture is made at the real path.
// Children inherit this through the environment.
process.env.TMPDIR = realpathSync(tmpdir())

let jobs, fileTimeoutMs, shard
try {
  shard = parseShard(process.env.AUTOBUILD_SHARD, 'AUTOBUILD_SHARD')
  jobs = positiveSetting('PANDASTACK_TEST_JOBS', process.env.PANDASTACK_TEST_JOBS, availableParallelism())
  fileTimeoutMs = positiveSetting('PANDASTACK_TEST_FILE_TIMEOUT_MS', process.env.PANDASTACK_TEST_FILE_TIMEOUT_MS, DEFAULT_FILE_TIMEOUT_MS, MAX_TIMER_MS)
} catch (e) { console.log(`TEST-WORKFLOW: 0 passed, 1 failed (${e.message})`); process.exit(1) }

const allFiles = testFiles()
await test('at least one workflow test file exists', () => {
  if (!allFiles.length) throw new Error('no tests/*.test.mjs or graphs/*/tests/*.test.mjs found')
})
const files = shard ? shardFiles(allFiles, shard) : allFiles
if (shard) console.log(`== shard ${shard.index}/${shard.count}: ${files.length} of ${allFiles.length} test files`)
let pooled = { pass: 0, fail: 0, skipped: 0 }
if (jobs === 1) {
  for (const f of files) {
    // A file that throws outside test() (bad import, load failure) counts as one failure.
    try { await import(pathToFileURL(f).href) }
    catch (e) { await test(`${relative(f)} loads`, () => { throw e }) }
  }
} else {
  console.log(`== ${files.length} test files, ${jobs} at a time`)
  pooled = await runPool(files, { jobs, cwd: REPO, timings: readTimings(), labelOf: relative, alone: ALONE, fileTimeoutMs })
  saveTimings(pooled.timings)
}

console.log('== every workflow file parses')
for (const d of entryDirs('workflows')) {
  for (const f of readdirSync(d).filter(f => f.endsWith('.js'))) {
    await test(`${join(d, f).slice(REPO.length + 1)} parses with a pure-literal meta`, () => { load(join(d, f)) })
  }
}

const own = summary()
const pass = own.pass + pooled.pass, fail = own.fail + pooled.fail, skipped = own.skipped + pooled.skipped
console.log(`\nTEST-WORKFLOW: ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`)
process.exit(fail === 0 ? 0 : 1)
