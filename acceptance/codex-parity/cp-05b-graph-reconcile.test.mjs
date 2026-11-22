// CP-05b frozen acceptance: the held-call reconcile CLI and the shared failed-envelope
// builder (spec/contracts/codex-parity-cp-05b.md). Wiring proof, not runtime
// certification: no real codex, no claude, no network, no HOME. The crash cases spawn
// the real CP-02e host CLI, which builds the real CP-02b provider around the frozen
// fake codex acceptance/codex-parity/cp-02f-fake-codex.cjs (copied into an owned temp
// directory), and SIGKILL it while a leaf is held open. The reconcile CLI always runs
// with an empty PATH and no codex binary.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ROOT, completion, devAnswer, fixture, pass, review } from '../native-runtime/nr-02-runtime-support.mjs'

const RECONCILE_PATH = resolve(ROOT, 'core/skills/native-runtime/graph-reconcile.mjs')
const HOST_PATH = resolve(ROOT, 'core/skills/native-runtime/graph-host.mjs')
const FAKE_CODEX = fileURLToPath(new URL('./cp-02f-fake-codex.cjs', import.meta.url))
const CATALOG = 'spec/offering-capabilities.json'
const loadModule = rel => import(pathToFileURL(resolve(ROOT, rel)).href)
const loadStore = () => loadModule('core/skills/native-runtime/checkpoint-store.mjs')
const loadCompletion = () => loadModule('core/skills/native-runtime/completion.mjs')
const sha = value => createHash('sha256').update(value).digest('hex')
const tokenOf = bytes => sha(bytes).slice(0, 16)
const sleep = ms => new Promise(done => setTimeout(done, ms))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
// SIGKILL cases run under load (3x parallel): every wait is generous.
const BOUND_MS = 30000
async function until(check, what, ms = BOUND_MS) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (check()) return
  assert.ok(check(), `timed out waiting for ${what}`)
}

// Markers that must never reach reconcile output: the repo path is in every leaf
// prompt, and the checker's reply is stored as returned completion text.
const PROMPT_MARK = 'PROMPT-MARK-05b'
const COMPLETION_MARK = 'COMPLETION-MARK-05b'
const CALL_ID = /^nr-[0-9a-f]{64}$/
const OPERATOR_CODE = 'OPERATOR_ABANDONED'
const ROW_KEYS = ['agentType', 'callId', 'code', 'invocationId', 'label', 'occurrence', 'phase', 'profile', 'selection', 'state', 'workflowPath']

