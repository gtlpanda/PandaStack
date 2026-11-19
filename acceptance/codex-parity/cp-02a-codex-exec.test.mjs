// CP-02a frozen acceptance: shared Codex exec launcher
// (spec/contracts/codex-parity-cp-02a.md). Wiring proof, not runtime
// certification: no real codex, no network, no HOME dependence. Children are
// stub executables (a tiny node script) created in an owned temp directory,
// and every run passes a minimal explicit environment.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const loadExec = () => import(pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/codex-exec.mjs')))
const loadAutobuild = () => import(pathToFileURL(resolve(ROOT, 'graphs/autobuild/tool/lib/codex.mjs')))
const loadHunt = () => import(pathToFileURL(resolve(ROOT, 'graphs/hunt/skills/bughunt/native-runner.mjs')))

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const FIXED_CODES = ['PROVIDER_REFUSAL', 'USAGE_LIMIT', 'AUTH', 'BILLING', 'TURN_FAILED', 'EXIT_NONZERO', 'TIMEOUT', 'NO_OUTPUT', 'SUCCESS']

// ---------------------------------------------------------------- args parity
const VALUE_FLAGS = ['--color', '--sandbox', '--model', '--output-schema', '--output-last-message']
const FIXED_CONFIG_KEY = /^(approval_policy|model_reasoning_effort)=/

// The flag subset every transport must agree on, as an order-free list. The two
// existing builders order the output flags differently, so order is not pinned.
function fixedSubset(argv) {
  const found = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--json') found.push(token)
    else if (VALUE_FLAGS.includes(token)) found.push(`${token} ${argv[++i]}`)
    else if (token === '-c') { const value = argv[++i]; if (FIXED_CONFIG_KEY.test(value)) found.push(`-c ${value}`) }
  }
  return found.sort()
}
const configValues = (argv, prefix) => argv.flatMap((t, i) => t === '-c' && argv[i + 1].startsWith(prefix) ? [argv[i + 1]] : [])

const AB_CONFIG = {
  root: '/repo', evidenceDir: '/repo/.autobuild/evidence', frozen: ['spec/'], writable: [], deliveryMode: 'full',
  model: 'model-main', probeModel: 'model-probe', subagentModel: 'model-sub', maxConcurrentSubagents: 3,
  codex: { reasoningEffort: 'medium' },
}
const HUNT_CONFIG = { model: 'model-main', subagentModel: 'model-sub', codex: { reasoningEffort: 'medium' } }
const FILES = { outputFile: '/t/out.json', schemaFile: '/t/schema.json' }

