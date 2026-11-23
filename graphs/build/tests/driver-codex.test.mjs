// driver-codex.test.mjs: the /build-app driver on Codex (--backend codex), end to end against a throwaway
// git repo, the frozen fake codex (acceptance/codex-parity/cp-02f-fake-codex.cjs) and the fake gh.
// Run by scripts/test-workflow.mjs.
//
// Proof reference id: cp-07-build-app-wiring (spec/contracts/codex-parity-cp-07.md).
//
// WIRING PROOF, NOT RUNTIME CERTIFICATION. The slice sessions run `codex exec` for real against the fake;
// the QA loop and the bug hunt run as stubs that record their arguments (fixtures/fake-qa-loop.mjs and
// fixtures/fake-hunt-cli.mjs), except in the two cases that run the real CLIs against the fake codex. No
// network, no real codex, no claude: a `claude` on PATH records any call and fails.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { REPORT_SCHEMA, INSTALL_ROOT, huntArgs, huntPrep, huntStateDir, readQaReport, readQaError, tokenUsage, codexVerdict, hostCommit, sliceRules, leafEnv } from '../skills/build-app/driver/codex-session.mjs'
import { settingsFromEnv } from '../skills/build-app/driver/driver.mjs'
import { emptyLedger, recordOutcome, writeLedger } from '../../../core/skills/backlog/backlog.mjs'
import { trackSession, stopSessions, probeUntilAvailable } from '../skills/build-app/driver/session.mjs'
import { expectedCodexRow } from '../../../tests/codex-expected-state.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DRIVER = join(here, '..', 'skills', 'build-app', 'driver', 'driver.mjs')
const FAKE_CODEX = join(here, '..', '..', '..', 'acceptance', 'codex-parity', 'cp-02f-fake-codex.cjs')
const FAKE_GH = join(here, 'fixtures', 'fake-gh.mjs')
const FAKE_QA = join(here, 'fixtures', 'fake-qa-loop.mjs')
const FAKE_HUNT = join(here, 'fixtures', 'fake-hunt-cli.mjs')
const APP = 'toy'
const INT = `integration/${APP}`
// The driver's own verify: passes unless the slice committed a file named FAILVERIFY.
const VERIFY = 'if [ -e FAILVERIFY ]; then echo "VERIFY: FAIL"; else echo "VERIFY: PASS"; fi'

const ac = id => [{ id: `${id}-AC1`, criterion: `${id} works`, fails_when: `${id} breaks` }]
const slice = (n, deps) => ({ id: `S${n}`, title: `slice ${n}`, goal: `build ${n}`, requirements: [`R${n}`], acceptance: ac(`S${n}`), depends_on: deps })
const BACKLOG = { version: 1, app: APP, integrationBranch: INT, requirements: ['R1', 'R2'], slices: [slice(1, []), slice(2, ['S1'])] }

function repo(backlog = BACKLOG) {
  const root = mkdtempSync(join(tmpdir(), 'build-codex-'))
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(root, 'README.md'), 'toy\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  git('switch', '-q', '-c', INT)
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'docs', 'backlog.json'), JSON.stringify(backlog, null, 2))
  git('add', '-A')
  git('commit', '-q', '-m', 'blueprint: design and backlog for toy')
  return root
}
const gitOut = (root, ...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
const stateDir = root => join(root, '.git', 'harness-build', APP)
const ledger = root => JSON.parse(readFileSync(join(stateDir(root), 'ledger.json'), 'utf8'))
const status = root => JSON.parse(readFileSync(join(stateDir(root), 'status.json'), 'utf8'))
const driverLog = root => readFileSync(join(stateDir(root), 'logs', 'driver.log'), 'utf8')
const lines = file => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])

// One box per test: the fake codex (its script and call log), a `claude` that fails loudly, a stub QA loop and hunt.
// `limitOnce`: the first codex call prints a usage-limit error and exits 1, as a limited account does; later calls reach the fake.
function box(replies = {}, { limitOnce = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'build-codex-box-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const limit = limitOnce
    ? `if [ ! -e "${join(dir, 'limit-hit')}" ]; then : > "${join(dir, 'limit-hit')}"; echo '{"type":"error","message":"You have hit your usage limit. Try again later."}'; exit 1; fi\n` : ''
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\n${limit}exec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`)
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$@" >> "${join(dir, 'claude-calls.log')}"\necho "claude must never run in codex mode" >&2\nexit 97\n`)
  chmodSync(join(bin, 'codex'), 0o755)
  chmodSync(join(bin, 'claude'), 0o755)
  const fake = join(dir, 'fake-codex')
  mkdirSync(fake)
  const prefix = id => `UNATTENDED BUILD (PandaStack /build-app, Codex). Slice ${id}:`
  const roles = ['S1', 'S2', 'S3'].map(id => ({ role: id, prefix: prefix(id) })).concat([{ role: 'probe', prefix: 'Reply OK.' }])
  const b = { dir, bin, codex: join(bin, 'codex'), fake, claudeLog: join(dir, 'claude-calls.log'), qaLog: join(dir, 'qa.log'), huntLog: join(dir, 'hunt.log'), ghLog: join(dir, 'gh.log'), home: join(dir, 'home') }
  mkdirSync(b.home)
  b.script = r => writeFileSync(join(fake, 'script.json'), JSON.stringify({ roles, replies: r }))
  b.script(replies)
  b.calls = () => lines(join(fake, 'calls.jsonl'))
  b.callsOf = role => b.calls().filter(c => c.role === role)
  return b
}
// A slice session that reports `status` and writes `files` in the repo.
const reply = (status, files = {}, extra = {}) => ({ json: JSON.stringify({ status, reason: extra.reason || `${status}`, questions: extra.questions || [] }), writes: files })
const good = id => reply('done', { [`src/${id}.js`]: `export const ${id} = 1\n`, [`tests/${id}.test.js`]: `test ${id}\n` })

