// CP-05d implementation edges the frozen acceptance leaves to review
// (spec/contracts/codex-parity-cp-05d.md, "Enforced by review"). qa-loop.mjs is run from
// a copy of its own tree whose core/skills/native-runtime/graph-host.mjs is a STUB that
// follows a per-case plan file. That also shows qa-loop takes the host from its own
// tree (<codeRoot>), not from installationRoot. Cases:
// - a tampered result.json or a wrong host stdout is INVALID_RESULT, with the ledger
//   unchanged and the inflight file kept, and the rerun resumes the same invocation;
// - host exits map to pass-through codes, exit 4 with the hint, or HOST_FAILED, and the
//   inflight file is kept exactly when the run directory exists;
// - a ledger write failure is LEDGER_IO_ERROR with the inflight file kept, and the rerun
//   records; a ledger read failure is LEDGER_IO_ERROR before the host runs;
// - a native-runs symlink is IO_ERROR before any inflight file or host run;
// - verify past timeoutMs is FAIL (a builtin-only spin, no child process), a missing
//   verify.sh is FAIL, and a done result with no touched list is TOUCHED_MISMATCH.
// The 64 MiB stdout bound and the EEXIST race stay review-only: AGENTS.md blocks the
// nested-capture overflow and filesystem-race reproductions, so no case floods output or
// races the inflight file. Every repository is an owned temp repo; no codex, no network.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'qa loop ')))
const TREE = join(WORK, 'code tree')
const QA_LOOP = join(TREE, 'graphs/qa/tool/qa-loop.mjs')
const INSTALL = join(WORK, 'install root')
const MARKER = 'QA-LOOP-STUB-MARKER'

// The stub host: logs its argv and whether qa-loop's env reached it, then does what the
// plan says. "$ID" in plan.recordText is replaced by the invocation id from the args file.
const STUB_HOST = `import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const hostArgs = JSON.parse(readFileSync(process.argv[3], 'utf8'))
const plan = JSON.parse(readFileSync(process.env.QA_STUB_PLAN, 'utf8'))
appendFileSync(process.env.QA_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), invocationId: hostArgs.invocationId,
  marker: process.env.QA_STUB_MARKER ?? null }) + '\\n')
if (plan.runDir) mkdirSync(hostArgs.runDir, { recursive: true })
const resultPath = join(hostArgs.runDir, 'result.json')
if (typeof plan.recordText === 'string') {
  const text = plan.recordText.replaceAll('$ID', hostArgs.invocationId)
  if (plan.symlinkResult) {
    writeFileSync(resultPath + '.real', text)
    symlinkSync(resultPath + '.real', resultPath)
  } else writeFileSync(resultPath, text)
}
if (plan.signal) process.kill(process.pid, plan.signal)
process.stdout.write(plan.stdout ?? '')
process.stderr.write(plan.stderr ?? '')
process.exitCode = plan.exit ?? 0
`

const VERIFY = {
  // Records each run in $QA_VERIFY_LOG (qa-loop's env reaches verify.sh).
  pass: 'echo run >> "$QA_VERIFY_LOG"\necho "  [0] ok"\necho "VERIFY: PASS"\n',
  // Builtins only: bash never forks, so the SIGKILL leaves no child behind.
  spin: 'echo "VERIFY: PASS"\nwhile :; do :; done\n',
}

function setup() {
  mkdirSync(join(TREE, 'graphs/qa/tool'), { recursive: true })
  for (const name of ['qa-loop.mjs', 'qa-ledger.mjs']) cpSync(join(ROOT, 'graphs/qa/tool', name), join(TREE, 'graphs/qa/tool', name))
  mkdirSync(join(TREE, 'core/skills/native-runtime'), { recursive: true })
  writeFileSync(join(TREE, 'core/skills/native-runtime/graph-host.mjs'), STUB_HOST)
}

const GIT_ENV = { PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: WORK,
  GIT_AUTHOR_NAME: 'qa', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'qa', GIT_COMMITTER_EMAIL: 'qa@example.invalid' }
