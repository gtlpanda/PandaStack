// CP-05b implementation edges the frozen acceptance does not pin
// (spec/contracts/codex-parity-cp-05b.md): flag order, the CP-02e run-dir path rule
// at its byte bound and on C1 controls, the confirm check before any filesystem
// access, unreadable locks and rows, a stored selection that failedCompletion
// refuses, stdin ignored, and the static no-exit/no-signal-handler rule. Rows are
// seeded through a real CP-02d store. No codex, no claude, no network.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { REPO, test } from '../scripts/workflow-harness.mjs'

const CLI = join(REPO, 'core/skills/native-runtime/graph-reconcile.mjs')
const COMPLETION = join(REPO, 'core/skills/native-runtime/completion.mjs')
const store = () => import('../core/skills/native-runtime/checkpoint-store.mjs')
const completionApi = () => import('../core/skills/native-runtime/completion.mjs')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'native-graph-reconcile-')))
const ROOT_USER = process.getuid?.() === 0
const sha = text => createHash('sha256').update(text).digest('hex')
const idOf = n => 'nr-' + sha('reconcile-impl-' + n)
const tokenOf = bytes => sha(bytes).slice(0, 16)
const SELECTION = Object.freeze({ provider: 'codex', model: 'gpt-impl', effort: 'high' })

// The CLI with an empty PATH and no other environment, exactly as an operator's shell would not help it.
function reconcile(argv, input = '') {
  const r = spawnSync(process.execPath, [CLI, ...argv], { env: { PATH: '' }, input, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}
function assertError(r, exit, code) {
  assert.equal(r.code, exit, `exit (stderr ${r.stderr.trim()})`)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, JSON.stringify({ error: code }) + '\n')
}
function assertOk(r, value) {
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stderr, '')
  assert.deepEqual(JSON.parse(r.stdout), value)
  assert.equal(r.stdout.indexOf('\n'), r.stdout.length - 1, 'exactly one line')
}
// name -> bytes (or 'non-file'), so equal snapshots mean nothing changed in dir.
const snapshot = dir => Object.fromEntries(readdirSync(dir).sort().map(name =>
  [name, lstatSync(join(dir, name)).isFile() ? readFileSync(join(dir, name), 'utf8') : 'non-file']))

// A run directory whose checkpoints hold the given held rows, no lock.
async function seeded(rows) {
  const { createFileCheckpointStore } = await store()
  const runDir = realpathSync(mkdtempSync(join(WORK, 'run-')))
  const dir = join(runDir, 'checkpoints')
  const s = await createFileCheckpointStore({ dir })
  for (const [n, selection] of rows) {
    await s.reserve({ callId: idOf(n), invocationId: 'inv-impl', agentType: 'reviewer', selection })
  }
  await s.close()
  return { runDir, dir }
}
// A stale lock: valid JSON with the pid of a process that already exited.
function staleLock(dir) {
  const gone = spawnSync(process.execPath, ['-e', ''])
  assert.equal(gone.status, 0)
  const bytes = JSON.stringify({ nonce: 'a'.repeat(64), pid: gone.pid }) + '\n'
  writeFileSync(join(dir, '.lock'), bytes, { mode: 0o600 })
  return bytes
}