function drive(b, root, { env = {}, flags = ['--no-pr', '--backend', 'codex'], cmd = 'run', driver = DRIVER } = {}) {
  const e = {
    ...process.env, PATH: `${b.bin}:${process.env.PATH}`, HOME: b.home, HARNESS_BUILD_CODEX_BIN: b.codex, FAKE_CODEX_DIR: b.fake,
    HARNESS_BUILD_VERIFY: VERIFY, HARNESS_BUILD_MAX_SLEEP_MS: '50', PANDASTACK_NOTIFY: '', HARNESS_BUILD_BUGHUNT: '0',
    HARNESS_BUILD_QA_LOOP: FAKE_QA, FAKE_QA_LOG: b.qaLog, HARNESS_BUILD_HUNT_CLI: FAKE_HUNT, FAKE_HUNT_LOG: b.huntLog, ...env,
  }
  delete e.AUTOBUILD_CODEX_BIN
  const r = spawnSync(process.execPath, [driver, cmd, '--repo', root, '--app', APP, ...flags], { encoding: 'utf8', env: e, timeout: 120_000 })
  // The invariant of every case: a Codex build never starts claude.
  assert.ok(!existsSync(b.claudeLog), `claude was called: ${existsSync(b.claudeLog) ? readFileSync(b.claudeLog, 'utf8') : ''}`)
  return { code: r.status, out: r.stdout + r.stderr }
}
const readdirLog = (root, re) => readdirSync(join(stateDir(root), 'logs')).find(f => re.test(f))
const withRemote = root => {
  const remote = mkdtempSync(join(tmpdir(), 'build-codex-remote-'))
  execFileSync('git', ['init', '-q', '--bare', remote])
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote])
  return remote
}

console.log('== build-app driver on Codex (wiring proof with fake codex and fake gh, not runtime certification)')