describe('CP-02a args builder (wiring proof, not runtime certification)', () => {
  const autobuildRows = [
    { name: 'builder with output and schema files', options: { role: 'builder', ...FILES },
      shared: { sandbox: 'workspace-write', model: 'model-main', reasoningEffort: 'medium', ...FILES } },
    { name: 'builder without files', options: { role: 'builder' },
      shared: { sandbox: 'workspace-write', model: 'model-main', reasoningEffort: 'medium' } },
    { name: 'probe (read-only, probe model, high effort)', options: { role: 'probe' },
      shared: { sandbox: 'read-only', model: 'model-probe', reasoningEffort: 'high' } },
  ]
  for (const row of autobuildRows) {
    test(`fixed flag subset equals autobuild codexArgs: ${row.name}`, async () => {
      const { codexExecArgs } = await loadExec()
      const { codexArgs } = await loadAutobuild()
      const theirs = codexArgs(AB_CONFIG, { prompt: 'p', ...row.options }).args
      const ours = codexExecArgs({ ...row.shared, subagentModel: 'model-sub', maxConcurrentSubagents: 3 })
      assert.deepEqual(fixedSubset(ours), fixedSubset(theirs))
      assert.deepEqual(configValues(ours, 'agents.'), configValues(theirs, 'agents.'))
      assert.ok(!theirs.includes('--skip-git-repo-check') && !ours.includes('--skip-git-repo-check'))
    })
  }

  const huntRows = [
    { agentType: 'hunter', sandbox: 'read-only', model: 'model-sub' },
    { agentType: 'advisor', sandbox: 'read-only', model: 'model-main' },
    { agentType: 'reproducer', sandbox: 'workspace-write', model: 'model-sub' },
    { agentType: 'repairer', sandbox: 'workspace-write', model: 'model-sub' },
    { agentType: 'fix-verifier', sandbox: 'workspace-write', model: 'model-sub' },
  ]
  for (const row of huntRows) {
    test(`fixed flag subset equals hunt nativeLeafArgs: ${row.agentType}`, async () => {
      const { codexExecArgs } = await loadExec()
      const { nativeLeafArgs } = await loadHunt()
      const theirs = nativeLeafArgs(HUNT_CONFIG, { agentType: row.agentType, model: 'unused', label: `x: ${row.agentType}` },
        { schema: FILES.schemaFile, output: FILES.outputFile })
      const ours = codexExecArgs({ sandbox: row.sandbox, model: row.model, reasoningEffort: 'medium', skipGitRepoCheck: true, ...FILES })
      assert.deepEqual(fixedSubset(ours), fixedSubset(theirs))
      assert.ok(theirs.includes('--skip-git-repo-check') && ours.includes('--skip-git-repo-check'))
    })
  }

  test('shape: exec first, stdin marker last, --ignore-user-config exactly once, quoted approval policy', async () => {
    const { codexExecArgs } = await loadExec()
    for (const options of [
      { sandbox: 'read-only', model: 'm', reasoningEffort: 'low' },
      { sandbox: 'workspace-write', model: 'm', reasoningEffort: 'high', skipGitRepoCheck: true, ...FILES, subagentModel: 's', maxConcurrentSubagents: 2 },
    ]) {
      const args = codexExecArgs(options)
      assert.ok(Array.isArray(args) && args.every(a => typeof a === 'string'))
      assert.equal(args[0], 'exec')
      assert.equal(args.at(-1), '-')
      assert.equal(args.filter(a => a === '--ignore-user-config').length, 1)
      assert.ok(args.includes('approval_policy="never"'))
      assert.equal(args.includes('--skip-git-repo-check'), options.skipGitRepoCheck === true)
      assert.equal(args.includes('--output-schema'), 'schemaFile' in options)
      assert.equal(args.includes('--output-last-message'), 'outputFile' in options)
    }
  })

  test('--ignore-user-config has no off switch', async () => {
    const { codexExecArgs } = await loadExec()
    const args = codexExecArgs({ sandbox: 'read-only', model: 'm', reasoningEffort: 'low', ignoreUserConfig: false })
    assert.ok(args.includes('--ignore-user-config'))
  })

  const badInputs = [
    ['no argument', undefined],
    ['sandbox outside the closed set', { sandbox: 'danger-full-access', model: 'm', reasoningEffort: 'low' }],
    ['missing sandbox', { model: 'm', reasoningEffort: 'low' }],
    ['empty model', { sandbox: 'read-only', model: '', reasoningEffort: 'low' }],
    ['model with a newline', { sandbox: 'read-only', model: "m'\nx", reasoningEffort: 'low' }],
    ['empty effort', { sandbox: 'read-only', model: 'm', reasoningEffort: '' }],
    ['subagent model with a space', { sandbox: 'read-only', model: 'm', reasoningEffort: 'low', subagentModel: 'a b' }],
    ['zero concurrency', { sandbox: 'read-only', model: 'm', reasoningEffort: 'low', maxConcurrentSubagents: 0 }],
    ['non-string output file', { sandbox: 'read-only', model: 'm', reasoningEffort: 'low', outputFile: 5 }],
  ]
  for (const [name, input] of badInputs) {
    test(`rejects ${name} with INVALID_CODEX_EXEC_INPUT`, async () => {
      const { codexExecArgs } = await loadExec()
      assert.throws(() => codexExecArgs(input), error => error.code === 'INVALID_CODEX_EXEC_INPUT')
    })
  }
})