try {
  await test('flags are accepted in any order for fail and unlock', async () => {
    const { runDir, dir } = await seeded([['order', { ...SELECTION }]])
    const token = tokenOf(staleLock(dir))
    assertOk(reconcile(['unlock', '--token', token, '--run-dir', runDir]), { unlocked: true })
    const id = idOf('order')
    assertOk(reconcile(['fail', '--confirm', id, '--call-id', id, '--run-dir', runDir]), { callId: id, state: 'failed', code: 'OPERATOR_ABANDONED' })
    assertOk(reconcile(['list', '--run-dir', runDir + '/']), JSON.parse(JSON.stringify(await (await store()).inspectCheckpoints({ dir }))))
  })

  await test('--run-dir: 4096 UTF-8 bytes is accepted, 4097 bytes or a multibyte path over the bound is usage; DEL and C1 controls are usage', async () => {
    // An absolute path of exactly `bytes` UTF-8 bytes, components under NAME_MAX.
    const at = (bytes, unit = 'a') => {
      let path = ''
      while (Buffer.byteLength(path) + 1 + 100 * Buffer.byteLength(unit) <= bytes) path += '/' + unit.repeat(100)
      path += '/'
      while (Buffer.byteLength(path) + Buffer.byteLength(unit) <= bytes) path += unit
      return path + 'a'.repeat(bytes - Buffer.byteLength(path))
    }
    const ok = at(4096)
    assert.equal(Buffer.byteLength(ok), 4096)
    // argv accepts it; <run-dir>/checkpoints (+12 bytes) is then over the kernel's
    // PATH_MAX (4096 with its NUL): 4095 bytes is ENOENT, 4096 bytes is not.
    assertError(reconcile(['list', '--run-dir', ok]), 3, 'IO_ERROR')
    assertError(reconcile(['list', '--run-dir', at(4096 - 13)]), 2, 'NOT_FOUND')
    assertError(reconcile(['list', '--run-dir', at(4096 - 12)]), 3, 'IO_ERROR')
    assert.equal(Buffer.byteLength(at(4097)), 4097)
    assertError(reconcile(['list', '--run-dir', at(4097)]), 1, 'INVALID_RECONCILE_INPUT')
    const wide = at(4098, 'é')
    assert.ok(wide.length <= 4096 && Buffer.byteLength(wide) > 4096)
    assertError(reconcile(['list', '--run-dir', wide]), 1, 'INVALID_RECONCILE_INPUT')
    for (const ch of ['\x7f', '\x85', '\x9f', '\t']) {
      assertError(reconcile(['list', '--run-dir', `${WORK}/x${ch}y`]), 1, 'INVALID_RECONCILE_INPUT')
    }
    assertError(reconcile(['list', '--run-dir', '']), 1, 'INVALID_RECONCILE_INPUT')
    assertError(reconcile(['list', '--run-dir', `${WORK}/x\xa0y`]), 2, 'NOT_FOUND') // U+00A0 is not a control
  })

  await test('fail checks --confirm before any filesystem access: a mismatch on a missing run dir is CONFIRM_MISMATCH, not NOT_FOUND', async () => {
    const id = idOf('confirm')
    const absent = join(WORK, 'never-made')
    assertError(reconcile(['fail', '--run-dir', absent, '--call-id', id, '--confirm', idOf('other')]), 2, 'CONFIRM_MISMATCH')
    assertError(reconcile(['fail', '--run-dir', absent, '--call-id', id, '--confirm', id]), 2, 'NOT_FOUND')
    assert.equal(existsSync(absent), false)
  })

  await test('a symlinked .lock is held: list shows pid and token null, fail is OWNER_BUSY, unlock is OWNER_UNKNOWN; nothing changes', async () => {
    const { runDir, dir } = await seeded([['sym', { ...SELECTION }]])
    const target = join(WORK, 'lock-target-' + Date.now())
    const bytes = JSON.stringify({ nonce: 'b'.repeat(64), pid: 999999999 }) + '\n'
    writeFileSync(target, bytes)
    symlinkSync(target, join(dir, '.lock'))
    const before = snapshot(dir)
    const listed = reconcile(['list', '--run-dir', runDir])
    assert.equal(listed.code, 0, listed.stderr)
    assert.deepEqual(JSON.parse(listed.stdout).lock, { pid: null, token: null })
    const id = idOf('sym')
    assertError(reconcile(['fail', '--run-dir', runDir, '--call-id', id, '--confirm', id]), 4, 'OWNER_BUSY')
    assertError(reconcile(['unlock', '--run-dir', runDir, '--token', tokenOf(bytes)]), 2, 'OWNER_UNKNOWN')
    assert.deepEqual(snapshot(dir), before)
    assert.equal(readFileSync(target, 'utf8'), bytes)
  })

  await test('a row that is a directory makes list and fail exit 3 IO_ERROR with no path on stderr', async () => {
    const { runDir, dir } = await seeded([['dir-row', { ...SELECTION }]])
    const id = idOf('dir-row-x')
    mkdirSync(join(dir, id + '.json'))
    const before = snapshot(dir)
    assertError(reconcile(['list', '--run-dir', runDir]), 3, 'IO_ERROR')
    assertError(reconcile(['fail', '--run-dir', runDir, '--call-id', id, '--confirm', id]), 3, 'IO_ERROR')
    assert.deepEqual(snapshot(dir), before)
  })

  await test('a mode-000 row makes list exit 3 IO_ERROR', { skip: ROOT_USER && 'root reads mode-000 files' }, async () => {
    const { runDir, dir } = await seeded([['locked-row', { ...SELECTION }]])
    const file = join(dir, idOf('locked-row') + '.json')
    chmodSync(file, 0o000)
    try { assertError(reconcile(['list', '--run-dir', runDir]), 3, 'IO_ERROR') }
    finally { chmodSync(file, 0o600) }
  })

  await test('a stored selection with a blank model is SELECTION_MISSING; the row stays byte-identical and no lock is left', async () => {
    const { runDir, dir } = await seeded([['blank', { ...SELECTION, model: '' }], ['space', { ...SELECTION, effort: '  ' }]])
    const before = snapshot(dir)
    for (const n of ['blank', 'space']) {
      const id = idOf(n)
      assertError(reconcile(['fail', '--run-dir', runDir, '--call-id', id, '--confirm', id]), 2, 'SELECTION_MISSING')
    }
    assert.deepEqual(snapshot(dir), before)
    assert.equal(existsSync(join(dir, '.lock')), false)
  })

  await test('stdin is never read: a verb on stdin with no argv is still usage', () => {
    assertError(reconcile([], `list --run-dir ${WORK}\n`), 1, 'INVALID_RECONCILE_INPUT')
    assertError(reconcile(['list'], `--run-dir ${WORK}\n`), 1, 'INVALID_RECONCILE_INPUT')
  })

  await test('neither new module ends the process directly or installs a signal handler', () => {
    for (const file of [CLI, COMPLETION]) {
      const text = readFileSync(file, 'utf8')
      assert.ok(!/process\.exit\s*\(/.test(text), `${file} calls process.exit`)
      assert.ok(!/process\.(on|once|addListener|prependListener)\s*\(/.test(text), `${file} installs a process handler`)
      assert.ok(!/SIG[A-Z]+/.test(text), `${file} names a signal`)
    }
  })

  await test('failedCompletion reads options through descriptors: a getter on the selection is refused without being run', async () => {
    const { failedCompletion } = await completionApi()
    let ran = false
    const selection = { provider: 'codex', effort: 'high' }
    Object.defineProperty(selection, 'model', { enumerable: true, get() { ran = true; return 'm' } })
    assert.throws(() => failedCompletion({ selection, code: 'X', invocationId: 'i' }), e => e.code === 'INVALID_RUNTIME_INPUT')
    assert.equal(ran, false)
    const out = failedCompletion({ selection: { ...SELECTION }, code: 'X', invocationId: 'i' })
    assert.equal(Object.isFrozen(out), false)
    out.code = 'Y'
    assert.equal(failedCompletion({ selection: { ...SELECTION }, code: 'X', invocationId: 'i' }).code, 'X')
  })
} finally {
  rmSync(WORK, { recursive: true, force: true })
}