await test('a two-slice backlog builds on Codex: one codex exec per slice, host commits, the QA loop and the hunt through their native CLIs, one PR', () => {
  const b = box({ S1: good('S1'), S2: good('S2') })
  const root = repo()
  const remote = withRemote(root)
  const fix = { subject: 'bughunt: fix F1', files: { 'src/S1.js': 'export const S1 = 2\n' } }
  const { code, out } = drive(b, root, {
    flags: ['--backend', 'codex'],
    env: {
      HARNESS_BUILD_BUGHUNT: '1', HARNESS_BUILD_GH: FAKE_GH, FAKE_GH_LOG: b.ghLog,
      FAKE_QA_STEP: JSON.stringify({ status: 'done', writes: { 'src/qa-fix.js': 'export const qa = 1\n' } }),
      // Open findings make the real CLI exit 12 even when the hunt finished; the driver judges the ledger, not the code.
      FAKE_HUNT_STEP: JSON.stringify({ commits: [fix], findings: [{ status: 'reproduced', fix: 'verified' }, { status: 'confirmed', fix: 'unresolved', severity: 'MEDIUM' }], exit: 12 }),
    },
  })
  assert.equal(code, 0, `${out}\n${status(root).message}`)
  assert.deepEqual(gitOut(root, 'log', '--format=%s', `main..${INT}`).split('\n').reverse(),
    ['blueprint: design and backlog for toy', 'S1: slice 1', 'S2: slice 2', 'final: QA fixes', 'bughunt: fix F1'])
  // Two slice sessions, no others: the QA loop and the hunt are the native CLIs.
  const calls = b.calls()
  assert.deepEqual(calls.map(c => c.role), ['S1', 'S2'])
  for (const c of calls) {
    assert.equal(c.argv[0], 'exec')
    assert.equal(c.sandbox, 'workspace-write')
    assert.ok(c.argv.includes('--json') && c.argv.includes('--output-last-message') && c.argv.includes('--output-schema'))
    assert.deepEqual(JSON.parse(c.schema), REPORT_SCHEMA, 'the strict report schema reaches codex')
    assert.equal(realpathSync(c.cwd), realpathSync(root), 'runs in the repo')
    assert.equal(c.env.AUTOBUILD_BACKEND, 'codex')
    assert.ok(Object.keys(c.env).every(k => !/^CLAUDE/.test(k)), 'no Claude session identity reaches a Codex session')
    assert.match(c.stdin, /Never run git add, commit, checkout, switch, branch, reset, rebase or push/)
  }
  assert.match(calls[0].stdin, /Slice S1 of toy: slice 1[\s\S]*S1-AC1: S1 works \(fails when: S1 breaks\)/)
  assert.match(calls[0].stdin, /Frozen paths from earlier slices \(never edit\): \[\]/)
  assert.match(calls[1].stdin, /Frozen paths from earlier slices \(never edit\): \["tests\/S1\.test\.js"\]/, 'a later slice is told the earlier tests are frozen')
  const l = ledger(root)
  assert.deepEqual(Object.fromEntries(Object.entries(l.slices).map(([k, v]) => [k, [v.status, v.frozen]])), { S1: ['done', ['tests/S1.test.js']], S2: ['done', ['tests/S2.test.js']] })
  // Codex reports tokens, never dollars.
  const st = status(root)
  assert.equal(st.backend, 'codex')
  assert.deepEqual(st.tokens, { input: 2, output: 2 })
  assert.equal(st.costUsd, undefined)
  assert.equal(st.state, 'done')
  // The final QA: the native loop's args file, then the driver's commit of exactly what it touched.
  const [qa] = lines(b.qaLog)
  assert.deepEqual(Object.keys(qa.args), ['schemaVersion', 'repo', 'installationRoot', 'codexBin', 'env', 'timeoutMs', 'base', 'maxFixRounds'])
  assert.equal(qa.args.schemaVersion, 1)
  assert.equal(qa.args.repo, gitOut(root, 'rev-parse', '--show-toplevel'))
  assert.equal(qa.args.installationRoot, INSTALL_ROOT)
  assert.equal(qa.args.codexBin, b.codex)
  assert.deepEqual(Object.keys(qa.args.env).sort(), ['HOME', 'PATH'])
  assert.equal(qa.args.base, 'main')
  assert.equal(qa.args.maxFixRounds, 3)
  assert.equal(qa.mode, 0o600, 'the args file is private')
  assert.deepEqual(qa.argv, ['--args-file', qa.argv[1]])
  assert.equal(gitOut(root, 'show', '--name-only', '--format=%an|%b', `${INT}~1`).split('\n').filter(Boolean).slice(-1)[0], 'src/qa-fix.js')
  // The hunt: the native CLI, Codex only, fix mode, on the integration branch.
  const [hunt] = lines(b.huntLog)
  // argv[0] of the process is the CLI itself, which node strips.
  assert.deepEqual(hunt.argv, huntArgs({ repo: gitOut(root, 'rev-parse', '--show-toplevel'), base: 'main', codexBin: b.codex, cli: FAKE_HUNT }).slice(1))
  assert.ok(hunt.argv.join(' ').includes('--backend codex --mode fix --codex-bin'))
  assert.equal(gitOut(root, 'branch', '--list', 'bughunt/*'), '', 'the fix branch is gone once its commit landed')
  assert.match(driverLog(root), /bug hunt: 1 verified fix\(es\) landed on integration\/toy/)
  // The controlled PR flow: the driver pushes the integration branch and opens one PR; nothing else.
  assert.equal(gitOut(root, 'rev-parse', INT), gitOut(remote, 'rev-parse', INT), 'the integration branch was pushed')
  const gh = lines(b.ghLog)
  assert.deepEqual(gh.map(a => a.slice(0, 2).join(' ')), ['pr list', 'pr create'])
  const body = gh[1][gh[1].indexOf('--body') + 1]
  assert.match(body, /on Codex from `docs\/backlog\.json` \(2 slices\), one fresh Codex session per slice/)
  assert.match(body, /## Bug hunt/)
  assert.doesNotMatch(body, /Claude Code|\/dev --slice/)
})

await test('a slice whose own checks fail is escalated with the driver\'s reason and rebuilt with it; a later slice may not change an earlier test', () => {
  const bad = reply('done', { FAILVERIFY: 'x\n', 'src/S1.js': 'x\n', 'tests/S1.test.js': 'test S1\n' })
  const b = box({ S1: [bad, good('S1')], S2: [reply('done', { 'tests/S1.test.js': 'weakened\n', 'src/S2.js': 'y\n', 'tests/S2.test.js': 'test S2\n' }), good('S2')] })
  const root = repo()
  const { code, out } = drive(b, root)
  assert.equal(code, 0, `${out}\n${status(root).message}`)
  const [first, second] = b.callsOf('S1')
  assert.doesNotMatch(first.stdin, /Earlier attempts/)
  assert.match(second.stdin, /Earlier attempts at this slice stopped for these reasons[\s\S]*the driver's own verify did not pass \(last line "VERIFY: FAIL"\)/)
  assert.ok(gitOut(root, 'branch', '--list', 'attempt/S1-*'), 'the failed attempt is kept for a human')
  const l = ledger(root)
  assert.equal(l.slices.S1.reasons.length, 1)
  assert.match(l.slices.S2.reasons[0], /the Codex session done: done; the driver's checks: frozen tests from earlier slices changed: tests\/S1\.test\.js/)
  assert.equal(gitOut(root, 'show', `${INT}:tests/S1.test.js`), 'test S1', 'the frozen test on integration is the original')
})

await test('the session\'s own report decides needs-human and escalate; a Codex run with no report is an escalation, never a Claude run', () => {
  const b = box({ S1: reply('needs-human', {}, { questions: ['which database?'] }) })
  const root = repo()
  const r = drive(b, root)
  assert.equal(r.code, 3, r.out)
  assert.deepEqual([ledger(root).slices.S1.status, ledger(root).slices.S1.questions], ['blocked', ['which database?']])
  assert.match(status(root).message, /every remaining slice is blocked: S1, S2/)
  // No report at all: the fake exits 3 for a role with no reply.
  const b2 = box({})
  const root2 = repo({ ...BACKLOG, slices: [slice(1, [])], requirements: ['R1'] })
  const r2 = drive(b2, root2)
  assert.equal(r2.code, 3, r2.out)
  assert.match(ledger(root2).slices.S1.reasons[0], /the Codex session wrote no ledger/)
  assert.ok(b2.callsOf('S1').length >= 2, 'codex was asked again and failed again; no other provider was')
})

await test('a provider refusal ends the run: no escalated attempt, no retry, nothing sent elsewhere, and a rerun does not ask again', () => {
  const b = box({ S1: good('S1'), S2: { refuse: true } })
  const root = repo()
  const r = drive(b, root)
  assert.equal(r.code, 3, r.out)
  assert.equal(b.callsOf('S2').length, 1, 'the refused slice is asked exactly once')
  const l = ledger(root)
  assert.equal(l.slices.S2, undefined, 'a refusal is not an escalated attempt (that path re-plans and retries)')
  assert.match(status(root).message, /S2: the provider declined this work; it is never retried, rerouted or sent to another provider/)
  assert.equal(status(root).state, 'braked')
  assert.ok(existsSync(join(stateDir(root), 'provider-refusal.json')))
  const again = drive(b, root)
  assert.equal(again.code, 3, again.out)
  assert.equal(b.callsOf('S2').length, 1, 'the rerun spawned nothing')
  assert.match(status(root).message, /a Codex provider refusal is recorded/)
})

await test('a session that changes .git hooks, config or info ends the run before anything runs in the repo: no commit, no set-aside, nothing landed', () => {
  const b = box({ S1: reply('done', { 'src/S1.js': 'x\n', 'tests/S1.test.js': 't\n', '.git/hooks/post-checkout': '#!/bin/sh\ntouch /tmp/never-run-by-the-driver\n' }) })
  const root = repo()
  const before = gitOut(root, 'rev-parse', INT)
  const r = drive(b, root)
  assert.equal(r.code, 12, r.out)
  assert.equal(status(root).state, 'failed')
  assert.match(status(root).message, /S1: the Codex session changed git control files \(.*\.git\/hooks\/post-checkout.*\); nothing was committed or landed, its work is left on slice\/S1 as it is, and no other provider is tried/)
  assert.equal(gitOut(root, 'rev-parse', INT), before, 'integration did not move')
  assert.equal(gitOut(root, 'rev-parse', 'slice/S1'), before, 'nothing was committed on the slice branch')
  assert.equal(gitOut(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'slice/S1', 'no checkout ran')
  assert.equal(gitOut(root, 'branch', '--list', 'attempt/*'), '', 'no set-aside commit or branch')
  assert.match(gitOut(root, 'status', '--porcelain', '--untracked-files=all'), /src\/S1\.js/, 'the session\'s work is still in the tree')
  assert.equal(b.callsOf('S1').length, 1)
  assert.ok(!existsSync(join(stateDir(root), 'ledger.json')) || ledger(root).slices.S1 === undefined, 'not recorded as an attempt')
  // The final QA: the same check, before the driver commits what the loop touched.
  const b2 = box({ S1: good('S1'), S2: good('S2') })
  const root2 = repo()
  const r2 = drive(b2, root2, { env: { FAKE_QA_STEP: JSON.stringify({ status: 'done', writes: { '.git/info/exclude': '*.secret\n', 'src/qa.js': 'q\n' } }) } })
  assert.equal(r2.code, 12, r2.out)
  assert.match(status(root2).message, /the final QA changed git control files \(.*\.git\/info\/exclude.*\); nothing was committed or landed/)
  assert.equal(gitOut(root2, 'log', '-1', '--format=%s', INT), 'S2: slice 2')
  assert.equal(gitOut(root2, 'log', '-1', '--format=%s', 'slice/final'), 'S2: slice 2', 'the QA branch has no commit of the driver\'s')
})

await test('a usage limit with no reset time: the one-turn codex probe runs, the slice is retried uncounted, nothing else is asked', () => {
  const b = box({ S1: good('S1'), probe: { json: 'OK' } }, { limitOnce: true })
  const root = repo({ ...BACKLOG, slices: [slice(1, [])], requirements: ['R1'] })
  // A probe that never succeeded would spin here until the wait cap: a few seconds, not hours.
  const r = drive(b, root, { env: { HARNESS_BUILD_MAX_LIMIT_WAIT_HOURS: '0.01' } })
  assert.equal(r.code, 0, `${r.out}\n${status(root).message}`)
  const probes = b.callsOf('probe')
  assert.equal(probes.length, 1, 'exactly one probe')
  assert.equal(probes[0].sandbox, 'read-only')
  assert.match(probes[0].stdin, /^Reply OK\./)
  assert.match(driverLog(root), /S1: usage limit \(.*hit your usage limit.*\); not counted/)
  assert.match(driverLog(root), /usage limit: available again/)
  assert.deepEqual([ledger(root).slices.S1.status, ledger(root).slices.S1.reasons], ['done', []], 'the limit is not an attempt')
  assert.equal(b.callsOf('S1').length, 1, 'the retry reached the fake once; the limited call never did')
})

await test('lock and resume: a live driver or a live session holds the lock; a build is pinned to its provider; resume continues without rebuilding', async () => {
  const b = box({ S1: good('S1'), S2: reply('escalate', {}, { reason: 'cannot do it' }) })
  const root = repo()
  mkdirSync(stateDir(root), { recursive: true })
  // A live driver for the app.
  const driver = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', DRIVER])
  writeFileSync(join(stateDir(root), 'driver.pid'), String(driver.pid))
  let r = drive(b, root)
  driver.kill()
  assert.equal(r.code, 11, r.out)
  assert.equal(b.calls().length, 0)
  // A session an earlier driver started (the native QA loop here): the same lock.
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'qa-loop.mjs'])
  writeFileSync(join(stateDir(root), 'session.pid'), String(orphan.pid))
  r = drive(b, root)
  orphan.kill()
  assert.equal(r.code, 11, r.out)
  assert.match(r.out, /a session an earlier driver started/)
  assert.equal(b.calls().length, 0)
  // S1 lands; S2 escalates until it is blocked.
  r = drive(b, root)
  assert.equal(r.code, 3, r.out)
  assert.deepEqual([ledger(root).slices.S1.status, ledger(root).slices.S2.status, ledger(root).slices.S2.stuck], ['done', 'blocked', true])
  const asked = b.calls().length
  // The human unblocks S2. A bare `run` that resolves to Claude (here by PANDASTACK_PROVIDER, the stand-in for the host app): refused, nothing spawned.
  execFileSync(process.execPath, [DRIVER, 'unblock', '--repo', root, '--app', APP, '--slice', 'S2', '--answer', 'use the queue'])
  r = drive(b, root, { flags: ['--no-pr'], env: { PANDASTACK_PROVIDER: 'claude' } })
  assert.equal(r.code, 6, r.out)
  assert.match(status(root).message, /was started on codex; run it with --backend codex/)
  assert.equal(b.calls().length, asked)
  // With --backend codex it resumes: S1 is not built again, S2 carries the answer.
  b.script({ S1: good('S1'), S2: good('S2') })
  r = drive(b, root)
  assert.equal(r.code, 0, `${r.out}\n${status(root).message}`)
  assert.deepEqual(b.callsOf('S1').length, 1, 'S1 was built once, before')
  assert.match(b.callsOf('S2').at(-1).stdin, /the answers are binding:\n- use the queue/)
  assert.equal(gitOut(root, 'log', '-1', '--format=%s', INT), 'S2: slice 2')
})

await test('the final QA does not pass: braked with every slice landed, nothing pushed, no other provider tried', () => {
  for (const [step, why] of [
    [{ status: 'escalate', reason: 'a HIGH finding stays' }, /the final QA did not pass \(.*escalate: a HIGH finding stays/],
    [{ exit: 2, error: 'OFFERING_UNSUPPORTED' }, /the final QA \(the native QA loop\) did not complete \(exit 2, OFFERING_UNSUPPORTED\).*no other provider is tried/],
  ]) {
    const b = box({ S1: good('S1'), S2: good('S2') })
    const root = repo()
    const r = drive(b, root, { env: { FAKE_QA_STEP: JSON.stringify(step), HARNESS_BUILD_GH: FAKE_GH, FAKE_GH_LOG: b.ghLog } , flags: ['--backend', 'codex'] })
    assert.equal(r.code, 3, r.out)
    assert.match(status(root).message, why)
    assert.equal(gitOut(root, 'log', '-1', '--format=%s', INT), 'S2: slice 2', 'integration did not move')
    assert.equal(gitOut(root, 'branch', '--list', 'slice/*'), '')
    assert.equal(existsSync(b.ghLog), false, 'nothing was pushed or opened')
  }
})

await test('a hunt that saves no finished run brakes; a hunt with nothing to review is skipped; neither falls back', () => {
  const b = box({ S1: good('S1'), S2: good('S2') })
  const root = repo()
  const r = drive(b, root, { env: { HARNESS_BUILD_BUGHUNT: '1', FAKE_HUNT_STEP: JSON.stringify({ none: true, exit: 12 }) } })
  assert.equal(r.code, 3, r.out)
  assert.match(status(root).message, /the bug hunt did not finish \(exit 12, .*it saved no run\).*run \/build-app resume to retry it/)
  assert.ok(gitOut(root, 'branch', '--list', 'attempt/bughunt-*'), 'the hunt branch is kept')
  // Integration merged by hand: the stub reports what the real CLI does ("hunt preparation: ... nothing to review").
  const b2 = box({ S1: good('S1'), S2: good('S2') })
  const merged = repo()
  drive(b2, merged, { env: { HARNESS_BUILD_BUGHUNT: '1', FAKE_HUNT_STEP: JSON.stringify({ none: true }) } })
  execFileSync('git', ['-C', merged, 'branch', '-f', 'main', INT])
  const r2 = drive(b2, merged, { env: { HARNESS_BUILD_BUGHUNT: '1' } })
  assert.equal(r2.code, 0, `${r2.out}\n${status(merged).message}`)
  assert.match(driverLog(merged), /bug hunt skipped: .*nothing to review/)
})

await test('the real hunt CLI accepts the driver\'s arguments (--backend codex --mode fix) and drives the fake codex; with no scripted leaves the run brakes, never falls back', () => {
  const b = box({ S1: good('S1'), S2: good('S2') })
  const root = repo()
  const r = drive(b, root, { env: { HARNESS_BUILD_BUGHUNT: '1', HARNESS_BUILD_HUNT_CLI: '', FAKE_QA_STEP: '{}' } })
  assert.equal(r.code, 3, `${r.out}\n${status(root).message}`)
  const huntLog = readFileSync(join(stateDir(root), 'logs', readdirLog(root, /^bughunt-.*\.log$/)), 'utf8')
  assert.match(huntLog, /^Native hunt: fix; lenses=.*; state=/m, 'the real CLI parsed the arguments and ran')
  assert.match(status(root).message, /the bug hunt did not finish/)
  assert.ok(b.callsOf(null).length > 0, 'the real CLI launched the fake codex given by --codex-bin')
})

// The leaf env of the real loop carries no FAKE_CODEX_DIR (HOME and PATH only), so every leaf the fake codex is asked
// to run fails: the loop can only escalate, never reach `done`, and so never reaches its verify.sh (the repository's own
// is out of bounds here). With the dev offering flipped (CP-06) it is no longer refused by the offering catalog: it
// gets past OFFERING_UNSUPPORTED to its first leaf, and that leaf is what fails.
await test('the real QA loop accepts the driver\'s args file and, on the production catalog, is no longer refused by the dev offering (the unscripted leaf fails instead)', () => {
  const b = box({ S1: good('S1'), S2: good('S2') })
  const root = repo()
  const r = drive(b, root, { env: { HARNESS_BUILD_QA_LOOP: '' } })
  assert.equal(r.code, 3, `${r.out}\n${status(root).message}`)
  assert.match(status(root).message, /the final QA did not pass \(.*escalate: checker failed: Native runtime: LEAF_FAILED/)
  assert.doesNotMatch(status(root).message, /OFFERING_UNSUPPORTED|INVALID_(LOOP|HOST)_INPUT/)
  assert.equal(gitOut(root, 'log', '-1', '--format=%s', INT), 'S2: slice 2')
})

// The final QA PASSES through the real loop, the real dev-build offering gate and the real harness-repair graph, on
// the production catalog. The one stand-in is verify.sh: the repository's own is out of bounds, so this runs a copy
// of the tree whose core/skills/verify/verify.sh is an inert script (cp-05d does the same), and the driver is the copy's.
const INERT_VERIFY = '# INERT: a test fixture, never the repository\'s verify.sh.\nbash scripts/test.sh\ncode=$?\nprintf \'  [%s] bash scripts/test.sh\\n\' "$code"\n[ "$code" -eq 0 ] && printf \'VERIFY: PASS\\n\' || printf \'VERIFY: FAIL\\n\'\nexit "$code"\n'
await test('the final QA passes through the real QA loop now that dev is Codex-partial: every slice landed, the loop leaves ran, no OFFERING_UNSUPPORTED', async () => {
  const copy = mkdtempSync(join(tmpdir(), 'build-codex-root-'))
  for (const dir of ['core', 'graphs', 'spec', 'scripts']) cpSync(join(INSTALL_ROOT, dir), join(copy, dir), { recursive: true, verbatimSymlinks: true })
  cpSync(join(INSTALL_ROOT, 'agent-config.json'), join(copy, 'agent-config.json'))
  writeFileSync(join(copy, 'core', 'skills', 'verify', 'verify.sh'), INERT_VERIFY)
  assert.ok(readFileSync(join(copy, 'core', 'skills', 'verify', 'verify.sh'), 'utf8').includes('INERT'), 'the copy\'s verify.sh is inert')
  const catalog = JSON.parse(readFileSync(join(copy, 'spec', 'offering-capabilities.json'), 'utf8'))
  assert.equal(catalog.offerings.find(o => o.id === 'dev').providers.codex.implementation, 'partial', 'the copy is the production catalog: dev is partial')

  const { assembleRoleInstructions } = await import(pathToFileURL(join(copy, 'core', 'skills', 'native-runtime', 'role-files.mjs')).href)
  const qaRoles = ['checker', 'fixer', 'reviewer', 'advisor', 'qa-auditor']
    .map(name => ({ role: name, prefix: `${assembleRoleInstructions({ installationRoot: copy, name }).instructions}\n\n` }))
  const wire = value => ({ json: JSON.stringify(value) })
  const b = box({})
  const slices = ['S1', 'S2'].map(id => ({ role: id, prefix: `UNATTENDED BUILD (PandaStack /build-app, Codex). Slice ${id}:` }))
  writeFileSync(join(b.fake, 'script.json'), JSON.stringify({ roles: [...slices, ...qaRoles], replies: {
    S1: good('S1'), S2: good('S2'),
    checker: wire({ verdict: 'PASS', verify_block: '  [0] bash scripts/test.sh\nVERIFY: PASS', failures: [] }),
    reviewer: wire({ files_reviewed: 1, findings: [] }), 'qa-auditor': wire({ files_reviewed: 1, findings: [] }),
  } }))
  // The loop's leaves get only HOME, CODEX_HOME and PATH, so the fake codex carries its own script directory.
  writeFileSync(b.codex, `#!/bin/sh\nFAKE_CODEX_DIR="${b.fake}" exec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`)

  const root = repo()
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts', 'test.sh'), 'exit 0\n')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'blueprint: test script'], { cwd: root })
  const r = drive(b, root, { env: { HARNESS_BUILD_QA_LOOP: '' }, driver: join(copy, 'graphs', 'build', 'skills', 'build-app', 'driver', 'driver.mjs') })
  assert.equal(r.code, 0, `${r.out}\n${status(root).message}`)
  assert.equal(status(root).state, 'done')
  assert.doesNotMatch(driverLog(root), /OFFERING_UNSUPPORTED/)
  assert.match(driverLog(root), /final QA/i, 'the driver ran the final QA')
  assert.deepEqual(Object.values(ledger(root).slices).map(x => x.status).sort(), ['done', 'done'], 'every slice landed')
  assert.ok(b.callsOf('checker').length >= 1 && b.callsOf('reviewer').length >= 1 && b.callsOf('qa-auditor').length >= 1, 'the real loop ran its leaves on the fake codex')
})

console.log('== build-app driver on Codex: the provider default')
// Without --backend the app the user is in decides. A real process tree is not available to a test, so the
// override PANDASTACK_PROVIDER stands in for it (host-provider.mjs has its own tree tests); --backend still wins.
await test('no --backend: PANDASTACK_PROVIDER=codex builds on Codex; an explicit --backend codex beats PANDASTACK_PROVIDER=claude; a bad value is a usage error before anything runs', () => {
  const b = box({ S1: good('S1') })
  const root = repo({ ...BACKLOG, slices: [slice(1, [])], requirements: ['R1'] })
  const r = drive(b, root, { flags: ['--no-pr'], env: { PANDASTACK_PROVIDER: 'codex' } })
  assert.equal(r.code, 0, `${r.out}\n${status(root).message}`)
  assert.equal(status(root).backend, 'codex')
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir(root), 'backend.json'), 'utf8')), { backend: 'codex' })
  assert.equal(b.callsOf('S1').length, 1, 'the slice ran on the fake codex')

  const b2 = box({ S1: good('S1') })
  const root2 = repo({ ...BACKLOG, slices: [slice(1, [])], requirements: ['R1'] })
  const r2 = drive(b2, root2, { flags: ['--no-pr', '--backend', 'codex'], env: { PANDASTACK_PROVIDER: 'claude' } })
  assert.equal(r2.code, 0, `${r2.out}\n${status(root2).message}`)
  assert.equal(status(root2).backend, 'codex', 'the flag wins')

  const b3 = box({})
  const root3 = repo()
  const r3 = drive(b3, root3, { flags: ['--no-pr'], env: { PANDASTACK_PROVIDER: 'gpt' } })
  assert.equal(r3.code, 2, r3.out)
  assert.match(r3.out, /PANDASTACK_PROVIDER must be "claude" or "codex"/)
  assert.equal(existsSync(stateDir(root3)), false, 'nothing started')
})