// ------------------------------------------------------------- stub processes
// Behavior is chosen by STUB_* environment variables:
//   STUB_MODE  complete | fail | exit0 | early-exit | hang
//   STUB_TRAP=1        record SIGTERM in `term` and keep running
//   STUB_DESCENDANT=1  spawn a same-group descendant that ignores SIGTERM
const STUB_SOURCE = `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path')
const dir = process.env.STUB_DIR
const put = (name, text) => fs.writeFileSync(path.join(dir, name), String(text))
const line = event => process.stdout.write(JSON.stringify(event) + '\\n')
if (process.env.STUB_TRAP === '1') process.on('SIGTERM', () => put('term', '1'))
put('pid', process.pid)
put('argv.json', JSON.stringify(process.argv.slice(2)))
put('env.json', JSON.stringify({ thread: process.env.CODEX_THREAD_ID ?? null, mark: process.env.STUB_MARK ?? null }))
if (process.env.STUB_DESCENDANT === '1') {
  const child = cp.spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' })
  child.unref()
  put('descendant.pid', child.pid)
}
const mode = process.env.STUB_MODE
let input = ''
const afterInput = work => { process.stdin.on('data', c => { input += c }); process.stdin.on('end', () => { put('stdin', input); work() }) }
if (mode === 'complete') afterInput(() => { line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }); process.exit(0) })
else if (mode === 'fail') afterInput(() => { line({ type: 'turn.failed', error: { message: 'stub failure' } }); process.exit(1) })
else if (mode === 'exit0') process.exit(0)
else if (mode === 'early-exit') process.exit(3)
else if (mode === 'hang') { setInterval(() => {}, 1000); put('ready', '1') }
else process.exit(9)
`

let WORK, STUB
before(() => {
  WORK = mkdtempSync(join(tmpdir(), 'cp-02a-'))
  STUB = join(WORK, 'codex-stub')
  writeFileSync(STUB, STUB_SOURCE)
  chmodSync(STUB, 0o755)
})
after(() => rmSync(WORK, { recursive: true, force: true }))

const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function until(check, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (check()) return true
  return check()
}
const read = (dir, name) => readFileSync(join(dir, name), 'utf8')
const pidOf = (dir, name) => Number(read(dir, name))

// Run the shared launcher on the stub. `stub` selects the stub's behavior,
// `run` overrides launcher options, `env` adds child environment variables.
async function launch({ stub = {}, run = {}, env = {} } = {}) {
  const { runCodexExec } = await loadExec()
  const dir = mkdtempSync(join(WORK, 'run-'))
  const logFile = join(dir, 'log.jsonl')
  const childEnv = { STUB_DIR: dir, STUB_MARK: 'kept', ...Object.fromEntries(Object.entries(stub).map(([k, v]) => [`STUB_${k}`, v])), ...env }
  const began = Date.now()
  const exitCode = await runCodexExec(STUB, ['exec', '-'], { cwd: dir, env: childEnv, input: 'hello prompt', logFile,
    timeoutMs: 30_000, graceMs: 200, ...run })
  return { dir, logFile, exitCode, elapsed: Date.now() - began, childEnv }
}

