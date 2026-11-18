import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '../scripts/workflow-harness.mjs'
import { OWNED_CAPTURE, captureDirect } from '../core/skills/verify/retention.mjs'

// Off Linux, verify runs each step directly: no /proc means no ownership proof (capture-owner.sh),
// but the log, its bound, the exit code and the evidence stay. captureDirect is called in-process
// here, so Linux CI covers it too; the verify.sh runs below go through this platform's own path.
const VERIFY = fileURLToPath(new URL('../core/skills/verify/verify.sh', import.meta.url))

// The suite may itself run inside a verify capture (verify on Linux exports the scope to its
// steps), so each call sets the inherited scope explicitly: none, unless a test passes one.
async function direct(argv, limit = 1024, { scope } = {}) {
  const outer = process.env.VERIFY_CAPTURE_SCOPE_DIR
  if (scope === undefined) delete process.env.VERIFY_CAPTURE_SCOPE_DIR
  else process.env.VERIFY_CAPTURE_SCOPE_DIR = scope
  const chunks = []
  try {
    const result = await captureDirect(argv, limit, part => chunks.push(Buffer.from(part)))
    return { ...result, text: Buffer.concat(chunks).toString('utf8') }
  } finally {
    if (outer === undefined) delete process.env.VERIFY_CAPTURE_SCOPE_DIR
    else process.env.VERIFY_CAPTURE_SCOPE_DIR = outer
  }
}
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

await test('a direct step keeps its exit code and its stdout and stderr in one log', async () => {
  const ok = await direct(['bash', '-c', 'echo out; echo err >&2; exit 0'])
  assert.deepEqual({ exitCode: ok.exitCode, complete: ok.complete, capture: ok.capture }, { exitCode: 0, complete: true, capture: 'direct' })
  assert.equal(ok.text, 'out\nerr\n')
  assert.equal(ok.bytes, Buffer.byteLength(ok.text))
  const failed = await direct(['bash', '-c', 'echo nope; exit 3'])
  assert.deepEqual({ exitCode: failed.exitCode, complete: failed.complete, text: failed.text }, { exitCode: 3, complete: true, text: 'nope\n' })
  const missing = await direct(['verify-no-such-command-xyz'])
  assert.equal(missing.exitCode, 127, 'a missing command is the shell exit code, not a capture failure')
})

// /bughunt F1 on 5769b34: a step that died of its own signal was reported as 125 and incomplete.
await test('a step that dies of its own signal reports 128+signal with a complete log, as on Linux', async () => {
  for (const [signal, code] of [['KILL', 137], ['TERM', 143], ['SEGV', 139]]) {
    const result = await direct(['bash', '-c', `echo before; kill -${signal} $$`])
    assert.deepEqual({ exitCode: result.exitCode, complete: result.complete, text: result.text }, { exitCode: code, complete: true, text: 'before\n' }, signal)
  }
})

await test('output past the bound ends the step and its process group, and the step is incomplete', async () => {
  const dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'verify-direct-'))
  const pidFile = join(dir, 'grandchild.pid')
  // A background grandchild in the step's group, then more output than the bound allows.
  const script = `sleep 30 & echo $! > "${pidFile}"; while :; do printf 'xxxxxxxxxxxxxxxx'; done`
  const result = await direct(['bash', '-c', script], 64)
  assert.deepEqual({ exitCode: result.exitCode, complete: result.complete, bytes: result.bytes }, { exitCode: 125, complete: false, bytes: 64 })
  assert.equal(await waitGone(Number(fs.readFileSync(pidFile, 'utf8'))), true, 'the group was signalled, so no step process outlives the overflow')
})

async function waitGone(pid, ms = 3000) {
  const until = Date.now() + ms
  while (alive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50))
  return !alive(pid)
}

// /bughunt F1 on 0a63865: a step that exits but leaves a process holding its output never settled.
await test('a step that exits but leaves a process holding its output is ended after a grace period, incomplete', async () => {
  const dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'verify-linger-'))
  const pidFile = join(dir, 'background.pid')
  const started = Date.now()
  const result = await direct(['bash', '-c', `sleep 600 & echo $! > "${pidFile}"; echo done; exit 0`])
  assert.deepEqual({ exitCode: result.exitCode, complete: result.complete, text: result.text }, { exitCode: 125, complete: false, text: 'done\n' })
  assert.ok(Date.now() - started < 6000, 'bounded: about 2s of grace, then the group is stopped')
  assert.equal(await waitGone(Number(fs.readFileSync(pidFile, 'utf8'))), true, 'the leftover in the step group was ended')
})

await test('a leftover that left the step group still cannot hold the step open past the deadline', async () => {
  const dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'verify-escape-'))
  const pidFile = join(dir, 'escaped.pid')
  // A new session of its own, so a group signal cannot reach it, holding the step's output.
  const escape = `const c = require('child_process').spawn('sleep', ['600'], { detached: true, stdio: 'inherit' }); c.unref(); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))`
  const started = Date.now()
  try {
    const result = await direct([process.execPath, '-e', escape])
    assert.deepEqual({ exitCode: result.exitCode, complete: result.complete }, { exitCode: 125, complete: false })
    assert.ok(Date.now() - started < 9000, 'bounded: grace, then the 4s deadline')
  } finally { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL') } catch {} }
})

await test('an inherited capture scope is refused, never run unowned', async () => {
  const result = await direct(['bash', '-c', 'echo should-not-run'], 1024, { scope: '/nonexistent/scope' })
  assert.deepEqual(result, { exitCode: 125, bytes: 0, complete: false, capture: 'direct', text: '' })
})

function fixture(testScript) {
  const dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'verify-fixture-'))
  fs.writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: testScript } }))
  return dir
}
function verify(dir) {
  const env = { ...process.env }
  for (const key of ['VERIFY_EVIDENCE_DIR', 'VERIFY_CAPTURE_SESSION', 'VERIFY_CAPTURE_SCOPE_DIR']) delete env[key]
  const result = spawnSync('bash', [VERIFY, dir], { encoding: 'utf8', env, timeout: 120_000 })
  const lines = result.stdout.trimEnd().split('\n')
  const manifest = lines.find(line => line.startsWith('VERIFY_EVIDENCE: ')).slice('VERIFY_EVIDENCE: '.length)
  return { status: result.status, out: result.stdout, last: lines.at(-1), doc: JSON.parse(fs.readFileSync(manifest, 'utf8')) }
}

await test('verify.sh passes a passing project and fails a failing one on this platform, and says how it captured', () => {
  const pass = verify(fixture('node -e "process.exit(0)"'))
  assert.equal(pass.status, 0, pass.out)
  assert.equal(pass.last, 'VERIFY: PASS')
  assert.equal(pass.doc.steps.length, 1)
  assert.equal(pass.doc.steps[0].exitCode, 0)
  const fail = verify(fixture('node -e "process.exit(2)"'))
  assert.equal(fail.status, 1, fail.out)
  assert.equal(fail.last, 'VERIFY: FAIL')
  assert.match(fail.out, /\[2\] npm run test/, "the script's own exit code reaches the summary")
  assert.equal(fail.doc.steps[0].exitCode, 2)
  for (const run of [pass, fail]) {
    if (OWNED_CAPTURE) {
      assert.equal(run.doc.steps[0].capture, undefined, 'owned steps are recorded as before')
      assert.doesNotMatch(run.out, /capture: direct/)
    } else {
      assert.equal(run.doc.steps[0].capture, 'direct')
      assert.match(run.out, /\n {2}capture: direct \(no \/proc on this platform: steps ran without process-group ownership\)\nVERIFY: /)
    }
  }
})