console.log('== build-app driver on Codex: arguments and defaults')
await test('--backend takes claude or codex, once, on run only; the default settings stay Claude\'s', () => {
  const run = (...a) => spawnSync(process.execPath, [DRIVER, ...a], { encoding: 'utf8' }).status
  for (const args of [
    ['run', '--repo', '/x', '--app', APP, '--backend', 'gemini'],
    ['run', '--repo', '/x', '--app', APP, '--backend', 'codex', '--backend', 'claude'],
    ['run', '--repo', '/x', '--app', APP, '--backend'],
    ['status', '--repo', '/x', '--app', APP, '--backend', 'codex'],
    ['stop', '--repo', '/x', '--app', APP, '--backend', 'claude'],
    ['unblock', '--repo', '/x', '--app', APP, '--slice', 'S1', '--answer', 'a', '--backend', 'codex'],
  ]) assert.equal(run(...args), 2, JSON.stringify(args))
  const claude = settingsFromEnv({})
  assert.deepEqual([claude.backend, claude.bin], ['claude', 'claude'])
  assert.match(claude.verifyCommand, /\.claude\/skills\/verify\/verify\.sh/)
  const codex = settingsFromEnv({}, 'codex')
  assert.deepEqual([codex.backend, codex.bin], ['codex', 'codex'])
  assert.equal(codex.verifyCommand, `bash "${join(INSTALL_ROOT, 'core', 'skills', 'verify', 'verify.sh')}"`)
  assert.equal(settingsFromEnv({ HARNESS_BUILD_CODEX_BIN: '/opt/codex', HARNESS_BUILD_CLAUDE_BIN: '/opt/claude' }, 'codex').bin, '/opt/codex')
  assert.equal(settingsFromEnv({ HARNESS_BUILD_CODEX_BIN: '/opt/codex', HARNESS_BUILD_CLAUDE_BIN: '/opt/claude' }).bin, '/opt/claude')
  assert.equal(settingsFromEnv({}, 'anything-else').backend, 'claude', 'only the exact word codex selects Codex')
})