describe('CP-02a launcher on stub executables (wiring proof, not runtime certification)', () => {
  test('test helper can see a live process die', async () => {
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    assert.equal(alive(sleeper.pid), true)
    sleeper.kill('SIGKILL')
    assert.equal(await until(() => !alive(sleeper.pid)), true)
  })

  test('exit 0: returns the child exit code, delivers stdin, writes private logs', async () => {
    const run = await launch({ stub: { MODE: 'complete' } })
    assert.equal(run.exitCode, 0)
    assert.equal(read(run.dir, 'stdin'), 'hello prompt')
    assert.deepEqual(JSON.parse(read(run.dir, 'argv.json')), ['exec', '-'])
    assert.match(readFileSync(run.logFile, 'utf8'), /"type":"turn\.completed"/)
    assert.equal(existsSync(`${run.logFile}.stderr`), true)
    for (const file of [run.logFile, `${run.logFile}.stderr`]) assert.equal(statSync(file).mode & 0o077, 0, `${file} is private`)
  })

  test('nonzero exit is returned unchanged', async () => {
    const run = await launch({ stub: { MODE: 'fail' } })
    assert.equal(run.exitCode, 1)
    assert.match(readFileSync(run.logFile, 'utf8'), /"type":"turn\.failed"/)
  })

  test('a child that exits before reading stdin does not reject the run', async () => {
    const { runCodexExec } = await loadExec()
    const dir = mkdtempSync(join(WORK, 'run-'))
    const exitCode = await runCodexExec(STUB, ['exec', '-'], { cwd: dir, env: { STUB_DIR: dir, STUB_MODE: 'early-exit' },
      input: 'x'.repeat(4 * 1024 * 1024), logFile: join(dir, 'log.jsonl'), timeoutMs: 30_000, graceMs: 200 })
    assert.equal(exitCode, 3)
  })

  test('a missing executable gives 127', async () => {
    const { runCodexExec } = await loadExec()
    const dir = mkdtempSync(join(WORK, 'run-'))
    const exitCode = await runCodexExec(join(dir, 'no-such-codex'), ['exec', '-'], { cwd: dir, env: {},
      logFile: join(dir, 'log.jsonl'), timeoutMs: 30_000, graceMs: 200 })
    assert.equal(exitCode, 127)
  })

  test('timeout gives 124 and the whole group is dead within the bound', async () => {
    const run = await launch({ stub: { MODE: 'hang', TRAP: '0' }, run: { timeoutMs: 600 } })
    assert.equal(run.exitCode, 124)
    assert.ok(run.elapsed >= 550, `returned before the deadline: ${run.elapsed}ms`)
    assert.ok(run.elapsed < 600 + 200 + 3000, `took ${run.elapsed}ms`)
    const pid = pidOf(run.dir, 'pid')
    assert.equal(await until(() => !alive(pid) && !alive(-pid)), true, 'stub process group still alive')
  })

  test('a child that ignores SIGTERM is killed with SIGKILL only after the grace period', async () => {
    const run = await launch({ stub: { MODE: 'hang', TRAP: '1' }, run: { timeoutMs: 1000, graceMs: 400 } })
    assert.equal(run.exitCode, 124)
    assert.equal(read(run.dir, 'term'), '1', 'the child was sent SIGTERM first')
    assert.ok(run.elapsed >= 1000 + 400 - 20, `SIGKILL came before the grace period ended: ${run.elapsed}ms`)
    const pid = pidOf(run.dir, 'pid')
    assert.equal(await until(() => !alive(pid) && !alive(-pid)), true)
  })

  test('no descendant survives a timeout, even one that ignores SIGTERM', async () => {
    const run = await launch({ stub: { MODE: 'hang', TRAP: '1', DESCENDANT: '1' }, run: { timeoutMs: 1000, graceMs: 300 } })
    assert.equal(run.exitCode, 124)
    const child = pidOf(run.dir, 'descendant.pid')
    assert.notEqual(child, pidOf(run.dir, 'pid'))
    assert.equal(await until(() => !alive(child)), true, 'descendant survived the timeout')
    assert.equal(alive(-pidOf(run.dir, 'pid')), false, 'process group survived the timeout')
  })

  test('no descendant survives a child that exits normally and leaves it behind', async () => {
    const run = await launch({ stub: { MODE: 'exit0', DESCENDANT: '1' } })
    assert.equal(run.exitCode, 0)
    const child = pidOf(run.dir, 'descendant.pid')
    assert.equal(await until(() => !alive(child)), true, 'orphaned descendant survived')
  })

  test('abort gives 130 and kills the group', async () => {
    const controller = new AbortController()
    const { runCodexExec } = await loadExec()
    const dir = mkdtempSync(join(WORK, 'run-'))
    const running = runCodexExec(STUB, ['exec', '-'], { cwd: dir,
      env: { STUB_DIR: dir, STUB_MODE: 'hang', STUB_TRAP: '1', STUB_DESCENDANT: '1' },
      logFile: join(dir, 'log.jsonl'), timeoutMs: 60_000, graceMs: 300, signal: controller.signal })
    assert.equal(await until(() => existsSync(join(dir, 'ready')) && existsSync(join(dir, 'descendant.pid')), 5000), true, 'stub never started')
    const began = Date.now()
    controller.abort()
    assert.equal(await running, 130)
    assert.ok(Date.now() - began < 300 + 3000)
    const pid = pidOf(dir, 'pid'), child = pidOf(dir, 'descendant.pid')
    assert.equal(await until(() => !alive(pid) && !alive(child) && !alive(-pid)), true)
  })

  test('an already-aborted signal gives 130 without starting a process', async () => {
    const run = await launch({ stub: { MODE: 'complete' }, run: { signal: AbortSignal.abort() } })
    assert.equal(run.exitCode, 130)
    assert.equal(existsSync(join(run.dir, 'pid')), false)
  })

  test('CODEX_THREAD_ID is removed from the child environment; other variables and the caller env are kept', async () => {
    const env = { CODEX_THREAD_ID: 'parent-thread' }
    const run = await launch({ stub: { MODE: 'exit0' }, env })
    assert.deepEqual(JSON.parse(read(run.dir, 'env.json')), { thread: null, mark: 'kept' })
    assert.equal(env.CODEX_THREAD_ID, 'parent-thread')
    assert.equal(run.childEnv.CODEX_THREAD_ID, 'parent-thread')
  })

  const badRuns = [
    ['missing logFile', { logFile: undefined }],
    ['zero timeout', { timeoutMs: 0 }],
    ['fractional timeout', { timeoutMs: 1.5 }],
    ['negative grace', { graceMs: -1 }],
    ['missing env', { env: undefined }],
    ['missing cwd', { cwd: undefined }],
    ['signal that is not an AbortSignal', { signal: 'stop' }],
  ]
  for (const [name, patch] of badRuns) {
    test(`rejects ${name} with INVALID_CODEX_EXEC_INPUT before starting a process`, async () => {
      const { runCodexExec } = await loadExec()
      const dir = mkdtempSync(join(WORK, 'run-'))
      const options = { cwd: dir, env: { STUB_DIR: dir, STUB_MODE: 'complete' }, logFile: join(dir, 'log.jsonl'), timeoutMs: 1000, graceMs: 100, ...patch }
      await assert.rejects(runCodexExec(STUB, ['exec', '-'], options), error => error.code === 'INVALID_CODEX_EXEC_INPUT')
      assert.equal(existsSync(join(dir, 'pid')), false)
    })
  }
  test('rejects non-array args', async () => {
    const { runCodexExec } = await loadExec()
    const dir = mkdtempSync(join(WORK, 'run-'))
    await assert.rejects(runCodexExec(STUB, 'exec', { cwd: dir, env: {}, logFile: join(dir, 'l'), timeoutMs: 1000 }),
      error => error.code === 'INVALID_CODEX_EXEC_INPUT')
  })
})

