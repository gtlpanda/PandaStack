// CP-02a implementation edges the frozen acceptance does not pin: input rules on
// every option, defaults, first-reason-wins, log modes, signal exits, message
// bounds and fail-closed log reads. Children are `node -e` scripts with a minimal
// explicit environment: wiring proof, not runtime certification.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'

const api = () => import('../core/skills/native-runtime/codex-exec.mjs')
const coded = error => error.code === 'INVALID_CODEX_EXEC_INPUT'
const NODE = process.execPath
const BASE = { sandbox: 'read-only', model: 'm', reasoningEffort: 'low' }
const WORK = mkdtempSync(join(tmpdir(), 'native-codex-exec-'))
const runDir = () => mkdtempSync(join(WORK, 'run-'))
const after = (args, flag) => args[args.indexOf(flag) + 1]

// Runs `node -e script` through the launcher; `run` overrides launcher options.
async function runScript(script, run = {}) {
  const { runCodexExec } = await api()
  const dir = runDir()
  const logFile = join(dir, 'log.jsonl')
  const began = Date.now()
  const exitCode = await runCodexExec(NODE, ['-e', script], { cwd: dir, env: { OUT: dir }, logFile, timeoutMs: 30_000, graceMs: 100, ...run })
  return { dir, logFile, exitCode, elapsed: Date.now() - began }
}