function git(repo, ...args) {
  const r = spawnSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(r.status, 0, `fixture: git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

let caseNo = 0
// An owned repo with one commit, its install root (verify.sh by mode) and plan files.
function makeCase({ verify = 'pass' } = {}) {
  const dir = join(WORK, `case ${++caseNo}`)
  const repo = join(dir, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'fixture')
  const install = join(INSTALL, `case ${caseNo}`)
  if (verify !== null) {
    mkdirSync(join(install, 'core/skills/verify'), { recursive: true })
    writeFileSync(join(install, 'core/skills/verify/verify.sh'), VERIFY[verify])
  } else mkdirSync(install, { recursive: true })
  const ledgerDir = join(repo, '.git', 'harness-loop')
  return { dir, repo, install, plan: join(dir, 'plan.json'), log: join(dir, 'host-calls.jsonl'), verifyLog: join(dir, 'verify-calls.log'), ledgerDir,
    ledgerFile: join(ledgerDir, 'ledger.json'), inflight: join(ledgerDir, 'native-inflight.json'), runsDir: join(ledgerDir, 'native-runs') }
}

const record = (result, over = {}) => JSON.stringify({ schemaVersion: 1, workflowId: 'harness-repair', offeringId: 'dev',
  invocationId: '$ID', status: result.status, result, ...over })
const DONE = { status: 'done', reason: 'VERIFY: PASS', fixRounds: 0, touched: [] }
const donePlan = (result = DONE) => ({ runDir: true, recordText: record(result), stdout: `${JSON.stringify({ status: result.status })}\n` })

function loop(c, plan, patch = {}) {
  writeFileSync(c.plan, JSON.stringify(plan))
  const args = { schemaVersion: 1, repo: c.repo, installationRoot: c.install, codexBin: join(WORK, 'no-codex'), env: { PATH: '/usr/bin' },
    timeoutMs: 60000, ...patch }
  const file = join(c.dir, `args-${++caseNo}.json`)
  writeFileSync(file, JSON.stringify(args))
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: WORK,
    QA_STUB_PLAN: c.plan, QA_STUB_LOG: c.log, QA_STUB_MARKER: MARKER, QA_VERIFY_LOG: c.verifyLog }
  const r = spawnSync(process.execPath, [QA_LOOP, '--args-file', file], { env, encoding: 'utf8', timeout: 120000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}
const hostCalls = c => existsSync(c.log) ? readFileSync(c.log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
function assertError(r, exit, code) {
  assert.deepEqual(r, { code: exit, stdout: '', stderr: `${JSON.stringify({ error: code })}\n` })
}
function assertDone(r) {
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stderr, '')
  return JSON.parse(r.stdout)
}

try {
  setup()

  await test('the stub host round trip: the host comes from qa-loop\'s own tree, gets qa-loop\'s env and exactly --args-file <host args>', () => {
    const c = makeCase()
    const report = assertDone(loop(c, donePlan()))
    assert.deepEqual([report.status, report.graphStatus, report.recorded, report.resumed], ['done', 'done', true, false])
    assert.deepEqual(report.checks, { verify: 'PASS', touched: 'MATCH', changed: [], verifyTail: '  [0] ok\nVERIFY: PASS' })
    assert.deepEqual(hostCalls(c), [{ argv: ['--args-file', join(c.runsDir, `${report.invocationId}.host-args.json`)],
      invocationId: report.invocationId, marker: MARKER }])
    assert.equal(readJson(c.ledgerFile).runs.length, 1)
    assert.equal(readFileSync(c.verifyLog, 'utf8'), 'run\n', 'verify ran once')
    assert.equal(existsSync(c.inflight), false)
  })

  await test('a tampered result.json or a wrong host stdout is exit 3 INVALID_RESULT: ledger unchanged, inflight kept, no verify', () => {
    const variants = {
      'another invocationId': { ...donePlan(), recordText: record(DONE, { invocationId: 'qa-20260101T000000Z-00000000' }) },
      'status differs from result.status': { ...donePlan(), recordText: record(DONE, { status: 'escalate' }) },
      'an extra key': { ...donePlan(), recordText: record(DONE, { extra: 1 }) },
      'another workflowId': { ...donePlan(), recordText: record(DONE, { workflowId: 'other' }) },
      'another offeringId': { ...donePlan(), recordText: record(DONE, { offeringId: 'autobuild' }) },
      'schemaVersion 2': { ...donePlan(), recordText: record(DONE, { schemaVersion: 2 }) },
      'a status other than done or escalate': donePlan({ ...DONE, status: 'pending' }),
      'a result that is an array': { ...donePlan(), recordText: record(DONE, { result: [], status: null }) },
      'not JSON': { ...donePlan(), recordText: '{"schemaVersion":' },
      'a symlinked result.json': { ...donePlan(), symlinkResult: true },
      'no result.json': { runDir: true, stdout: '{"status":"done"}\n' },
      'stdout names another status': { ...donePlan(), stdout: '{"status":"escalate"}\n' },
      'stdout without its newline': { ...donePlan(), stdout: '{"status":"done"}' },
    }
    for (const [label, plan] of Object.entries(variants)) {
      const c = makeCase()
      try {
        assertError(loop(c, plan), 3, 'INVALID_RESULT')
        assert.equal(existsSync(c.ledgerFile), false, 'the ledger was written')
        assert.equal(existsSync(c.verifyLog), false, 'verify ran')
        const inflight = readJson(c.inflight)
        assert.equal(hostCalls(c)[0].invocationId, inflight.invocationId, 'the inflight file names the invocation the host ran')
      } catch (error) { error.message = `[${label}] ${error.message}`; throw error }
    }
  })

  await test('after INVALID_RESULT the rerun resumes the same invocation and records it', () => {
    const c = makeCase()
    assertError(loop(c, { ...donePlan(), stdout: '' }), 3, 'INVALID_RESULT')
    const { invocationId } = readJson(c.inflight)
    const report = assertDone(loop(c, donePlan()))
    assert.deepEqual([report.invocationId, report.resumed, report.recorded, report.status], [invocationId, true, true, 'done'])
    assert.deepEqual(hostCalls(c).map(call => call.invocationId), [invocationId, invocationId])
    assert.equal(readJson(c.ledgerFile).runs[0].invocationId, invocationId)
    assert.equal(existsSync(c.inflight), false)
  })

  await test('host exits: codes pass through, OWNER_BUSY and CHECKPOINT_UNCERTAIN are exit 4 with the hint, anything else is HOST_FAILED; inflight kept exactly when the run directory exists', () => {
    const line = error => `${JSON.stringify({ error })}\n`
    const variants = [
      ['exit 1 INVALID_HOST_INPUT, no run dir', { exit: 1, stderr: line('INVALID_HOST_INPUT') }, 1, 'INVALID_HOST_INPUT'],
      ['exit 2 OFFERING_UNSUPPORTED, no run dir', { exit: 2, stderr: line('OFFERING_UNSUPPORTED') }, 2, 'OFFERING_UNSUPPORTED'],
      ['exit 3 IO_ERROR with a run dir', { runDir: true, exit: 3, stderr: line('IO_ERROR') }, 3, 'IO_ERROR'],
      ['exit 3 WORKFLOW_ERROR, no run dir', { exit: 3, stderr: line('WORKFLOW_ERROR') }, 3, 'WORKFLOW_ERROR'],
      ['exit 4 OWNER_BUSY', { runDir: true, exit: 4, stderr: line('OWNER_BUSY') }, 4, 'OWNER_BUSY'],
      ['exit 3 CHECKPOINT_UNCERTAIN', { runDir: true, exit: 3, stderr: line('CHECKPOINT_UNCERTAIN') }, 4, 'CHECKPOINT_UNCERTAIN'],
      ['exit 4 with another code', { runDir: true, exit: 4, stderr: line('IO_ERROR') }, 3, 'HOST_FAILED'],
      ['exit 3 with text on stderr', { runDir: true, exit: 3, stderr: 'boom\n' }, 3, 'HOST_FAILED'],
      ['exit 3 with two error lines', { exit: 3, stderr: line('IO_ERROR') + line('IO_ERROR') }, 3, 'HOST_FAILED'],
      ['exit 3 with an extra key', { exit: 3, stderr: `${JSON.stringify({ error: 'IO_ERROR', at: 1 })}\n` }, 3, 'HOST_FAILED'],
      ['exit 2 with a lowercase code', { exit: 2, stderr: line('refused') }, 3, 'HOST_FAILED'],
      ['exit 3 with no newline', { exit: 3, stderr: JSON.stringify({ error: 'IO_ERROR' }) }, 3, 'HOST_FAILED'],
      ['exit 7', { runDir: true, exit: 7, stderr: line('IO_ERROR') }, 3, 'HOST_FAILED'],
      ['killed by SIGKILL', { runDir: true, signal: 'SIGKILL' }, 3, 'HOST_FAILED'],
    ]
    for (const [label, plan, exit, code] of variants) {
      const c = makeCase()
      try {
        const r = loop(c, plan)
        const [call] = hostCalls(c)
        assert.ok(call, 'the host ran')
        if (exit === 4) {
          const runDir = join(c.runsDir, call.invocationId)
          const hint = `node ${realpathSync(TREE)}/core/skills/native-runtime/graph-reconcile.mjs list --run-dir ${runDir}`
          assert.deepEqual(r, { code: 4, stdout: '', stderr: `${JSON.stringify({ error: code, invocationId: call.invocationId, hint })}\n` })
        } else assertError(r, exit, code)
        assert.equal(existsSync(c.ledgerFile), false, 'the ledger was written')
        assert.equal(existsSync(c.inflight), plan.runDir === true, 'the inflight file is kept exactly when the run directory exists')
      } catch (error) { error.message = `[${label}] ${error.message}`; throw error }
    }
  })

  await test('a ledger write failure is exit 3 LEDGER_IO_ERROR with the inflight file kept; the rerun replays and records', () => {
    const c = makeCase()
    mkdirSync(c.ledgerFile, { recursive: true })   // a directory where ledger.json goes: read as unparseable, the write fails
    assertError(loop(c, donePlan()), 3, 'LEDGER_IO_ERROR')
    const { invocationId } = readJson(c.inflight)
    rmSync(c.ledgerFile, { recursive: true })
    const report = assertDone(loop(c, donePlan()))
    assert.deepEqual([report.invocationId, report.resumed, report.recorded, report.ledgerWarning], [invocationId, true, true, null])
    assert.equal(readJson(c.ledgerFile).runs.length, 1)
    assert.equal(existsSync(c.inflight), false)
  })

  await test('a ledger read failure is exit 3 LEDGER_IO_ERROR before any write or host run', () => {
    const c = makeCase()
    writeFileSync(c.ledgerDir, 'a file where the ledger directory goes\n')
    assertError(loop(c, donePlan()), 3, 'LEDGER_IO_ERROR')
    assert.deepEqual(hostCalls(c), [])
    assert.equal(readFileSync(c.ledgerDir, 'utf8'), 'a file where the ledger directory goes\n')
  })

  await test('a native-runs symlink is exit 3 IO_ERROR: no inflight file, nothing written through it, no host run', () => {
    const c = makeCase()
    const elsewhere = join(c.dir, 'elsewhere')
    mkdirSync(elsewhere)
    mkdirSync(c.ledgerDir, { mode: 0o700 })
    symlinkSync(elsewhere, c.runsDir)
    assertError(loop(c, donePlan()), 3, 'IO_ERROR')
    assert.deepEqual(hostCalls(c), [])
    assert.equal(existsSync(c.inflight), false)
    assert.deepEqual(readdirSync(elsewhere), [])
  })

  await test('verify past timeoutMs is FAIL (killed; its VERIFY: PASS line does not count) and the run is a VERIFY_FAILED escalate', () => {
    const c = makeCase({ verify: 'spin' })
    const started = Date.now()
    const report = assertDone(loop(c, donePlan(), { timeoutMs: 1001 }))
    assert.ok(Date.now() - started < 60000, 'verify was bounded')
    assert.deepEqual([report.status, report.graphStatus, report.reason], ['escalate', 'done', 'VERIFY_FAILED'])
    assert.deepEqual(report.checks, { verify: 'FAIL', touched: 'MATCH', changed: [], verifyTail: 'VERIFY: PASS' })
  })

  await test('a missing verify.sh is FAIL with an empty tail', () => {
    const c = makeCase({ verify: null })
    const report = assertDone(loop(c, donePlan()))
    assert.deepEqual([report.status, report.reason], ['escalate', 'VERIFY_FAILED'])
    assert.deepEqual(report.checks, { verify: 'FAIL', touched: 'MATCH', changed: [], verifyTail: '' })
  })

  await test('a done result with no touched list, or a non-string entry, is TOUCHED_MISMATCH even on a clean tree; the report touched is [] when absent', () => {
    const noList = makeCase()
    const withoutTouched = { status: 'done', reason: 'VERIFY: PASS', fixRounds: 0 }
    const a = assertDone(loop(noList, donePlan(withoutTouched)))
    assert.deepEqual([a.status, a.reason, a.touched, a.checks.touched, a.checks.changed], ['escalate', 'TOUCHED_MISMATCH', [], 'MISMATCH', []])
    const run = readJson(noList.ledgerFile).runs[0]
    assert.deepEqual([run.downgradedFrom, run.stuckSig, 'touched' in run], ['done', null, false])
    const badEntry = makeCase()
    const b = assertDone(loop(badEntry, donePlan({ ...DONE, touched: [1] })))
    assert.deepEqual([b.reason, b.checks.touched], ['TOUCHED_MISMATCH', 'MISMATCH'])
  })
} finally {
  spawnSync('/bin/chmod', ['-R', 'u+rwx', WORK])
  rmSync(WORK, { recursive: true, force: true })
}