// -------------------------------------------------------------- classification
const REFUSAL = 'This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing.'
const events = (...list) => list.map(e => JSON.stringify(e)).join('\n') + '\n'
const COMPLETED = { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
const failed = message => ({ type: 'turn.failed', error: { message } })

// log: JSONL text, or null for "no log file at all".
const CASES = [
  { name: 'turn.completed and exit 0', exitCode: 0, log: events(COMPLETED), code: 'SUCCESS', ok: true, retryable: false },
  { name: 'tool output that looks like an auth error is not an auth error', exitCode: 0,
    log: events({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: '401 Unauthorized' } }, COMPLETED), code: 'SUCCESS', ok: true, retryable: false },
  { name: 'refusal on an error event', exitCode: 1, log: events({ type: 'error', message: REFUSAL }, failed(REFUSAL)), code: 'PROVIDER_REFUSAL', retryable: false },
  { name: 'refusal on turn.failed alone', exitCode: 1, log: events(failed(REFUSAL)), code: 'PROVIDER_REFUSAL', retryable: false },
  { name: 'refusal still wins when the run also timed out', exitCode: 124, log: events(failed(REFUSAL)), code: 'PROVIDER_REFUSAL', retryable: false },
  { name: 'refusal text inside an assistant message is not a refusal', exitCode: 0,
    log: events({ type: 'item.completed', item: { type: 'agent_message', text: REFUSAL } }, COMPLETED), code: 'SUCCESS', ok: true, retryable: false },
  { name: 'usage limit message', exitCode: 1, log: events(failed("You've hit your usage limit. Try again later.")), code: 'USAGE_LIMIT', retryable: true },
  { name: 'auth failure message', exitCode: 1, log: events({ type: 'error', message: '401 Unauthorized' }), code: 'AUTH', retryable: true },
  { name: 'billing message', exitCode: 1, log: events(failed('Your credit balance is too low to run this request.')), code: 'BILLING', retryable: false },
  { name: 'turn.failed with a plain message and exit 1', exitCode: 1, log: events(failed('stub failure')), code: 'TURN_FAILED', retryable: true },
  { name: 'turn.failed even when the process exited 0', exitCode: 0, log: events(failed('stub failure')), code: 'TURN_FAILED', retryable: true },
  { name: 'error event without a message', exitCode: 1, log: events({ type: 'error' }), code: 'TURN_FAILED', retryable: true },
  { name: 'turn.completed but a nonzero exit', exitCode: 2, log: events(COMPLETED), code: 'EXIT_NONZERO', retryable: true },
  { name: 'nonzero exit with an empty log', exitCode: 1, log: '', code: 'EXIT_NONZERO', retryable: true },
  { name: 'nonzero exit with no log file', exitCode: 1, log: null, code: 'EXIT_NONZERO', retryable: true },
  { name: 'spawn failure (127)', exitCode: 127, log: '', code: 'EXIT_NONZERO', retryable: true },
  { name: 'abort (130) has no code of its own', exitCode: 130, log: '', code: 'EXIT_NONZERO', retryable: true },
  { name: 'timeout (124) with an empty log', exitCode: 124, log: '', code: 'TIMEOUT', retryable: true },
  { name: 'timeout (124) even after a turn.completed', exitCode: 124, log: events(COMPLETED), code: 'TIMEOUT', retryable: true },
  { name: 'exit 0 with an empty log', exitCode: 0, log: '', code: 'NO_OUTPUT', retryable: true },
  { name: 'exit 0 with no log file', exitCode: 0, log: null, code: 'NO_OUTPUT', retryable: true },
  { name: 'exit 0 with only unrelated and malformed lines', exitCode: 0,
    log: 'not json\n[1,2]\n' + events({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }), code: 'NO_OUTPUT', retryable: true },
]