await test('a build started on Claude is never resumed on Codex', () => {
  const root = repo({ ...BACKLOG, slices: [slice(1, [])], requirements: ['R1'] })
  // A Claude build in progress: its ledger has a landed slice and no backend record (older builds have none).
  mkdirSync(stateDir(root), { recursive: true })
  writeLedger(join(stateDir(root), 'ledger.json'), recordOutcome(emptyLedger(), 'S1', { kind: 'landed', frozen: [] }))
  const b = box({ S1: good('S1') })
  const r = drive(b, root)
  assert.equal(r.code, 6, r.out)
  assert.match(status(root).message, /was started on claude; run it with --backend claude/)
  assert.equal(b.calls().length, 0)
})

await test('the catalog row is the one the contract pins, and the SKILL.md section holds the commands and none of the Claude paths', () => {
  const catalog = JSON.parse(readFileSync(join(INSTALL_ROOT, 'spec', 'offering-capabilities.json'), 'utf8'))
  const row = catalog.offerings.find(o => o.id === 'build-app')
  // The fixture's row: CP-07 pinned LIVE_PROOF_MISSING until the live run recorded in
  // docs/evidence/codex-live-e2e-2026-11-23.md dropped it.
  assert.deepEqual(row.providers.codex, expectedCodexRow(catalog, 'build-app'))
  assert.equal(row.providers.codex.transportId, 'codex-autobuild')
  assert.deepEqual(row.proofRefs, ['cp-07-build-app-wiring'])
  const md = readFileSync(join(INSTALL_ROOT, 'graphs', 'build', 'skills', 'build-app', 'SKILL.md'), 'utf8')
  const at = md.indexOf('## Codex runner')
  const section = md.slice(at, md.indexOf('\n## ', at + 5))
  assert.ok(at > 0 && md.indexOf('## PR-first delivery exception') > at, 'the section sits before the PR-first section')
  for (const needle of ['--backend codex', 'driver.mjs', 'qa-loop.mjs', 'native-cli.mjs', '--mode fix', 'provider-refusal.json', 'OFFERING_UNSUPPORTED', 'tokens']) assert.ok(section.includes(needle), needle)
  assert.doesNotMatch(section, /\.claude|CLAUDE_CONFIG_DIR|CLAUDE_SKILL_DIR/, 'no Claude path in the Codex section')
  // The first bash block resolves the roots through a symlink, with only builtins and the named tools.
  const block = /```bash\n([\s\S]*?)\n```/.exec(section)[1]
  const dir = mkdtempSync(join(tmpdir(), 'build-codex-skill-'))
  const link = join(dir, 'build-app')
  symlinkSync(join(INSTALL_ROOT, 'graphs', 'build', 'skills', 'build-app'), link)
  const b = box()
  const r = spawnSync('bash', ['-c', `${block.replace('<installed-skill-dir>', link)}\nprintf '%s\\n' "$SKILL_DIR" "$DRIVER" "$CODEX"`], { encoding: 'utf8', env: { PATH: `${b.bin}:${process.env.PATH}`, HOME: b.home } })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.stdout.trim().split('\n'), [join(INSTALL_ROOT, 'graphs', 'build', 'skills', 'build-app'), join(INSTALL_ROOT, 'graphs', 'build', 'skills', 'build-app', 'driver', 'driver.mjs'), b.codex])
})