try {
  await test('args: optional values land after their flags, JSON-quoted where config', async () => {
    const { codexExecArgs } = await api()
    const args = codexExecArgs({ ...BASE, subagentModel: 'sub/x:1', maxConcurrentSubagents: 4, outputFile: '/o', schemaFile: '/s' })
    assert.equal(after(args, '--output-last-message'), '/o')
    assert.equal(after(args, '--output-schema'), '/s')
    assert.ok(args.includes('agents.default_subagent_model="sub/x:1"'))
    assert.ok(args.includes('agents.max_concurrent_threads_per_session=4'))
    assert.ok(args.includes('model_reasoning_effort="low"'))
    assert.equal(after(args, '--sandbox'), 'read-only')
    const bare = codexExecArgs(BASE)
    assert.ok(!bare.some(arg => arg.startsWith('agents.')), 'agents.* only when asked for')
    assert.equal(bare.filter(arg => arg === '--ignore-user-config').length, 1)
  })

  await test('args: unknown keys are ignored, null-prototype options accepted', async () => {
    const { codexExecArgs } = await api()
    assert.deepEqual(codexExecArgs({ ...BASE, extra: 'x', sandboxOverride: 'danger-full-access' }), codexExecArgs(BASE))
    assert.deepEqual(codexExecArgs(Object.assign(Object.create(null), BASE)), codexExecArgs(BASE))
  })

  await test('args: hooks, odd shapes and near-miss values are rejected without running a getter', async () => {
    const { codexExecArgs } = await api()
    let ran = false
    const getter = Object.defineProperty({ ...BASE }, 'model', { get() { ran = true; return 'm' }, enumerable: true })
    const rejected = [getter, new Proxy({ ...BASE }, {}), [BASE], 'read-only', null, Object.assign(new (class Options {})(), BASE),
      { ...BASE, model: '-m' }, { ...BASE, model: 'm ' }, { ...BASE, reasoningEffort: 'High' }, { ...BASE, reasoningEffort: 3 },
      { ...BASE, maxConcurrentSubagents: 1.5 }, { ...BASE, maxConcurrentSubagents: '2' }, { ...BASE, skipGitRepoCheck: 'yes' },
      { ...BASE, outputFile: '' }, { ...BASE, schemaFile: null }, { ...BASE, schemaFile: 'a\0b' }, { ...BASE, sandbox: 'Read-Only' }]
    for (const input of rejected) assert.throws(() => codexExecArgs(input), error => coded(error) && !error.message.includes('Read-Only'))
    assert.equal(ran, false)
  })

  await test('run: input defaults to empty stdin; graceMs defaults and 0 are accepted', async () => {
    const run = await runScript("let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{require('fs').writeFileSync(process.env.OUT+'/in',s)})", { graceMs: undefined })
    assert.equal(run.exitCode, 0)
    assert.equal(readFileSync(join(run.dir, 'in'), 'utf8'), '')
    const zero = await runScript("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", { timeoutMs: 300, graceMs: 0 })
    assert.equal(zero.exitCode, 124)
    assert.ok(zero.elapsed < 300 + 2000, `took ${zero.elapsed}ms`)
  })

  await test('run: timeoutMs and graceMs above the 2^31-1 ms timer limit do not fire early', async () => {
    const quick = await runScript("setTimeout(()=>{},300)", { timeoutMs: 2 ** 31, graceMs: Number.MAX_SAFE_INTEGER })
    assert.equal(quick.exitCode, 0)
    // SIGTERM is ignored, so only a premature SIGKILL could end this run before the abort's grace.
    const pidFile = join(WORK, 'overflow.pid')
    const controller = new AbortController()
    const running = runScript(`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
      { timeoutMs: Number.MAX_SAFE_INTEGER, graceMs: 2 ** 31, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    const raced = await Promise.race([running, new Promise(done => setTimeout(() => done('still running'), 900))])
    assert.equal(raced, 'still running', 'a timer above the 2^31-1 ms limit fired at once')
    // End the child directly; its exit then resolves the run as an abort.
    process.kill(-Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
    assert.equal((await running).exitCode, 130)
  })

  await test('run: a child that dies on a signal gives 1; a nonexistent cwd gives 127', async () => {
    const run = await runScript("process.kill(process.pid,'SIGKILL')")
    assert.equal(run.exitCode, 1)
    const { runCodexExec } = await api()
    const dir = runDir()
    const exitCode = await runCodexExec(NODE, ['-e', ''], { cwd: join(dir, 'missing'), env: {}, logFile: join(dir, 'log'), timeoutMs: 5000 })
    assert.equal(exitCode, 127)
  })

  await test('run: the first reason wins between timeout and abort', async () => {
    const hang = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
    const late = new AbortController()
    const timedOut = runScript(hang, { timeoutMs: 200, graceMs: 400, signal: late.signal })
    setTimeout(() => late.abort(), 350)
    assert.equal((await timedOut).exitCode, 124)
    const early = new AbortController()
    const aborted = runScript(hang, { timeoutMs: 400, graceMs: 400, signal: early.signal })
    setTimeout(() => early.abort(), 150)
    assert.equal((await aborted).exitCode, 130)
  })

  await test('run: logs are forced to 0600 even when they already existed', async () => {
    const { runCodexExec } = await api()
    const dir = runDir()
    const logFile = join(dir, 'log.jsonl')
    for (const file of [logFile, `${logFile}.stderr`]) { writeFileSync(file, 'old'); chmodSync(file, 0o644) }
    const exitCode = await runCodexExec(NODE, ['-e', "console.log('out');console.error('err')"], { cwd: dir, env: {}, logFile, timeoutMs: 5000 })
    assert.equal(exitCode, 0)
    assert.equal(readFileSync(logFile, 'utf8'), 'out\n')
    assert.equal(readFileSync(`${logFile}.stderr`, 'utf8'), 'err\n')
    for (const file of [logFile, `${logFile}.stderr`]) assert.equal(statSync(file).mode & 0o777, 0o600)
  })

  await test('run: invalid input and an already-aborted signal create no log file', async () => {
    const { runCodexExec } = await api()
    let ran = false
    const getterEnv = Object.defineProperty({}, 'A', { get() { ran = true; return 'x' }, enumerable: true })
    const patches = [{ env: getterEnv }, { env: new Proxy({}, {}) }, { env: [] }, { input: 5 }, { cwd: '' }, { logFile: '' },
      { timeoutMs: Number.MAX_SAFE_INTEGER + 1 }, { graceMs: 0.5 }, { signal: { aborted: false } }]
    for (const patch of patches) {
      const dir = runDir()
      const options = { cwd: dir, env: {}, logFile: join(dir, 'log'), timeoutMs: 5000, ...patch }
      await assert.rejects(runCodexExec(NODE, ['-e', ''], options), coded)
      assert.equal(existsSync(join(dir, 'log')), false)
    }
    for (const [bin, args] of [[5, []], ['', []], [NODE, [5]], [NODE, ['a\0b']], [NODE, null]]) {
      const dir = runDir()
      await assert.rejects(runCodexExec(bin, args, { cwd: dir, env: {}, logFile: join(dir, 'log'), timeoutMs: 5000 }), coded)
      assert.equal(existsSync(join(dir, 'log')), false)
    }
    assert.equal(ran, false)
    const dir = runDir()
    assert.equal(await runCodexExec(NODE, ['-e', ''], { cwd: dir, env: {}, logFile: join(dir, 'log'), timeoutMs: 5000, signal: AbortSignal.abort() }), 130)
    assert.equal(existsSync(join(dir, 'log')), false)
  })

  await test('run: an unopenable log rejects with the file error and starts nothing', async () => {
    const { runCodexExec } = await api()
    const dir = runDir()
    await assert.rejects(runCodexExec(NODE, ['-e', "require('fs').writeFileSync(process.env.OUT+'/ran','1')"],
      { cwd: dir, env: { OUT: dir }, logFile: join(dir, 'no-dir', 'log'), timeoutMs: 5000 }), error => error.code === 'ENOENT')
    assert.equal(existsSync(join(dir, 'ran')), false)
  })

  const events = (...list) => list.map(event => JSON.stringify(event)).join('\n') + '\n'
  const classifyLog = async (exitCode, log) => {
    const { classifyCodexExec } = await api()
    const logFile = join(runDir(), 'log.jsonl')
    writeFileSync(logFile, log)
    return classifyCodexExec({ exitCode, logFile, extra: 'ignored' })
  }

  await test('classify: provider text in a message is bounded to one line of 300 characters', async () => {
    const long = `first\nsecond\u001b[31m${'x'.repeat(1000)}`
    const failed = await classifyLog(1, events({ type: 'turn.failed', error: { message: long } }))
    assert.equal(failed.code, 'TURN_FAILED')
    assert.equal(failed.message.length, 300)
    assert.ok(!/[\x00-\x1f]/.test(failed.message))
    assert.equal(failed.result.result, long, 'the raw protocol result is still available to the caller')
    const limit = await classifyLog(1, events({ type: 'error', message: `You've hit your usage limit · resets 3:45pm\n${'y'.repeat(900)}` }))
    assert.equal(limit.code, 'USAGE_LIMIT')
    assert.ok(limit.message.length <= 300 && limit.message.includes('resets 3:45pm'))
    const ok = await classifyLog(0, events({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } }))
    assert.deepEqual([ok.code, ok.ok, ok.message, ok.result.usage.output_tokens], ['SUCCESS', true, '', 3])
  })

  await test('classify: an unreadable log fails closed instead of reading as no output', async () => {
    const { classifyCodexExec } = await api()
    const logFile = join(runDir(), 'is-a-directory')
    mkdirSync(logFile)
    assert.throws(() => classifyCodexExec({ exitCode: 0, logFile }), error => error.code === 'EISDIR')
    for (const input of [{ exitCode: 0, logFile: '' }, { exitCode: Infinity, logFile }, { exitCode: 0, logFile: 5 }, [0, logFile]]) {
      assert.throws(() => classifyCodexExec(input), coded)
    }
  })

  await test('CODEX_EXEC_CODES is frozen and maps each code to itself', async () => {
    const { CODEX_EXEC_CODES } = await api()
    assert.equal(Object.isFrozen(CODEX_EXEC_CODES), true)
    assert.equal(Object.keys(CODEX_EXEC_CODES).length, 9)
  })
} finally {
  rmSync(WORK, { recursive: true, force: true })
}