describe('CP-02a classification (wiring proof, not runtime certification)', () => {
  for (const row of CASES) {
    test(`${row.code}: ${row.name}`, async () => {
      const { classifyCodexExec, CODEX_EXEC_CODES } = await loadExec()
      const dir = mkdtempSync(join(WORK, 'class-'))
      const logFile = join(dir, 'log.jsonl')
      if (row.log !== null) writeFileSync(logFile, row.log)
      const result = classifyCodexExec({ exitCode: row.exitCode, logFile })
      assert.equal(result.code, row.code)
      assert.equal(result.ok, row.ok === true)
      assert.equal(result.retryable, row.retryable)
      assert.equal(result.exitCode, row.exitCode)
      assert.equal(typeof result.message, 'string')
      assert.match(result.code, CODE_PATTERN)
      assert.ok(Object.values(CODEX_EXEC_CODES).includes(result.code))
    })
  }

  test('the closed code set is exactly the eight failure codes plus SUCCESS', async () => {
    const { CODEX_EXEC_CODES } = await loadExec()
    assert.deepEqual(Object.keys(CODEX_EXEC_CODES).sort(), [...FIXED_CODES].sort())
    for (const [key, value] of Object.entries(CODEX_EXEC_CODES)) { assert.equal(value, key); assert.match(value, CODE_PATTERN) }
    assert.throws(() => { CODEX_EXEC_CODES.EXTRA = 'EXTRA' })
  })

  test('a refusal carries the protocol receipt and a fixed message, not provider text', async () => {
    const { classifyCodexExec } = await loadExec()
    const dir = mkdtempSync(join(WORK, 'class-'))
    const logFile = join(dir, 'log.jsonl')
    writeFileSync(logFile, events({ type: 'error', message: REFUSAL + ' SECRET-DETAIL' }))
    const result = classifyCodexExec({ exitCode: 1, logFile })
    assert.equal(result.result.providerRefusal.retryable, false)
    assert.equal(result.result.providerRefusal.line, 1)
    assert.ok(!result.message.includes('SECRET-DETAIL'))
  })

  const badClassify = [
    ['string exit code', { exitCode: '0' }],
    ['null exit code', { exitCode: null }],
    ['fractional exit code', { exitCode: 0.5 }],
    ['missing logFile', { logFile: undefined }],
    ['no argument', undefined],
  ]
  for (const [name, patch] of badClassify) {
    test(`rejects ${name} with INVALID_CODEX_EXEC_INPUT`, async () => {
      const { classifyCodexExec } = await loadExec()
      const input = patch === undefined ? undefined : { exitCode: 0, logFile: join(WORK, 'x.jsonl'), ...patch }
      assert.throws(() => classifyCodexExec(input), error => error.code === 'INVALID_CODEX_EXEC_INPUT')
    })
  }

  test('end to end on stubs: run then classify', async () => {
    const { classifyCodexExec } = await loadExec()
    const cases = [
      [{ stub: { MODE: 'complete' } }, 'SUCCESS'],
      [{ stub: { MODE: 'fail' } }, 'TURN_FAILED'],
      [{ stub: { MODE: 'hang', TRAP: '0' }, run: { timeoutMs: 400 } }, 'TIMEOUT'],
      [{ stub: { MODE: 'exit0' } }, 'NO_OUTPUT'],
      [{ stub: { MODE: 'early-exit' } }, 'EXIT_NONZERO'],
    ]
    for (const [options, code] of cases) {
      const run = await launch(options)
      assert.equal(classifyCodexExec({ exitCode: run.exitCode, logFile: run.logFile }).code, code, JSON.stringify(options))
    }
  })
})