console.log('== build-app driver on Codex: the pieces')
await test('codexVerdict reads protocol events only: a refusal is never retried, a usage limit is a limit, prose that mentions one is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-codex-verdict-'))
  const log = (name, events, stderr = '') => {
    const file = join(dir, name)
    writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n'))
    writeFileSync(`${file}.stderr`, stderr)
    return file
  }
  const refusal = codexVerdict(log('refusal', [{ type: 'turn.failed', error: { message: 'This content was flagged for possible cybersecurity risk. x' } }]))
  assert.equal(refusal.kind, 'provider_refusal')
  const limit = codexVerdict(log('limit', [{ type: 'error', message: "You've hit your usage limit. It resets 3:45pm" }]))
  assert.equal(limit.kind, 'usage_limit')
  const prose = codexVerdict(log('prose', [
    { type: 'item.completed', item: { type: 'agent_message', text: "usage limit reached; flagged for possible cybersecurity risk" } },
    { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } },
  ]))
  assert.equal(prose.kind, 'normal', 'text inside a message is not an outcome')
  assert.equal(codexVerdict(join(dir, 'missing')).kind, 'normal')
  assert.equal(codexVerdict(log('overload', [{ type: 'turn.failed', error: { message: 'server is temporarily limiting requests' } }])).kind, 'transient')
})