// ---------------------------------------------------------------- fixture root
// The same fixture root CP-02f uses: the candidate's catalog with only `dev`'s codex
// row flipped to partial, the six workflow templates, every role file and every file
// directly in a skill directory. Regular files only; symlinks are skipped.
function copyTree(target) {
  const copy = rel => {
    const from = join(ROOT, rel)
    if (!existsSync(from) || !lstatSync(from).isFile()) return
    mkdirSync(dirname(join(target, rel)), { recursive: true })
    cpSync(from, join(target, rel))
  }
  const dirs = path => existsSync(join(ROOT, path)) ? readdirSync(join(ROOT, path), { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => e.name) : []
  const files = (path, suffix) => existsSync(join(ROOT, path)) ? readdirSync(join(ROOT, path), { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(suffix)).map(e => e.name) : []
  copy(CATALOG)
  for (const c of ['core', 'kit', ...dirs('graphs').map(g => `graphs/${g}`)]) {
    for (const f of files(`${c}/agents`, '.md')) copy(`${c}/agents/${f}`)
    for (const f of files(`${c}/workflows`, '.js')) copy(`${c}/workflows/${f}`)
    for (const s of dirs(`${c}/skills`)) for (const f of files(`${c}/skills/${s}`, '')) copy(`${c}/skills/${s}/${f}`)
  }
}
const PARTIAL = Object.freeze({ implementation: 'partial', transportId: 'codex-autobuild',
  limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] })
const QA_ROLES = ['checker', 'fixer', 'reviewer', 'advisor', 'qa-auditor']

let WORK, FIXTURE_ROOT, PREFIXES
// Built on first use, so a candidate without the v2 catalog or role loader fails each case on its own.
async function root() {
  if (FIXTURE_ROOT) return FIXTURE_ROOT
  const dir = realpathSync(mkdtempSync(join(WORK, 'root-')))
  copyTree(dir)
  const catalog = readJson(join(dir, CATALOG))
  const row = catalog.offerings.find(o => o.id === 'dev')
  assert.ok(row?.providers?.codex, 'the candidate catalog is v2 with provider rows (CP-01b)')
  row.providers.codex = structuredClone(PARTIAL)
  writeFileSync(join(dir, CATALOG), JSON.stringify(catalog, null, 2) + '\n')
  const { assembleRoleInstructions } = await loadModule('core/skills/native-runtime/role-files.mjs')
  PREFIXES = QA_ROLES.map(role => ({ role, prefix: assembleRoleInstructions({ installationRoot: dir, name: role }).instructions + '\n\n' }))
  FIXTURE_ROOT = dir
  return dir
}

before(() => { WORK = realpathSync(mkdtempSync(join(tmpdir(), 'cp-05b-'))) })
after(() => rmSync(WORK, { recursive: true, force: true }))

const wire = value => ({ json: JSON.stringify(value) })
const HAPPY = Object.freeze({
  checker: wire({ ...pass(), verify_block: `  [0] ${COMPLETION_MARK}\nVERIFY: PASS` }),
  reviewer: wire(review()), 'qa-auditor': wire(review()),
})
const scriptText = (replies = HAPPY, roles = PREFIXES) => JSON.stringify({ roles, replies })

// ------------------------------------------------------------------ host cases
// One owned directory per case. bin/ is the only PATH of the host CLI and of every
// leaf. Its `node` is a shim for the fake's `#!/usr/bin/env node`: it records its pid
// (exec keeps it, and CP-02a makes it the leaf's process group) and execs the real
// node, so every fake spawn is one line in pids.txt. A recording `claude` stub sits
// next to it. The fake codex lives outside PATH.
function makeCase() {
  const dir = realpathSync(mkdtempSync(join(WORK, 'case-')))
  const c = { dir, runDir: join(dir, 'run'), repo: join(dir, `repo-${PROMPT_MARK}`), cwd: join(dir, 'cwd'), fake: join(dir, 'fake'),
    bin: join(dir, 'bin'), codex: join(dir, 'codex-bin', 'codex'), claudeCalls: join(dir, 'claude-calls.jsonl'),
    pids: join(dir, 'pids.txt') }
  for (const d of [c.repo, c.cwd, c.fake, c.bin, dirname(c.codex)]) mkdirSync(d)
  assert.ok(![c.pids, process.execPath].some(p => p.includes("'")), 'shim paths quote safely')
  writeFileSync(join(c.bin, 'node'), `#!/bin/sh\necho $$ >> '${c.pids}'\nexec '${process.execPath}' "$@"\n`)
  chmodSync(join(c.bin, 'node'), 0o755)
  writeFileSync(join(c.bin, 'claude'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(c.claudeCalls)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`)
  chmodSync(join(c.bin, 'claude'), 0o755)
  cpSync(FAKE_CODEX, c.codex)
  chmodSync(c.codex, 0o755)
  return c
}
const checkpointsOf = c => join(c.runDir, 'checkpoints')
function argsFile(c) {
  const value = { schemaVersion: 1, installationRoot: FIXTURE_ROOT, workflowId: 'harness-repair', offeringId: 'dev',
    invocationId: 'inv-05b', args: { repo: c.repo }, runDir: c.runDir, codexBin: c.codex, cwd: c.cwd,
    env: { PATH: c.bin, FAKE_CODEX_DIR: c.fake }, timeoutMs: 120000, maxConcurrentSubagents: 1, graceMs: 200 }
  const path = join(c.dir, 'args.json')
  writeFileSync(path, JSON.stringify(value))
  return path
}
function collect(child) {
  return new Promise(done => {
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', (code, signal) => done({ code, signal, stdout, stderr }))
  })
}
const startHost = (c, file) => {
  const child = spawn(process.execPath, [HOST_PATH, '--args-file', file], { env: { PATH: c.bin }, stdio: ['ignore', 'pipe', 'pipe'] })
  return { child, done: collect(child) }
}
const host = (c, file) => startHost(c, file).done
// The reconcile CLI: an empty PATH, no HOME, no codex binary anywhere it could find.
const reconcile = (...argv) => collect(spawn(process.execPath, [RECONCILE_PATH, ...argv], { env: { PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] }))

const calls = c => lines(join(c.fake, 'calls.jsonl')).map(line => JSON.parse(line))
const pids = c => lines(c.pids).map(Number)
function rowFiles(c) {
  const dir = checkpointsOf(c)
  return existsSync(dir) ? readdirSync(dir).filter(name => /^nr-[0-9a-f]{64}\.json$/.test(name)).map(name => readJson(join(dir, name))) : []
}
const rowOf = (c, agentType) => rowFiles(c).find(row => row.binding.agentType === agentType)
const rowBytes = (dir, callId) => readFileSync(join(dir, callId + '.json'))
const lockPath = c => join(checkpointsOf(c), '.lock')

// Every entry under dir: type, mode, inode, mtime and bytes. Equal snapshots mean
// nothing was created, removed, rewritten or touched.
function snapshot(dir) {
  const out = {}
  const walk = path => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name), info = lstatSync(full)
      const entry = { mode: info.mode, ino: info.ino, mtimeMs: info.mtimeMs }
      if (info.isFile()) entry.sha = sha(readFileSync(full))
      out[relative(dir, full)] = entry
      if (info.isDirectory()) walk(full)
    }
  }
  walk(dir)
  return out
}

function assertOk(r, value) {
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stderr, '')
  assert.ok(r.stdout.endsWith('\n') && r.stdout.indexOf('\n') === r.stdout.length - 1, 'stdout is exactly one line')
  const parsed = JSON.parse(r.stdout)
  if (value !== undefined) assert.deepEqual(parsed, value)
  return parsed
}
function assertError(r, exit, code) {
  assert.equal(r.code, exit, `exit (stderr ${r.stderr.trim()})`)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, JSON.stringify({ error: code }) + '\n')
}
const assertNoText = r => {
  for (const mark of [PROMPT_MARK, COMPLETION_MARK]) assert.ok(!(r.stdout + r.stderr).includes(mark), `output carries ${mark}`)
}

// A FIFO named script.json holds the fake inside its own code: it reads the script
// only after stdin closes, and blocks there until something writes.
function makeFifo(path) {
  const made = spawnSync('mkfifo', [path])
  assert.equal(made.status, 0, 'mkfifo')
}
// Writes text to the FIFO once a reader has it open (non-blocking open, so a reader
// that never comes is a bounded failure, not a hang), then closes it (EOF).
async function feedFifo(path, text, hostRun) {
  let fd
  await until(() => {
    assert.equal(hostRun.child.exitCode, null, 'the host exited before the leaf read its script')
    try { fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK); return true } catch (error) {
      if (error.code === 'ENXIO') return false
      throw error
    }
  }, 'a fake codex reading the script FIFO')
  const buffer = Buffer.from(text)
  try {
    for (let offset = 0; offset < buffer.length;) {
      try { offset += writeSync(fd, buffer, offset) } catch (error) { if (error.code !== 'EAGAIN') throw error; await sleep(5) }
    }
  } finally { closeSync(fd) }
}

// SIGKILLs a process group the test learned from pids.txt; a group already gone is fine.
function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
}

// Runs harness-repair through the host CLI and SIGKILLs the host while the `role`
// leaf is held open: its row is prepared and its fake codex is blocked. Leaves before
// it get their scripted replies. Then kills the fake's process group, waits for both
// pids to be gone, and replaces the FIFO with a regular script, so a later spawn is
// recorded in calls.jsonl and pids.txt instead of blocking. A failure anywhere still
// kills the host and every fake it spawned, so no case outlives its test.
async function crash(c, role, whileHeld = async () => {}) {
  await root()
  const file = argsFile(c)
  const fifo = join(c.fake, 'script.json')
  makeFifo(fifo)
  const run = startHost(c, file)
  try {
    const order = ['checker', 'reviewer', 'qa-auditor']
    const before = order.slice(0, order.indexOf(role))
    for (const [i, earlier] of before.entries()) {
      await feedFifo(fifo, scriptText({ [earlier]: HAPPY[earlier] }), run)
      await until(() => calls(c).length === i + 1, `the ${earlier} leaf`)
    }
    await until(() => pids(c).length === before.length + 1 && rowOf(c, role)?.state === 'prepared' && existsSync(lockPath(c)),
      `the ${role} leaf spawned with its row prepared`)
    const fakePid = pids(c).at(-1)
    assert.equal(run.child.exitCode, null, 'the host is still running')
    assert.ok(alive(fakePid), 'the held fake codex is running')
    await whileHeld({ hostPid: run.child.pid, fakePid, file })
    run.child.kill('SIGKILL')
    const result = await run.done
    assert.equal(result.signal, 'SIGKILL')
    killGroup(fakePid)
    await until(() => !alive(fakePid), 'the fake codex process group to die')
    assert.equal(alive(run.child.pid), false)
    unlinkSync(fifo)
    writeFileSync(fifo, scriptText())
    assert.equal(calls(c).length, before.length, 'the held leaf never answered')
    return { hostPid: run.child.pid, fakePid, file }
  } finally {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL')
    await run.done
    // Only the latest fake can still be running: each earlier one wrote its calls.jsonl
    // record and exited. A pid long gone is never signalled (it may be reused).
    const held = pids(c).at(-1)
    if (held !== undefined && alive(held)) killGroup(held)
  }
}

// ================================================ crash, list, unlock, fail, replay
describe('CP-05b reconcile a host run SIGKILLed mid-leaf (real host CLI, frozen fake codex; wiring proof)', () => {
  let M = null // { c, hostPid, file, reviewer: callId, spawns }
  const ready = () => { assert.ok(M, 'the crash case ran'); return M }

  test('list exits 0 with the lock (pid, token) and the prepared row; the run dir is unchanged by list', async () => {
    const c = makeCase()
    const crashed = await crash(c, 'reviewer')
    const dir = checkpointsOf(c)
    const before = snapshot(c.runDir)
    const r = await reconcile('list', '--run-dir', c.runDir)
    assert.deepEqual(snapshot(c.runDir), before, 'list changed the run directory')
    const report = assertOk(r)
    assertNoText(r)
    assert.deepEqual(Object.keys(report), ['lock', 'rows', 'strays'])
    // The printed report is CP-05a's inspectCheckpoints report, verbatim.
    const { inspectCheckpoints } = await loadStore()
    assert.deepEqual(report, await inspectCheckpoints({ dir }))
    assert.deepEqual(report.lock, { pid: crashed.hostPid, token: tokenOf(readFileSync(join(dir, '.lock'))) })
    assert.deepEqual(report.strays, [])
    assert.equal(report.rows.length, 2)
    for (const row of report.rows) assert.deepEqual(Object.keys(row).sort(), ROW_KEYS)
    const byAgent = Object.fromEntries(report.rows.map(row => [row.agentType, row]))
    assert.equal(byAgent.checker.state, 'returned')
    const held = byAgent.reviewer
    assert.equal(held.state, 'prepared')
    assert.equal(held.code, null)
    assert.equal(held.invocationId, 'inv-05b')
    assert.deepEqual(held.workflowPath, ['harness-repair'])
    assert.equal(held.profile, rowOf(c, 'reviewer').binding.profile)
    assert.deepEqual(held.selection, rowOf(c, 'reviewer').binding.selection)
    assert.ok(!r.stdout.includes(rowOf(c, 'reviewer').binding.promptHash), 'no prompt hash')
    M = { c, hostPid: crashed.hostPid, file: crashed.file, reviewer: held.callId, spawns: pids(c).length }
  })

  test('a host rerun exits 4 OWNER_BUSY and changes nothing', async () => {
    const { c, file, spawns } = ready()
    const before = snapshot(checkpointsOf(c))
    const r = await host(c, file)
    assert.equal(r.code, 4)
    assert.equal(r.stderr, JSON.stringify({ error: 'OWNER_BUSY' }) + '\n')
    assert.deepEqual(snapshot(checkpointsOf(c)), before)
    assert.equal(pids(c).length, spawns)
  })

  test('unlock: a wrong token exits 2 and a live-pid lock exits 2 OWNER_ALIVE, both locks intact; the right token on the dead pid exits 0', async () => {
    const { c } = ready()
    const lockBytes = readFileSync(lockPath(c))
    const token = tokenOf(lockBytes)
    const wrong = token.replace(/^./, ch => (ch === '0' ? '1' : '0'))
    assertError(await reconcile('unlock', '--run-dir', c.runDir, '--token', wrong), 2, 'CONFIRM_MISMATCH')
    assert.deepEqual(readFileSync(lockPath(c)), lockBytes)

    // A crafted lock in its own run directory, taken by a real store in this live process.
    const { createFileCheckpointStore } = await loadStore()
    const liveRun = join(c.dir, 'live-run')
    mkdirSync(liveRun)
    const store = await createFileCheckpointStore({ dir: join(liveRun, 'checkpoints') })
    try {
      const liveBytes = readFileSync(join(liveRun, 'checkpoints', '.lock'))
      assert.equal(JSON.parse(liveBytes).pid, process.pid)
      assertError(await reconcile('unlock', '--run-dir', liveRun, '--token', tokenOf(liveBytes)), 2, 'OWNER_ALIVE')
      assert.deepEqual(readFileSync(join(liveRun, 'checkpoints', '.lock')), liveBytes)
    } finally { await store.close() }

    const before = snapshot(checkpointsOf(c))
    assertOk(await reconcile('unlock', '--run-dir', c.runDir, '--token', token), { unlocked: true })
    assert.equal(existsSync(lockPath(c)), false)
    delete before['.lock']
    assert.deepEqual(snapshot(checkpointsOf(c)), before, 'only .lock changed')
  })

  test('a host rerun then exits 3 CHECKPOINT_UNCERTAIN with zero new spawns', async () => {
    const { c, file, spawns, reviewer } = ready()
    const r = await host(c, file)
    assert.equal(r.code, 3)
    assert.equal(r.stderr, JSON.stringify({ error: 'CHECKPOINT_UNCERTAIN' }) + '\n')
    assert.equal(pids(c).length, spawns, 'a held call was re-dispatched')
    assert.equal(calls(c).length, 1)
    assert.equal(existsSync(lockPath(c)), false, 'the host released its lock')
    assert.equal(rowOf(c, 'reviewer').callId, reviewer)
    assert.ok(['prepared', 'uncertain'].includes(rowOf(c, 'reviewer').state))
  })

  test('fail: without --confirm or with another id it refuses and the row is unchanged; with the right confirm the row is failed/OPERATOR_ABANDONED with the stored selection', async () => {
    const { c, reviewer } = ready()
    const dir = checkpointsOf(c)
    const before = snapshot(dir)
    const bytes = rowBytes(dir, reviewer)
    const r1 = await reconcile('fail', '--run-dir', c.runDir, '--call-id', reviewer)
    assertError(r1, 1, 'INVALID_RECONCILE_INPUT')
    const other = rowOf(c, 'checker').callId
    const r2 = await reconcile('fail', '--run-dir', c.runDir, '--call-id', reviewer, '--confirm', other)
    assertError(r2, 2, 'CONFIRM_MISMATCH')
    const r3 = await reconcile('fail', '--run-dir', c.runDir, '--call-id', reviewer, '--confirm', reviewer.toUpperCase())
    assertError(r3, 2, 'CONFIRM_MISMATCH')
    assert.deepEqual(snapshot(dir), before, 'a refused fail changed the checkpoints')
    assert.deepEqual(rowBytes(dir, reviewer), bytes)

    const stored = readJson(join(dir, reviewer + '.json')).binding
    const r = await reconcile('fail', '--run-dir', c.runDir, '--call-id', reviewer, '--confirm', reviewer)
    assertOk(r, { callId: reviewer, state: 'failed', code: OPERATOR_CODE })
    assertNoText(r)
    const row = readJson(join(dir, reviewer + '.json'))
    assert.deepEqual(Object.keys(row), ['version', 'callId', 'binding', 'state', 'completion'])
    assert.equal(row.state, 'failed')
    assert.deepEqual(row.binding, stored, 'the binding is unchanged')
    assert.equal(JSON.stringify(row.completion), JSON.stringify({ outcome: 'failed', code: OPERATOR_CODE, usage: null,
      receipt: { provider: stored.selection.provider, model: stored.selection.model, effort: stored.selection.effort,
        invocationId: `reconcile:${reviewer}` } }))
    assert.equal(statSync(join(dir, reviewer + '.json')).mode & 0o777, 0o600)
    assert.equal(existsSync(join(dir, '.lock')), false, 'no lock left behind')
    assert.deepEqual(readdirSync(dir).sort(), Object.keys(before).sort(), 'no file added or removed')
  })

  test('the host rerun with the same args file exits 0 escalate; the replayed leaf makes zero spawns; claude is never run', async () => {
    const { c, file, spawns } = ready()
    const r = await host(c, file)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, JSON.stringify({ status: 'escalate' }) + '\n')
    assert.equal(pids(c).length, spawns, 'a spawn happened on replay')
    assert.equal(calls(c).length, 1)
    assert.equal(existsSync(c.claudeCalls), false, 'a claude binary was invoked')
    const result = readJson(join(c.runDir, 'result.json'))
    assert.equal(result.status, 'escalate')
    // The operator's failure reached the graph as an ordinary failed leaf.
    assert.ok(result.result.history.some(h => h.node === 'review' && h.error === 'Native runtime: LEAF_FAILED.'),
      JSON.stringify(result.result.history))
    assert.deepEqual(rowFiles(c).map(row => row.state).sort(), ['failed', 'returned'])
  })
})

// ======================================== a build-workspace row under a live host
describe('CP-05b a build-workspace row held by a live host, then crashed (wiring proof)', () => {
  test('while the host lives fail exits 4 and unlock exits 2 OWNER_ALIVE; after the crash unlock and fail exit 0 and the rerun escalates with zero spawns', async () => {
    const c = makeCase()
    let live = null
    const crashed = await crash(c, 'checker', async ({ hostPid }) => {
      const dir = checkpointsOf(c)
      const r = await reconcile('list', '--run-dir', c.runDir)
      const report = assertOk(r)
      assert.equal(report.lock.pid, hostPid)
      const [row] = report.rows
      assert.equal(report.rows.length, 1)
      assert.equal(row.agentType, 'checker')
      assert.equal(row.state, 'prepared')
      assert.equal(row.profile, 'build-workspace')
      const before = snapshot(dir)
      assertError(await reconcile('fail', '--run-dir', c.runDir, '--call-id', row.callId, '--confirm', row.callId), 4, 'OWNER_BUSY')
      assertError(await reconcile('unlock', '--run-dir', c.runDir, '--token', report.lock.token), 2, 'OWNER_ALIVE')
      assert.deepEqual(snapshot(dir), before, 'a refusal under a live host changed the checkpoints')
      live = row
    })
    assert.ok(live, 'the live-host checks ran')
    const report = assertOk(await reconcile('list', '--run-dir', c.runDir))
    assert.equal(report.lock.pid, crashed.hostPid)
    assertOk(await reconcile('unlock', '--run-dir', c.runDir, '--token', report.lock.token), { unlocked: true })
    assertOk(await reconcile('fail', '--run-dir', c.runDir, '--call-id', live.callId, '--confirm', live.callId),
      { callId: live.callId, state: 'failed', code: OPERATOR_CODE })
    const row = rowOf(c, 'checker')
    assert.equal(row.binding.profile, 'build-workspace')
    assert.deepEqual(row.completion, { outcome: 'failed', code: OPERATOR_CODE, usage: null,
      receipt: { ...row.binding.selection, invocationId: `reconcile:${live.callId}` } })

    const r = await host(c, crashed.file)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, JSON.stringify({ status: 'escalate' }) + '\n')
    assert.equal(pids(c).length, 1, 'the failed build-workspace leaf was re-dispatched')
    assert.deepEqual(calls(c), [])
    assert.equal(existsSync(c.claudeCalls), false)
    const result = readJson(join(c.runDir, 'result.json'))
    assert.ok(result.result.history.some(h => h.node === 'check' && h.error === 'Native runtime: LEAF_FAILED.'))
  })
})

// ===================================================== refusals on a seeded store
// Rows made through a real CP-02d store (never hand-written happy paths), in
// <runDir>/checkpoints, the layout the host uses.
const SELECTION = Object.freeze({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' })
const seedId = n => 'nr-' + sha('cp-05b-seed-' + n)
const seedBinding = (n, extra = {}) => ({ callId: seedId(n), invocationId: 'inv-seed', workflowId: 'harness-repair',
  workflowPath: ['harness-repair'], agentType: 'reviewer', label: 'review: branch', phase: 'Review', occurrence: 1,
  promptHash: sha(PROMPT_MARK), selection: { ...SELECTION }, profile: 'source-review', ...extra })
const seedReceipt = { ...SELECTION, invocationId: 'fake-seed' }
async function seeded() {
  const { createFileCheckpointStore } = await loadStore()
  const runDir = realpathSync(mkdtempSync(join(WORK, 'seed-')))
  const dir = join(runDir, 'checkpoints')
  const store = await createFileCheckpointStore({ dir })
  const ids = { prepared: seedId('prepared'), uncertain: seedId('uncertain'), returned: seedId('returned'),
    failed: seedId('failed'), bare: seedId('bare'), corrupt: seedId('corrupt') }
  for (const n of ['prepared', 'uncertain', 'returned', 'failed']) await store.reserve(seedBinding(n))
  await store.reserve({ callId: ids.bare })
  await store.uncertain(ids.uncertain, { code: 'DISPATCH_UNCERTAIN' })
  await store.settle(ids.returned, { outcome: 'returned', wire: { json: JSON.stringify({ text: COMPLETION_MARK }) }, usage: null, receipt: seedReceipt })
  await store.settle(ids.failed, { outcome: 'failed', code: 'PROVIDER_REFUSAL', usage: null, receipt: seedReceipt })
  await store.close()
  writeFileSync(join(dir, ids.corrupt + '.json'), '{"version":1,')
  writeFileSync(join(dir, 'notes.txt'), 'operator notes')
  return { runDir, dir, ids }
}

describe('CP-05b refusals', () => {
  test('list prints the report verbatim: rows in every state, corrupt rows and strays; no text, nothing changed', async () => {
    const s = await seeded()
    const before = snapshot(s.runDir)
    const r = await reconcile('list', '--run-dir', s.runDir)
    assert.deepEqual(snapshot(s.runDir), before)
    const report = assertOk(r)
    assertNoText(r)
    const { inspectCheckpoints } = await loadStore()
    assert.deepEqual(report, await inspectCheckpoints({ dir: s.dir }))
    assert.equal(report.lock, null)
    assert.deepEqual(report.strays, ['notes.txt'])
    const states = Object.fromEntries(report.rows.map(row => [row.callId, row.state]))
    assert.deepEqual(states, { [s.ids.prepared]: 'prepared', [s.ids.uncertain]: 'uncertain', [s.ids.returned]: 'returned',
      [s.ids.failed]: 'failed', [s.ids.bare]: 'prepared', [s.ids.corrupt]: 'corrupt' })
  })

  test('fail refuses returned and failed rows (NOT_HELD), a corrupt row (CORRUPT), an unknown id (NOT_FOUND) and a row with no selection (SELECTION_MISSING); every file unchanged, no lock left', async () => {
    const s = await seeded()
    const before = snapshot(s.runDir)
    const failOf = id => reconcile('fail', '--run-dir', s.runDir, '--call-id', id, '--confirm', id)
    assertError(await failOf(s.ids.returned), 2, 'NOT_HELD')
    assertError(await failOf(s.ids.failed), 2, 'NOT_HELD')
    assertError(await failOf(s.ids.corrupt), 2, 'CORRUPT')
    assertError(await failOf(seedId('absent')), 2, 'NOT_FOUND')
    assertError(await failOf(s.ids.bare), 2, 'SELECTION_MISSING')
    assert.deepEqual(snapshot(s.runDir), before)
    assert.equal(existsSync(join(s.dir, '.lock')), false)
  })

  test('fail closes an uncertain row too: its held code is dropped and the completion carries the stored selection', async () => {
    const s = await seeded()
    const id = s.ids.uncertain
    assertOk(await reconcile('fail', '--run-dir', s.runDir, '--call-id', id, '--confirm', id), { callId: id, state: 'failed', code: OPERATOR_CODE })
    const row = readJson(join(s.dir, id + '.json'))
    assert.deepEqual(row, { version: 1, callId: id, binding: seedBinding('uncertain'), state: 'failed',
      completion: { outcome: 'failed', code: OPERATOR_CODE, usage: null, receipt: { ...SELECTION, invocationId: `reconcile:${id}` } } })
    // A new store replays it as the completion the runtime will see.
    const { createFileCheckpointStore } = await loadStore()
    const store = await createFileCheckpointStore({ dir: s.dir })
    try { assert.deepEqual(await store.reserve(seedBinding('uncertain')), { state: 'completed', completion: row.completion }) }
    finally { await store.close() }
  })

  test('fail exits 4 OWNER_BUSY for any call id while a store holds the lock, before any row check; the lock and every row stay byte-identical', async () => {
    const s = await seeded()
    const { createFileCheckpointStore } = await loadStore()
    const store = await createFileCheckpointStore({ dir: s.dir })
    try {
      const before = snapshot(s.runDir)
      for (const id of [s.ids.prepared, s.ids.returned, s.ids.corrupt, s.ids.bare, seedId('absent')]) {
        assertError(await reconcile('fail', '--run-dir', s.runDir, '--call-id', id, '--confirm', id), 4, 'OWNER_BUSY')
      }
      assert.deepEqual(snapshot(s.runDir), before)
    } finally { await store.close() }
  })

  test('a missing run or checkpoints directory is NOT_FOUND (exit 2) for every verb, and nothing is created', async () => {
    const base = realpathSync(mkdtempSync(join(WORK, 'missing-')))
    const absentRun = join(base, 'no-run')
    const bareRun = join(base, 'bare-run')
    mkdirSync(bareRun)
    const id = seedId('x')
    for (const runDir of [absentRun, bareRun]) {
      assertError(await reconcile('list', '--run-dir', runDir), 2, 'NOT_FOUND')
      assertError(await reconcile('fail', '--run-dir', runDir, '--call-id', id, '--confirm', id), 2, 'NOT_FOUND')
      assertError(await reconcile('unlock', '--run-dir', runDir, '--token', '0123456789abcdef'), 2, 'NOT_FOUND')
    }
    assert.deepEqual(readdirSync(base), ['bare-run'])
    assert.deepEqual(readdirSync(bareRun), [])
    // A checkpoints directory with no lock: unlock is NOT_FOUND and creates nothing.
    const s = await seeded()
    const before = snapshot(s.runDir)
    assertError(await reconcile('unlock', '--run-dir', s.runDir, '--token', '0123456789abcdef'), 2, 'NOT_FOUND')
    assert.deepEqual(snapshot(s.runDir), before)
  })

  test('malformed argv exits 1 INVALID_RECONCILE_INPUT with empty stdout, and touches nothing', async () => {
    const s = await seeded()
    const run = s.runDir, id = s.ids.prepared, tok = '0123456789abcdef'
    const before = snapshot(run)
    const cases = [
      [], ['list'], ['list', '--run-dir'], ['list', '--run-dir', 'relative/run'], ['list', '--run-dir', run + '\n'],
      ['list', '--run-dir', run, '--run-dir', run], ['list', '--run-dir', run, 'extra'], ['list', '--run-dir', run, '--token', tok],
      ['--run-dir', run, 'list'], ['LIST', '--run-dir', run], ['list', '--run-dir=' + run],
      ['retry', '--run-dir', run, '--call-id', id], ['delete', '--run-dir', run, '--call-id', id],
      ['adopt', '--run-dir', run, '--call-id', id], ['purge', '--run-dir', run],
      ['fail', '--run-dir', run, '--call-id', id], ['fail', '--run-dir', run, '--confirm', id],
      ['fail', '--run-dir', run, '--call-id', id, '--confirm'], ['fail', '--run-dir', run, '--call-id', 'nr-xyz', '--confirm', 'nr-xyz'],
      ['fail', '--run-dir', run, '--call-id', id.toUpperCase(), '--confirm', id.toUpperCase()],
      ['fail', '--run-dir', run, '--call-id', id, '--confirm', id, '--token', tok],
      ['fail', '--run-dir', run, '--call-id', id, '--call-id', id], ['unlock', '--token', tok, '--token', tok],
      ['unlock', '--run-dir', run], ['unlock', '--run-dir', run, '--token', 'XYZ'],
      ['unlock', '--run-dir', run, '--token', tok.toUpperCase()], ['unlock', '--run-dir', run, '--token', tok + '0'],
      ['unlock', '--run-dir', run, '--token', tok, '--confirm', tok],
    ]
    for (const argv of cases) {
      const r = await reconcile(...argv)
      assert.equal(r.code, 1, `argv ${JSON.stringify(argv)}`)
      assertError(r, 1, 'INVALID_RECONCILE_INPUT')
    }
    assert.deepEqual(snapshot(run), before)
  })

  test('the CLI spawns nothing: its import closure has no child process, codex, host or runtime module', async () => {
    const seen = new Set(), builtins = new Set()
    const visit = path => {
      if (seen.has(path)) return
      seen.add(path)
      const text = readFileSync(path, 'utf8')
      assert.ok(!/\bimport\s*\(/.test(text), `${relative(ROOT, path)} has a dynamic import`)
      assert.ok(!text.includes('child_process'), `${relative(ROOT, path)} mentions child_process`)
      // Both `import … from '…'` and a bare side-effect `import '…'` (same pattern as CP-04d).
      const specs = [...text.matchAll(/^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom[ \t]*(['"])([^'"\n]+)\1|^[ \t]*import[ \t]*(['"])([^'"\n]+)\3/gm)]
        .map(m => m[2] ?? m[4])
      for (const spec of specs) {
        if (spec.startsWith('.')) visit(resolve(dirname(path), spec))
        else builtins.add(spec)
      }
    }
    visit(RECONCILE_PATH)
    const names = [...seen].map(p => relative(resolve(ROOT, 'core/skills/native-runtime'), p))
    assert.ok(names.includes('checkpoint-store.mjs') && names.includes('completion.mjs'), names.join(', '))
    for (const banned of ['codex-exec.mjs', 'codex-provider.mjs', 'graph-host.mjs', 'runtime.mjs', 'registry.mjs']) {
      assert.ok(!names.includes(banned), `imports ${banned}`)
    }
    for (const spec of builtins) assert.ok(['node:fs', 'node:fs/promises', 'node:path', 'node:url', 'node:crypto', 'node:util'].includes(spec), `imports ${spec}`)
    // Importing the module runs no CLI.
    const exitCode = process.exitCode
    await import(pathToFileURL(RECONCILE_PATH).href)
    assert.equal(process.exitCode, exitCode)
  })
})

// =========================================================== failedCompletion
describe('CP-05b failedCompletion', () => {
  test('returns the exact NR-02 failed envelope, keys in order, detached from its input', async () => {
    const { failedCompletion } = await loadCompletion()
    const selection = { provider: 'codex', model: 'gpt-6-luna', effort: 'medium' }
    const out = failedCompletion({ selection, code: 'PROMPT_TOO_LARGE', invocationId: 'host:abc' })
    assert.equal(JSON.stringify(out), JSON.stringify({ outcome: 'failed', code: 'PROMPT_TOO_LARGE', usage: null,
      receipt: { provider: 'codex', model: 'gpt-6-luna', effort: 'medium', invocationId: 'host:abc' } }))
    assert.equal(Object.getPrototypeOf(out), Object.prototype)
    assert.equal(Object.getPrototypeOf(out.receipt), Object.prototype)
    out.receipt.model = 'changed'
    assert.equal(selection.model, 'gpt-6-luna')
    const nullProto = Object.assign(Object.create(null), selection)
    assert.deepEqual(failedCompletion({ selection: nullProto, code: 'A', invocationId: 'x' }).receipt,
      { ...selection, invocationId: 'x' })
    assert.equal(failedCompletion({ selection, code: 'A' + 'B'.repeat(63), invocationId: 'x' }).code.length, 64)
  })

  test('bad input throws INVALID_RUNTIME_INPUT and echoes nothing', async () => {
    const { failedCompletion } = await loadCompletion()
    const sel = { provider: 'codex', model: 'm', effort: 'high' }
    const ok = { selection: sel, code: 'OPERATOR_ABANDONED', invocationId: 'reconcile:x' }
    const getter = { ...ok }
    Object.defineProperty(getter, 'code', { get: () => 'X', enumerable: true })
    class Options { constructor() { Object.assign(this, ok) } }
    const bad = [
      undefined, null, 'x', [], [ok], new Options(), new Proxy({ ...ok }, {}), getter,
      { selection: sel, code: 'X' }, { ...ok, extra: 1 }, { ...ok, [Symbol('s')]: 1 },
      { ...ok, code: 'lower' }, { ...ok, code: '1ABC' }, { ...ok, code: '' }, { ...ok, code: 'A' + 'B'.repeat(64) },
      { ...ok, code: 'A-B' }, { ...ok, code: 7 }, { ...ok, code: 'SECRET_CODE\n' },
      { ...ok, selection: null }, { ...ok, selection: { provider: 'codex', model: 'm' } },
      { ...ok, selection: { ...sel, extra: 'x' } }, { ...ok, selection: { ...sel, model: '' } },
      { ...ok, selection: { ...sel, effort: '   ' } }, { ...ok, selection: { ...sel, provider: 1 } },
      { ...ok, selection: new Proxy({ ...sel }, {}) },
      { ...ok, invocationId: '' }, { ...ok, invocationId: ' \t' }, { ...ok, invocationId: 5 }, { ...ok, invocationId: null },
    ]
    for (const [i, input] of bad.entries()) {
      assert.throws(() => failedCompletion(input), e => {
        assert.ok(e instanceof Error, `case ${i}`)
        assert.equal(Object.getOwnPropertyDescriptor(e, 'code')?.value, 'INVALID_RUNTIME_INPUT', `case ${i}`)
        assert.equal(e.message, 'Native runtime: INVALID_RUNTIME_INPUT.', `case ${i}`)
        return true
      })
    }
  })

  test('its output passes the real runtime: replayed through createNativeRuntime it is LEAF_FAILED and harness-repair escalates; a receipt off the stored selection is DISPATCH_UNCERTAIN', async t => {
    const { failedCompletion } = await loadCompletion()
    const { createFileCheckpointStore, failHeldCheckpoint } = await loadStore()
    const run = (f, invocationId) => f.runtime.run('harness-repair', { repo: '/inert/project' }, { invocationId })
    // Leaves a held checker row (provider throws on the first call), then fails it
    // with the given selection and replays the run from a new store.
    async function replay(name, selectionOf) {
      const dir = join(realpathSync(mkdtempSync(join(WORK, `rt-${name}-`))), 'checkpoints')
      const sent = []
      const provider = throwFirst => ({
        async runLeaf(req) {
          sent.push(req.callId)
          if (throwFirst && sent.length === 1) throw new Error('private transport failure')
          return completion(req, devAnswer(req))
        },
      })
      const first = await createFileCheckpointStore({ dir })
      const f1 = await fixture(t, { checkpoints: first, provider: provider(true), cap: 1 })
      await assert.rejects(run(f1, 'held'), e => e.code === 'DISPATCH_UNCERTAIN')
      await f1.runtime.close()
      await first.close()
      const [callId] = sent
      const stored = readJson(join(dir, callId + '.json')).binding
      const given = failedCompletion({ selection: selectionOf(stored.selection), code: OPERATOR_CODE, invocationId: `reconcile:${callId}` })
      await failHeldCheckpoint({ dir, callId, completion: given })
      sent.length = 0
      const second = await createFileCheckpointStore({ dir })
      t.after(() => second.close())
      const f2 = await fixture(t, { checkpoints: second, provider: provider(false), cap: 1 })
      try { return { result: await run(f2, 'held'), sent } } catch (error) { return { error, sent } }
    }

    const ok = await replay('ok', selection => selection)
    assert.equal(ok.error, undefined, `replay rejected with ${ok.error?.code}`)
    assert.equal(ok.sent.length, 0, 'the failed leaf replays; nothing is re-dispatched')
    assert.equal(ok.result.status, 'escalate')
    assert.deepEqual(ok.result.history.filter(h => h.node === 'check').map(h => h.error), ['Native runtime: LEAF_FAILED.'])

    const off = await replay('off', selection => ({ ...selection, model: selection.model + '-other' }))
    assert.equal(off.error?.code, 'DISPATCH_UNCERTAIN')
    assert.equal(off.sent.length, 0)
  })
})