await test('tokenUsage sums every turn and ignores everything else; QA, hunt and args helpers reject lookalikes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-codex-usage-'))
  const file = join(dir, 'log')
  writeFileSync(file, [
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }), 'not json',
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 'abc', output_tokens: 5 } }),
    JSON.stringify({ type: 'item.completed', usage: { input_tokens: 99, output_tokens: 99 } }), JSON.stringify(null),
    JSON.stringify({ type: 'turn.completed', usage: [] }),
  ].join('\n'))
  assert.deepEqual(tokenUsage(file), { input: 10, output: 7 })
  assert.deepEqual(tokenUsage(join(dir, 'missing')), { input: 0, output: 0 })
  assert.equal(readQaReport('{"status":"done","touched":[]}\n').status, 'done')
  for (const bad of ['', 'plain text', '[]', 'null', '{"status":5}', '{"error":"X"}']) assert.equal(readQaReport(bad), null, JSON.stringify(bad))
  assert.equal(readQaError('{"error":"OFFERING_UNSUPPORTED"}\n'), 'OFFERING_UNSUPPORTED')
  assert.equal(readQaError('boom'), '')
  assert.equal(huntStateDir('x\nNative hunt: fix; lenses=logic,errors; state=/tmp/a b/c\n'), '/tmp/a b/c')
  assert.equal(huntStateDir('log line state=/tmp/x\nNative hunt: discover; lenses=a'), null)
  assert.equal(huntPrep(join(dir, 'nowhere'), 'abc'), null)
  mkdirSync(join(dir, 'state'))
  writeFileSync(join(dir, 'state', 'intake.json'), JSON.stringify({ key: 'integration-toy-abc123' }))
  assert.deepEqual(huntPrep(join(dir, 'state'), 'h'), { stateDir: join(dir, 'state'), key: 'integration-toy-abc123', branch: 'bughunt/integration-toy-abc123', fixDir: join(dir, 'state', 'fix'), head: 'h' })
  writeFileSync(join(dir, 'state', 'intake.json'), JSON.stringify({ key: 5 }))
  assert.equal(huntPrep(join(dir, 'state'), 'h'), null)
  assert.deepEqual(leafEnv({ HOME: '/h', PATH: '/p', CODEX_HOME: '/c', SECRET_TOKEN: 'x', CLAUDE_CONFIG_DIR: '/d' }), { HOME: '/h', CODEX_HOME: '/c', PATH: '/p' })
  assert.deepEqual(leafEnv({ HOME: '', PATH: '/p' }), { PATH: '/p' })
  assert.match(sliceRules({ sliceId: 'S9', frozen: ['tests/a.test.js'] }), /commits your work as "S9: \.\.\."[\s\S]*\["tests\/a\.test\.js"\]/)
})

await test('hostCommit commits only what is there, only the named paths when given, with a fallback identity when git has none', () => {
  const root = repo()
  assert.deepEqual(hostCommit(root, 'S1: nothing'), { ok: true, committed: false })
  writeFileSync(join(root, 'a.txt'), 'a\n')
  writeFileSync(join(root, 'b.txt'), 'b\n')
  assert.deepEqual(hostCommit(root, 'final: QA fixes', 'body', ['a.txt']), { ok: true, committed: true })
  assert.deepEqual(gitOut(root, 'show', '--name-only', '--format=%s', 'HEAD').split('\n').filter(Boolean), ['final: QA fixes', 'a.txt'])
  assert.equal(gitOut(root, 'status', '--porcelain'), '?? b.txt', 'the other file is left alone')
  const bare = mkdtempSync(join(tmpdir(), 'build-codex-noid-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: bare })
  writeFileSync(join(bare, 'x'), 'x\n')
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, n: process.env.GIT_CONFIG_NOSYSTEM }
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  try {
    assert.deepEqual(hostCommit(bare, 'S1: x'), { ok: true, committed: true })
    assert.equal(gitOut(bare, 'log', '-1', '--format=%an <%ae>'), 'build-app <build-app@localhost>')
  } finally {
    for (const [k, v] of [['GIT_CONFIG_GLOBAL', saved.g], ['GIT_CONFIG_NOSYSTEM', saved.n]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})

await test('stopping the driver ends a tracked session\'s whole process group, not just the child; the probe is injectable', async () => {
  const child = spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const grandchild = await new Promise(resolve => child.stdout.once('data', d => resolve(Number(String(d).trim()))))
  trackSession(child, { group: true })
  assert.doesNotThrow(() => process.kill(grandchild, 0))
  await stopSessions(5000)
  await new Promise(r => setTimeout(r, 200))
  assert.throws(() => process.kill(grandchild, 0), { code: 'ESRCH' }, 'the grandchild is gone too')
  const logs = []
  const waited = await probeUntilAvailable({
    bin: 'unused', repo: '.', probeLog: '/dev/null', probeMinutes: 1, maxWaitHours: 1, marginMinutes: 0, sleepMs: async () => {}, log: m => logs.push(m),
    probe: async () => 0, readProbe: () => ({ subtype: 'success', is_error: false }),
  })
  assert.equal(waited.ok, true)
  assert.match(logs.at(-1), /available again/)
})
