// CP-05d frozen acceptance: one native QA loop iteration, graphs/qa/tool/qa-loop.mjs
// (spec/contracts/codex-parity-cp-05d.md). Wiring proof, not runtime certification:
// no real codex, no claude, no gh, no network, no HOME. Every case runs the
// candidate's qa-loop.mjs as a CLI, which runs the real CP-02e host CLI around the
// frozen fake codex acceptance/codex-parity/cp-02f-fake-codex.cjs. The installation
// root is CP-02f's fixture root (the candidate catalog with only `dev`'s codex row
// flipped to partial) whose core/skills/verify/verify.sh is replaced by an INERT
// script: the repository's own verify.sh, its capture machinery and the blocked
// nested-capture reproduction are never run (AGENTS.md).
//
// Each case owns a fixture git repository and a bin/ that is the whole PATH of
// qa-loop, the host and every leaf: a `node` shim that records each fake codex pid,
// a `git` wrapper that records its argv and runs the real git, a `bash` link, and
// recording `claude` and `gh` stubs. The leaf env (the args file `env`) is
// {PATH, FAKE_CODEX_DIR}; qa-loop's own env also carries a marker that must never
// reach a leaf. A failure whose message starts with "fixture:" is a fixture bug;
// a failure about qa-loop.mjs existing is the expected failure at this freeze.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = realpathSync(process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../', import.meta.url)))
const QA_LOOP = join(ROOT, 'graphs/qa/tool/qa-loop.mjs')
const RECONCILE_PATH = join(ROOT, 'core/skills/native-runtime/graph-reconcile.mjs')
const FAKE_CODEX = fileURLToPath(new URL('./cp-02f-fake-codex.cjs', import.meta.url))
const CATALOG = 'spec/offering-capabilities.json'
const loadModule = rel => import(pathToFileURL(resolve(ROOT, rel)).href)
const loadLedger = () => loadModule('graphs/qa/tool/qa-ledger.mjs')
const sha = value => createHash('sha256').update(value).digest('hex')
const tokenOf = bytes => sha(bytes).slice(0, 16)
const sleep = ms => new Promise(done => setTimeout(done, ms))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
// Every wait is generous: the suite runs on a loaded 4-vCPU box next to other files.
const BOUND_MS = 30000
const T = { timeout: 240000 }
async function until(check, what, ms = BOUND_MS) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (check()) return
  assert.ok(check(), `timed out waiting for ${what}`)
}
function alive(pid) {
  try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') return false; throw error }
  // An orphan nobody has reaped yet is a zombie: dead for every purpose here.
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '')[0] !== 'Z' } catch { return true }
}
function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
}

const INVOCATION = /^qa-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const LOOP_MARKER = 'LOOP-MARKER-05d'
const COMPLETION_MARK = 'COMPLETION-MARK-05d'
const REPORT_KEYS = ['status', 'graphStatus', 'invocationId', 'resumed', 'recorded', 'reason', 'stuckSig', 'fixRounds', 'touched', 'checks', 'ledgerWarning']
const CHECK_KEYS = ['verify', 'touched', 'changed', 'verifyTail']
const INVALID = 'INVALID_LOOP_INPUT'

// ---------------------------------------------------------------- fixture root
// CP-02f's fixture root: only what the host reads (catalog, workflow templates, role
// files, every file directly in a skill directory). Regular files only.
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

// The INERT verify.sh (contract, Acceptance): bash builtins only (PATH is bin/, and
// `node` there would add a pid line), runs the fixture repo's trivial scripts/test.sh,
// prints a VERIFY block. Its behavior is driven by files in $CP05D_CASE (a variable of
// qa-loop's own env, which qa-loop passes to verify.sh), so one fixture root serves
// every case: verify-mode selects the verdict, verify-calls.log records each run.
const INERT_MARK = 'CP05D-INERT-VERIFY'
const INERT_VERIFY = `# ${INERT_MARK}: an acceptance fixture, never the repository's verify.sh.
printf '%s|%s\\n' "$(pwd -P)" "$0" >> "$CP05D_CASE/verify-calls.log"
mode=pass
[ -f "$CP05D_CASE/verify-mode" ] && read -r mode < "$CP05D_CASE/verify-mode"
bash scripts/test.sh
code=$?
i=1
while [ "$i" -le 22 ]; do
  printf 'step %s output   \\n' "$i"
  [ $((i % 5)) -eq 0 ] && printf '\\n'
  i=$((i + 1))
done
printf '  [%s] bash scripts/test.sh\\n' "$code"
case "$mode" in
  pass) printf 'VERIFY: PASS  \\n\\n'; exit "$code" ;;
  fail) printf 'VERIFY: FAIL\\n'; exit 1 ;;
  pass-exit1) printf 'VERIFY: PASS\\n'; exit 1 ;;
  pass-then-text) printf 'VERIFY: PASS\\ntrailing note\\n'; exit 0 ;;
  pass-suffix) printf 'VERIFY: PASS (partial)\\n'; exit 0 ;;
  pass-prefix) printf 'NOT VERIFY: PASS\\n'; exit 0 ;;
esac
exit 9
`

let WORK, FIXTURE_ROOT, PREFIXES, REAL_GIT, REAL_BASH
function findOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    try {
      const path = join(dir, name)
      accessSync(path, constants.X_OK)
      if (statSync(path).isFile()) return realpathSync(path)
    } catch { /* keep looking */ }
  }
  return null
}
// Built on first use, so a candidate without the v2 catalog or role loader fails each case on its own.
async function root() {
  if (FIXTURE_ROOT) return FIXTURE_ROOT
  const dir = realpathSync(mkdtempSync(join(WORK, 'root-')))
  copyTree(dir)
  const catalog = readJson(join(dir, CATALOG))
  const row = catalog.offerings.find(o => o.id === 'dev')
  assert.ok(row?.providers?.codex, 'fixture: the candidate catalog is v2 with provider rows (CP-01b)')
  row.providers.codex = structuredClone(PARTIAL)
  writeFileSync(join(dir, CATALOG), JSON.stringify(catalog, null, 2) + '\n')
  // The repository's own verify.sh is replaced before anything can run it.
  mkdirSync(join(dir, 'core/skills/verify'), { recursive: true })
  writeFileSync(join(dir, 'core/skills/verify/verify.sh'), INERT_VERIFY)
  assert.ok(readFileSync(join(dir, 'core/skills/verify/verify.sh'), 'utf8').includes(INERT_MARK), 'fixture: verify.sh is inert')
  const { assembleRoleInstructions } = await loadModule('core/skills/native-runtime/role-files.mjs')
  PREFIXES = QA_ROLES.map(role => ({ role, prefix: assembleRoleInstructions({ installationRoot: dir, name: role }).instructions + '\n\n' }))
  FIXTURE_ROOT = dir
  return dir
}
async function ready() {
  await root()
  assert.ok(REAL_GIT && REAL_BASH, 'fixture: git and bash must be found on PATH')
}

before(() => {
  WORK = realpathSync(mkdtempSync(join(tmpdir(), 'cp-05d-')))
  REAL_GIT = findOnPath('git')
  REAL_BASH = findOnPath('bash')
})
after(() => rmSync(WORK, { recursive: true, force: true }))

// --------------------------------------------------------------------- replies
const wire = value => ({ json: JSON.stringify(value) })
const PASS = { verdict: 'PASS', verify_block: `  [0] ${COMPLETION_MARK}\nVERIFY: PASS`, failures: [] }
const FAIL = { verdict: 'FAIL', verify_block: '  [1] bash scripts/test.sh\nVERIFY: FAIL',
  failures: [{ step: 'bash scripts/test.sh', exit: 1, error_key: 'cp05d-fixture-failure', excerpt: 'boom' }] }
const FAIL_SIG = 'verify|bash scripts/test.sh#1#cp05d-fixture-failure'
const CLEAN = { files_reviewed: 1, findings: [] }
const fixed = touched => ({ fixed: [`fixed ${touched.join(',')}`], unfixed: [], touched, verify_verdict: 'NOT_RUN', summary: 'fixture' })
const HAPPY = Object.freeze({ checker: wire(PASS), reviewer: wire(CLEAN), 'qa-auditor': wire(CLEAN) })
const SANDBOX = { checker: 'workspace-write', fixer: 'workspace-write' }
const scriptText = (replies = HAPPY) => JSON.stringify({ roles: PREFIXES, replies })

// ------------------------------------------------------------------ case helpers
const GIT_ENV = { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'cp05d', GIT_AUTHOR_EMAIL: 'cp05d@example.invalid', GIT_COMMITTER_NAME: 'cp05d', GIT_COMMITTER_EMAIL: 'cp05d@example.invalid' }
// The test's own git: the real one, by absolute path, never through the recording wrapper.
function git(c, ...args) {
  const r = spawnSync(REAL_GIT, ['-c', 'init.defaultBranch=main', ...args], { cwd: c.repo, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(r.status, 0, `fixture: git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}
const tracedNames = ['claude', 'gh']
const stubScript = file => `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(file)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`

// One owned directory per case; replies are the fake's script. The repo has one commit.
async function makeCase({ replies = HAPPY } = {}) {
  await ready()
  const dir = realpathSync(mkdtempSync(join(WORK, 'case-')))
  const c = { dir, repo: join(dir, 'repo'), sub: join(dir, 'repo', 'sub'), fake: join(dir, 'fake'), bin: join(dir, 'bin'),
    codex: join(dir, 'codex-bin', 'codex'), pids: join(dir, 'pids.txt'), gitLog: join(dir, 'git-calls.log'),
    claudeCalls: join(dir, 'claude-calls.jsonl'), ghCalls: join(dir, 'gh-calls.jsonl'), verifyLog: join(dir, 'verify-calls.log'),
    argsFile: join(dir, 'loop-args.json') }
  for (const d of [c.repo, c.fake, c.bin, dirname(c.codex)]) mkdirSync(d)
  for (const path of [c.pids, c.gitLog, c.dir, process.execPath, REAL_GIT]) assert.ok(!path.includes("'"), 'fixture: shim paths quote safely')
  writeFileSync(join(c.bin, 'node'), `#!/bin/sh\necho $$ >> '${c.pids}'\nexec '${process.execPath}' "$@"\n`)
  writeFileSync(join(c.bin, 'git'), `#!/bin/sh\n{ printf '%s' "$(pwd -P)"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> '${c.gitLog}'\nexec '${REAL_GIT}' "$@"\n`)
  writeFileSync(join(c.bin, 'claude'), stubScript(c.claudeCalls))
  writeFileSync(join(c.bin, 'gh'), stubScript(c.ghCalls))
  for (const name of ['node', 'git', ...tracedNames]) chmodSync(join(c.bin, name), 0o755)
  symlinkSync(REAL_BASH, join(c.bin, 'bash'))
  cpSync(FAKE_CODEX, c.codex)
  chmodSync(c.codex, 0o755)
  writeFileSync(join(c.fake, 'script.json'), scriptText(replies))
  git(c, 'init', '-q')
  mkdirSync(join(c.repo, 'scripts'))
  mkdirSync(join(c.repo, 'src'))
  mkdirSync(c.sub)
  writeFileSync(join(c.repo, 'scripts/test.sh'), 'exit 0\n')
  for (const [name, text] of [['src/a.txt', 'one\n'], ['a.txt', 'a\n'], ['B.txt', 'b\n'], ['sub/keep.txt', 'k\n']]) writeFileSync(join(c.repo, name), text)
  git(c, 'add', '-A')
  git(c, 'commit', '-q', '-m', 'fixture')
  c.ledgerDir = git(c, 'rev-parse', '--path-format=absolute', '--git-path', 'harness-loop').trim()
  assert.equal(c.ledgerDir, join(c.repo, '.git', 'harness-loop'), 'fixture: the ledger directory is inside the git directory')
  Object.assign(c, { ledgerFile: join(c.ledgerDir, 'ledger.json'), inflight: join(c.ledgerDir, 'native-inflight.json'),
    nativeRuns: join(c.ledgerDir, 'native-runs') })
  return c
}
// qa-loop's whole environment: bin/ is its PATH; the marker must never reach a leaf.
const loopEnv = c => ({ PATH: c.bin, CP05D_MARKER: LOOP_MARKER, CP05D_CASE: c.dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
const leafEnv = c => ({ PATH: c.bin, FAKE_CODEX_DIR: c.fake })
// A valid args file for qa-loop; a patch value of `undefined` removes the key.
function loopArgs(c, patch = {}) {
  const value = { schemaVersion: 1, repo: c.repo, installationRoot: FIXTURE_ROOT, codexBin: c.codex, env: leafEnv(c), timeoutMs: 120000, ...patch }
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key]
  return value
}
function writeArgs(c, patch, name = 'loop-args.json') {
  const path = join(c.dir, name)
  writeFileSync(path, JSON.stringify(loopArgs(c, patch)))
  return path
}

function collect(child) {
  return new Promise(done => {
    let stdout = '', stderr = ''
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 120000)
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', (code, signal) => { clearTimeout(watchdog); done({ code, signal, stdout, stderr }) })
  })
}
function startLoop(c, argv, env = loopEnv(c)) {
  assert.ok(existsSync(QA_LOOP), `qa-loop.mjs must exist at ${QA_LOOP} (CP-05d is not built at this freeze)`)
  const child = spawn(process.execPath, [QA_LOOP, ...argv], { cwd: c.dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  return { child, done: collect(child) }
}
const loop = (c, file) => startLoop(c, ['--args-file', file]).done
const reconcile = (...argv) => collect(spawn(process.execPath, [RECONCILE_PATH, ...argv], { env: { PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] }))

// --------------------------------------------------------------- recorded state
const spawnCalls = c => lines(join(c.fake, 'calls.jsonl')).map(line => JSON.parse(line))
const pidsOf = c => lines(c.pids).map(Number)
const gitCalls = c => lines(c.gitLog).map(line => { const [cwd, ...argv] = line.split('\t'); return { cwd, argv } })
const verifyRuns = c => lines(c.verifyLog)
const ledgerOf = async c => (await loadLedger()).readLedger(c.ledgerFile)
const nativeRunDir = (c, id) => join(c.nativeRuns, id)
const hostArgsPath = (c, id) => join(c.nativeRuns, `${id}.host-args.json`)
const resultOf = (c, id) => readJson(join(nativeRunDir(c, id), 'result.json'))
function rowFiles(runDir) {
  const dir = join(runDir, 'checkpoints')
  return existsSync(dir) ? readdirSync(dir).filter(name => /^nr-[0-9a-f]{64}\.json$/.test(name)).map(name => readJson(join(dir, name))) : []
}
const rowOf = (runDir, agentType) => rowFiles(runDir).find(row => row.binding.agentType === agentType)
const mode = path => statSync(path).mode & 0o777
const seedRun = { status: 'done', at: '2026-01-01T00:00:00Z', invocationId: 'qa-20260101T000000Z-00000000', reason: 'seed', stuckSig: null, fixRounds: 0, touched: [] }
async function seedLedger(c, ledger) {
  const m = await loadLedger()
  m.writeLedger(c.ledgerFile, ledger)
}
const setVerifyMode = (c, text) => writeFileSync(join(c.dir, 'verify-mode'), text + '\n')

// What verify.sh printed in `verifyMode`, run once by hand in an owned probe directory:
// the contract's verifyTail rule is then applied to real bytes, not to a copy of the script.
const PROBE = new Map()
function verifyTailFor(verifyMode) {
  if (!PROBE.has(verifyMode)) {
    const probe = realpathSync(mkdtempSync(join(WORK, 'probe-')))
    mkdirSync(join(probe, 'scripts'))
    writeFileSync(join(probe, 'scripts/test.sh'), 'exit 0\n')
    writeFileSync(join(probe, 'verify-mode'), verifyMode + '\n')
    const r = spawnSync(REAL_BASH, [join(FIXTURE_ROOT, 'core/skills/verify/verify.sh')], { cwd: probe, env: { PATH: process.env.PATH ?? '', CP05D_CASE: probe }, encoding: 'utf8' })
    assert.ok(r.status !== null && r.stdout.includes('VERIFY: '), `fixture: the inert verify.sh prints a VERIFY block (${r.stderr})`)
    const all = r.stdout.split('\n').map(l => l.trimEnd()).filter(l => l !== '')
    assert.ok(all.length > 20, 'fixture: verify.sh prints more than 20 non-empty lines')
    assert.ok(r.stdout.split('\n').some(l => l === '') && r.stdout.split('\n').some(l => /\S {3}$/.test(l)), 'fixture: blank lines and trailing spaces present')
    PROBE.set(verifyMode, all.slice(-20).join('\n'))
  }
  return PROBE.get(verifyMode)
}

// --------------------------------------------------------- repository invariants
function treeSnapshot(dir) {
  const out = {}
  const walk = path => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name), info = lstatSync(full)
      out[relative(dir, full)] = info.isFile() ? sha(readFileSync(full)) : info.isSymbolicLink() ? `-> ${readlinkSync(full)}` : 'dir'
      if (info.isDirectory()) walk(full)
    }
  }
  walk(dir)
  return out
}
// Type, mode, inode, size, mtime and bytes of every entry: equal snapshots mean nothing under
// dir was created, removed, rewritten or touched.
function statSnapshot(dir) {
  const out = {}
  const walk = path => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name), info = lstatSync(full)
      out[relative(dir, full)] = { mode: info.mode, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs,
        sha: info.isFile() ? sha(readFileSync(full)) : null }
      if (info.isDirectory()) walk(full)
    }
  }
  walk(dir)
  return out
}
const workTree = c => Object.fromEntries(Object.entries(treeSnapshot(c.repo)).filter(([name]) => name !== '.git' && !name.startsWith('.git/')))
// HEAD, every ref, every staged entry and the work tree (case 12).
function repoSnapshot(c) {
  return { head: git(c, 'rev-parse', 'HEAD'), refs: git(c, 'for-each-ref', '--format=%(refname) %(objectname)'),
    staged: git(c, 'ls-files', '-s', '-z'), tree: workTree(c) }
}
// The only git commands the contract allows qa-loop (Imports, Files, Steps 2 and 3).
const ALLOWED_GIT = [['rev-parse', '--show-toplevel'], ['rev-parse', '--path-format=absolute', '--git-path', 'harness-loop'],
  ['status', '--porcelain=v1', '-z', '--untracked-files=all']]
function assertInvariants(c, before) {
  assert.deepEqual(repoSnapshot(c), before, 'HEAD, refs, staged entries or the work tree changed')
  for (const call of gitCalls(c)) {
    assert.ok(ALLOWED_GIT.some(argv => JSON.stringify(argv) === JSON.stringify(call.argv)), `git was run as: git ${call.argv.join(' ')}`)
    assert.ok(['rev-parse', 'status'].includes(call.argv[0]))
  }
  assert.equal(existsSync(c.claudeCalls), false, 'a claude binary was invoked')
  assert.equal(existsSync(c.ghCalls), false, 'gh was invoked')
}
// The exact git calls of a run: the repo lookup (cwd = the `repo` input), the ledger
// path (cwd = the toplevel) and, on the done path, the status check (cwd = the toplevel).
function assertGitCalls(c, { repoCwd = c.repo, status }) {
  const expected = [{ cwd: repoCwd, argv: ALLOWED_GIT[0] }, { cwd: c.repo, argv: ALLOWED_GIT[1] }]
  if (status) expected.push({ cwd: c.repo, argv: ALLOWED_GIT[2] })
  assert.deepEqual(gitCalls(c), expected, 'the git calls of this run')
}
// The sh shim that records each pid exports PWD (and, on some shells, SHLVL, _ and OLDPWD) before it execs node.
const SPAWN_ENV_NOISE = ['__CF_USER_TEXT_ENCODING', 'PWD', 'OLDPWD', 'SHLVL', '_']
// Every spawn ran the fake as given: cwd the toplevel, the args file's env and nothing
// else, the CP-02b sandbox; and no claude binary ran.
function assertLeaves(c, roles) {
  const seen = spawnCalls(c)
  assert.deepEqual(seen.map(call => call.role), roles, 'spawn order')
  for (const call of seen) {
    assert.equal(call.cwd, c.repo, `${call.role} cwd`)
    assert.deepEqual(Object.keys(call.env).filter(k => !SPAWN_ENV_NOISE.includes(k)).sort(), ['FAKE_CODEX_DIR', 'PATH'], `${call.role} env keys`)
    assert.equal(call.env.PATH, c.bin)
    assert.equal(call.env.FAKE_CODEX_DIR, c.fake)
    assert.equal(call.sandbox, SANDBOX[call.role] ?? 'read-only', `${call.role} sandbox`)
  }
  assert.equal(pidsOf(c).length, roles.length, 'one fake process per spawn')
  assert.equal(existsSync(c.claudeCalls), false, 'a claude binary was invoked')
  return seen
}
const assertNoSpawns = c => {
  assert.deepEqual(spawnCalls(c), [])
  assert.deepEqual(pidsOf(c), [])
}

// --------------------------------------------------------- output assertions
function assertNoLeak(c, r) {
  const out = r.stdout + r.stderr
  for (const secret of [LOOP_MARKER, COMPLETION_MARK, c.fake, c.bin, `Repo: ${c.repo}`, 'cd there before anything else']) {
    assert.ok(!out.includes(secret), `output carries ${secret}`)
  }
}
function assertReport(c, r) {
  assert.equal(r.code, 0, `exit ${r.code}, stderr: ${r.stderr}`)
  assert.equal(r.stderr, '', 'stderr is empty')
  assert.ok(r.stdout.endsWith('\n') && r.stdout.indexOf('\n') === r.stdout.length - 1, 'stdout is exactly one line')
  const report = JSON.parse(r.stdout)
  assert.deepEqual(Object.keys(report), REPORT_KEYS, 'report keys, in order')
  assert.equal(r.stdout, JSON.stringify(report) + '\n')
  assert.match(report.invocationId, INVOCATION)
  if (report.checks !== null) assert.deepEqual(Object.keys(report.checks), CHECK_KEYS, 'checks keys, in order')
  assertNoLeak(c, r)
  return report
}
function assertError(c, r, exit, code) {
  assert.equal(r.code, exit, `exit (stderr ${r.stderr.trim()})`)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, JSON.stringify({ error: code }) + '\n')
  assertNoLeak(c, r)
}
const hintFor = runDir => `node ${ROOT}/core/skills/native-runtime/graph-reconcile.mjs list --run-dir ${runDir}`
function assertExit4(c, r, code, invocationId, runDir) {
  assert.equal(r.code, 4, `exit (stderr ${r.stderr.trim()})`)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, JSON.stringify({ error: code, invocationId, hint: hintFor(runDir) }) + '\n')
  assert.ok(!(r.stdout + r.stderr).includes(LOOP_MARKER) && !r.stderr.includes(c.fake) && !r.stderr.includes(c.bin))
}

// What the ledger run for `report` must be: the graph's result, the invocation id and
// the loop checks (contract, done path steps 4 and 5); `at` is checked apart.
function expectedRun(c, report, overrides = {}) {
  const graph = resultOf(c, report.invocationId).result
  const run = { ...graph, invocationId: report.invocationId, ...(graph.status === 'done' ? { loopChecks: report.checks } : {}), ...overrides }
  return run
}
function assertLastRun(ledger, expected) {
  const run = ledger.runs.at(-1)
  assert.match(run.at, AT)
  const rest = { ...run }
  delete rest.at
  assert.deepEqual(rest, expected)
  return run
}

// ============================================================ 1. a clean run
describe('CP-05d qa-loop (frozen acceptance; wiring proof on the fake codex)', () => {
  test('1. a clean run: exit 0 done; checker, reviewer, qa-auditor with the CP-02b sandboxes; host args file, argsHash, ledger run, one verify run, no inflight file', T, async () => {
    const c = await makeCase()
    const before = repoSnapshot(c)
    // `repo` is a subdirectory: everything downstream must use the toplevel.
    const file = writeArgs(c, { repo: c.sub, base: null })
    const r = await loop(c, file)
    const report = assertReport(c, r)
    const id = report.invocationId
    const graph = resultOf(c, id)
    assert.deepEqual([graph.workflowId, graph.offeringId, graph.invocationId, graph.status], ['harness-repair', 'dev', id, 'done'])
    assert.equal(report.status, 'done')
    assert.equal(report.graphStatus, 'done')
    assert.equal(report.resumed, false)
    assert.equal(report.recorded, true)
    assert.equal(report.reason, graph.result.reason)
    assert.match(report.reason, /^VERIFY: PASS/)
    assert.equal(report.stuckSig, null)
    assert.equal(report.fixRounds, 0)
    assert.deepEqual(report.touched, [])
    assert.deepEqual(report.checks, { verify: 'PASS', touched: 'MATCH', changed: [], verifyTail: verifyTailFor('pass') })
    assert.equal(report.ledgerWarning, null)

    const seen = assertLeaves(c, ['checker', 'reviewer', 'qa-auditor'])
    assert.deepEqual(seen.map(call => call.sandbox), ['workspace-write', 'read-only', 'read-only'])
    assert.ok(seen[1].stdin.includes('Let the skill detect the base branch.'), 'a null base means no base is named')

    // The host args file: exactly the CP-02e keys, the contract's values, compact JSON, 0600.
    const bytes = readFileSync(hostArgsPath(c, id), 'utf8')
    const value = JSON.parse(bytes)
    assert.equal(bytes, JSON.stringify(value), 'the host args file is JSON.stringify(value)')
    assert.deepEqual(Object.keys(value).sort(), ['args', 'codexBin', 'cwd', 'env', 'installationRoot', 'invocationId', 'maxConcurrentSubagents',
      'offeringId', 'runDir', 'schemaVersion', 'timeoutMs', 'workflowId'])
    const args = { repo: c.repo, maxFixRounds: 3, knownStuckSigs: [] }
    assert.deepEqual(value, { schemaVersion: 1, installationRoot: FIXTURE_ROOT, workflowId: 'harness-repair', offeringId: 'dev', invocationId: id,
      args, runDir: nativeRunDir(c, id), codexBin: c.codex, cwd: c.repo, env: leafEnv(c), timeoutMs: 120000, maxConcurrentSubagents: 1 })
    assert.deepEqual(Object.keys(value.args), ['repo', 'maxFixRounds', 'knownStuckSigs'])
    assert.equal(mode(hostArgsPath(c, id)), 0o600)
    assert.equal(mode(c.ledgerDir), 0o700)
    assert.equal(mode(c.nativeRuns), 0o700)
    assert.equal(mode(c.ledgerFile), 0o600)

    // Every checkpoint row's argsHash is from those args (CP-02d canonical form).
    const { sha: boundarySha, canonical } = await loadModule('core/skills/native-runtime/boundary.mjs')
    const rows = rowFiles(nativeRunDir(c, id))
    assert.equal(rows.length, 3)
    for (const row of rows) {
      assert.equal(row.binding.argsHash, boundarySha(canonical(args)))
      assert.equal(row.binding.invocationId, id)
      assert.equal(row.state, 'returned')
    }

    const { ledger, warning } = await ledgerOf(c)
    assert.equal(warning, null)
    assert.equal(ledger.runs.length, 1)
    assert.deepEqual([ledger.stuckSigs, ledger.blockedOn, ledger.idleRuns], [[], null, 0])
    const run = assertLastRun(ledger, expectedRun(c, report))
    assert.deepEqual(run.loopChecks, report.checks)

    // verify ran once, in the toplevel, as `bash <installationRoot>/core/skills/verify/verify.sh`.
    assert.deepEqual(verifyRuns(c), [`${c.repo}|${join(FIXTURE_ROOT, 'core/skills/verify/verify.sh')}`])
    assert.equal(existsSync(c.inflight), false, 'the inflight file is gone')
    assert.equal(existsSync(nativeRunDir(c, id)), true)
    assertGitCalls(c, { repoCwd: c.sub, status: true })
    assertInvariants(c, before)
  })

  // ========================================================= 2. args forwarding
  test('2. a seeded ledger and base reach the host args file; the reviewer prompt names the base; done clears stuckSigs and keeps blockedOn and idleRuns', T, async () => {
    const c = await makeCase()
    const seeded = { runs: [seedRun], stuckSigs: ['seed-sig-1', 'seed-sig-2'], blockedOn: 'blocked: waiting for a human', idleRuns: 1 }
    await seedLedger(c, seeded)
    const before = repoSnapshot(c)
    const r = await loop(c, writeArgs(c, { base: 'release/2026', maxFixRounds: 2 }))
    const report = assertReport(c, r)
    assert.equal(report.status, 'done')
    const value = readJson(hostArgsPath(c, report.invocationId))
    assert.deepEqual(value.args, { repo: c.repo, base: 'release/2026', maxFixRounds: 2, knownStuckSigs: ['seed-sig-1', 'seed-sig-2'] })
    assert.deepEqual(Object.keys(value.args), ['repo', 'base', 'maxFixRounds', 'knownStuckSigs'])
    const seen = assertLeaves(c, ['checker', 'reviewer', 'qa-auditor'])
    assert.ok(seen[1].stdin.includes('Base branch: release/2026.'), 'the reviewer prompt names the base')
    assert.ok(seen[2].stdin.includes('Base branch: release/2026.'), 'the qa-auditor prompt names the base')
    const { sha: boundarySha, canonical } = await loadModule('core/skills/native-runtime/boundary.mjs')
    const rows = rowFiles(nativeRunDir(c, report.invocationId))
    assert.equal(rows.length, 3)
    for (const row of rows) assert.equal(row.binding.argsHash, boundarySha(canonical(value.args)))
    const { ledger } = await ledgerOf(c)
    assert.deepEqual(ledger.stuckSigs, [], 'done clears stuckSigs')
    assert.equal(ledger.blockedOn, 'blocked: waiting for a human')
    assert.equal(ledger.idleRuns, 1)
    assert.equal(ledger.runs.length, 2)
    assert.deepEqual(ledger.runs[0], seedRun)
    assertLastRun(ledger, expectedRun(c, report))
    assertGitCalls(c, { status: true })
    assertInvariants(c, before)
  })

  // ============================================================= 3. bad input
  test('3. bad input is exit 1 INVALID_LOOP_INPUT with zero git calls, spawns and files', T, async () => {
    const c = await makeCase()
    const before = repoSnapshot(c)
    const tree = treeSnapshot(c.dir)
    const good = writeArgs(c, {}, 'good.json')
    const treeWithGood = treeSnapshot(c.dir)
    const patches = {
      'maxFixRounds 0': { maxFixRounds: 0 }, 'maxFixRounds 1.5': { maxFixRounds: 1.5 }, 'maxFixRounds -1': { maxFixRounds: -1 },
      'maxFixRounds string': { maxFixRounds: '3' }, 'base a number': { base: 7 },
      'relative repo': { repo: 'relative/repo' }, 'repo with a control character': { repo: `${c.repo}\u0007` }, 'repo a number': { repo: 5 },
      'repo missing': { repo: undefined }, 'relative installationRoot': { installationRoot: 'fixture-root' }, 'relative codexBin': { codexBin: 'codex' },
      'schemaVersion 2': { schemaVersion: 2 }, 'schemaVersion a string': { schemaVersion: '1' }, 'an unknown key': { extra: true },
      'env missing': { env: undefined }, 'env a non-string value': { env: { PATH: c.bin, N: 1 } }, 'env an array': { env: [] }, 'env null': { env: null },
      'timeoutMs 1000': { timeoutMs: 1000 }, 'timeoutMs 86400001': { timeoutMs: 86400001 }, 'timeoutMs 1001.5': { timeoutMs: 1001.5 },
      'timeoutMs a string': { timeoutMs: '5000' }, 'timeoutMs missing': { timeoutMs: undefined },
    }
    const jobs = Object.entries(patches).map(([label, patch]) => [label, writeArgs(c, patch, `bad-${label.replace(/\W+/g, '-')}.json`)])
    const raw = (label, bytes) => { const path = join(c.dir, `raw-${label}.json`); writeFileSync(path, bytes); return [label, path] }
    jobs.push(raw('not-json', '{"schemaVersion":'), raw('array', '[]'), raw('null', 'null'), raw('empty', ''),
      raw('invalid-utf8', Buffer.from([0x7b, 0xff, 0xfe, 0x7d])),
      raw('over-1MiB', JSON.stringify(loopArgs(c)) + ' '.repeat(1048576)))
    mkdirSync(join(c.dir, 'a-directory'))
    jobs.push(['an args file that is a directory', join(c.dir, 'a-directory')], ['an args file that does not exist', join(c.dir, 'absent.json')])
    const argvs = [['no arguments', []], ['a flag without a value', ['--args-file']], ['a bare positional', [good]],
      ['an extra positional', ['--args-file', good, 'extra']], ['the flag twice', ['--args-file', good, '--args-file', good]],
      ['another flag', ['--args', good]], ['a relative args file path', ['--args-file', relative(c.dir, good)]],
      ['an extra flag', ['--args-file', good, '--verbose']], ['the flag=value form', [`--args-file=${good}`]]]
    const runs = [...jobs.map(([label, path]) => [label, ['--args-file', path]]), ...argvs]
    const results = await Promise.all(runs.map(([, argv]) => startLoop(c, argv).done))
    results.forEach((r, i) => {
      try { assertError(c, r, 1, INVALID) } catch (error) { error.message = `[${runs[i][0]}] ${error.message}`; throw error }
    })
    // Nothing was touched: no git call, no spawn, no file anywhere (the git directory included).
    assert.equal(existsSync(c.gitLog), false, 'a git process was started')
    assertNoSpawns(c)
    assert.equal(existsSync(c.ledgerDir), false, 'the ledger directory was created')
    const after = treeSnapshot(c.dir)
    for (const name of Object.keys(after)) {
      if (name in treeWithGood || name.startsWith('bad-') || name.startsWith('raw-') || name === 'a-directory') continue
      assert.fail(`a file appeared: ${name}`)
    }
    for (const name of Object.keys(tree)) assert.equal(after[name], tree[name], `${name} changed`)
    assertInvariants(c, before)
  })

  test('3b. a repo that is not a work tree is exit 2 NOT_A_REPO before any spawn or write', T, async () => {
    const c = await makeCase()
    const plain = join(c.dir, 'plain')
    mkdirSync(plain)
    const before = repoSnapshot(c)
    const env = { ...loopEnv(c), GIT_CEILING_DIRECTORIES: c.dir }
    const variants = [['a directory outside any repository', plain, 1], ['a path that does not exist', join(c.dir, 'absent'), 0],
      ['the git directory itself', join(c.repo, '.git'), 1]]
    let total = 0
    for (const [label, repo, gitRuns] of variants) {
      const r = await startLoop(c, ['--args-file', writeArgs(c, { repo }, 'not-a-repo.json')], env).done
      total += gitRuns
      try {
        assertError(c, r, 2, 'NOT_A_REPO')
        assert.equal(gitCalls(c).length, total, 'only the toplevel lookup ran, and only when the directory exists')
        if (gitRuns > 0) assert.deepEqual(gitCalls(c).at(-1), { cwd: realpathSync(repo), argv: ALLOWED_GIT[0] })
      } catch (error) { error.message = `[${label}] ${error.message}`; throw error }
    }
    assertNoSpawns(c)
    assert.deepEqual(readdirSync(plain), [], 'nothing was written in the directory')
    assert.equal(existsSync(c.ledgerDir), false)
    assertInvariants(c, before)
  })

  // ===================================================== 4. a stuck signature
  test('4. maxFixRounds 1 and a checker that fails twice escalate after checker, fixer, checker with a stuckSig the ledger adds; the next iteration forwards it and escalates after one checker spawn', T, async () => {
    const c = await makeCase({ replies: { checker: wire(FAIL), fixer: wire(fixed([])), reviewer: wire(CLEAN), 'qa-auditor': wire(CLEAN) } })
    const before = repoSnapshot(c)
    const file = writeArgs(c, { maxFixRounds: 1 })
    const first = assertReport(c, await loop(c, file))
    assert.equal(first.status, 'escalate')
    assert.equal(first.graphStatus, 'escalate')
    assert.equal(first.stuckSig, FAIL_SIG)
    assert.equal(first.fixRounds, 1)
    assert.equal(first.reason, resultOf(c, first.invocationId).result.reason)
    assert.match(first.reason, /fix-round cap \(1\)/)
    assert.deepEqual(first.touched, [])
    assert.equal(first.checks, null, 'no checks on an escalate')
    assert.equal(first.resumed, false)
    assert.equal(first.recorded, true)
    const seen = assertLeaves(c, ['checker', 'fixer', 'checker'])
    assert.deepEqual(seen.map(call => call.sandbox), ['workspace-write', 'workspace-write', 'workspace-write'])
    assert.equal(readJson(hostArgsPath(c, first.invocationId)).args.maxFixRounds, 1)
    let { ledger } = await ledgerOf(c)
    assert.deepEqual(ledger.stuckSigs, [FAIL_SIG], 'the ledger adds the stuckSig')
    assert.equal(ledger.runs.length, 1)
    const run = assertLastRun(ledger, expectedRun(c, first))
    assert.equal('loopChecks' in run, false)
    assert.equal(existsSync(c.verifyLog), false, 'verify does not run on an escalate')
    assert.equal(existsSync(c.inflight), false)

    // The next iteration: a new invocation that forwards the signature and stops at the first check.
    const second = assertReport(c, await loop(c, file))
    assert.notEqual(second.invocationId, first.invocationId)
    assert.equal(second.resumed, false)
    assert.equal(second.status, 'escalate')
    assert.equal(second.stuckSig, FAIL_SIG)
    assert.equal(second.fixRounds, 0)
    assert.equal(second.reason, resultOf(c, second.invocationId).result.reason)
    assert.match(second.reason, /earlier iteration already escalated/)
    assert.deepEqual(readJson(hostArgsPath(c, second.invocationId)).args, { repo: c.repo, maxFixRounds: 1, knownStuckSigs: [FAIL_SIG] })
    assertLeaves(c, ['checker', 'fixer', 'checker', 'checker'])
    ;({ ledger } = await ledgerOf(c))
    assert.deepEqual(ledger.stuckSigs, [FAIL_SIG], 'the signature is not added twice')
    assert.equal(ledger.runs.length, 2)
    assert.equal(ledger.runs[0].invocationId, first.invocationId)
    assertLastRun(ledger, expectedRun(c, second))
    assert.equal(existsSync(c.verifyLog), false)
    assert.equal(gitCalls(c).filter(call => call.argv[0] === 'status').length, 0, 'no status check on an escalate')
    assertInvariants(c, before)
  })

  // ================================================================ 5. verify
  test('5. a scripted checker PASS with a failing inert verify.sh is recorded as an escalate (VERIFY_FAILED, downgradedFrom done) and keeps stuckSigs', T, async () => {
    const c = await makeCase()
    await seedLedger(c, { runs: [], stuckSigs: ['seed-sig'], blockedOn: null, idleRuns: 0 })
    setVerifyMode(c, 'fail')
    const before = repoSnapshot(c)
    const report = assertReport(c, await loop(c, writeArgs(c)))
    assert.equal(report.status, 'escalate')
    assert.equal(report.graphStatus, 'done', 'the graph said done')
    assert.equal(report.reason, 'VERIFY_FAILED')
    assert.equal(report.stuckSig, null)
    assert.equal(report.fixRounds, 0)
    assert.deepEqual(report.touched, [])
    assert.deepEqual(report.checks, { verify: 'FAIL', touched: 'MATCH', changed: [], verifyTail: verifyTailFor('fail') })
    assertLeaves(c, ['checker', 'reviewer', 'qa-auditor'])
    const { ledger } = await ledgerOf(c)
    assert.deepEqual(ledger.stuckSigs, ['seed-sig'], 'a downgraded run leaves stuckSigs as they were')
    assert.equal(ledger.runs.length, 1)
    const run = assertLastRun(ledger, expectedRun(c, report, { status: 'escalate', reason: 'VERIFY_FAILED', stuckSig: null, downgradedFrom: 'done' }))
    assert.equal(run.loopChecks.verify, 'FAIL')
    assert.equal(verifyRuns(c).length, 1)
    assert.equal(existsSync(c.inflight), false)
    assertGitCalls(c, { status: true })   // both checks always run, even when verify failed
    assertInvariants(c, before)
  })

  test('5b. verify is PASS only on exit 0 and a last non-empty line of exactly VERIFY: PASS; VERIFY_FAILED outranks TOUCHED_MISMATCH', T, async () => {
    const variants = [
      { label: 'exit 1 after a VERIFY: PASS line', verifyMode: 'pass-exit1', dirty: false, touched: 'MATCH' },
      { label: 'exit 0 with text after the VERIFY: PASS line', verifyMode: 'pass-then-text', dirty: false, touched: 'MATCH' },
      { label: 'exit 0 with a last line that only contains VERIFY: PASS (suffix)', verifyMode: 'pass-suffix', dirty: false, touched: 'MATCH' },
      { label: 'exit 0 with a last line that only contains VERIFY: PASS (prefix)', verifyMode: 'pass-prefix', dirty: false, touched: 'MATCH' },
      { label: 'verify and touched both failed', verifyMode: 'fail', dirty: true, touched: 'MISMATCH' },
    ]
    await Promise.all(variants.map(async v => {
      const c = await makeCase()
      setVerifyMode(c, v.verifyMode)
      if (v.dirty) writeFileSync(join(c.repo, 'extra.txt'), 'x\n')
      const before = repoSnapshot(c)
      const report = assertReport(c, await loop(c, writeArgs(c)))
      const at = `[${v.label}]`
      assert.equal(report.status, 'escalate', at)
      assert.equal(report.reason, 'VERIFY_FAILED', at)
      assert.deepEqual(report.checks, { verify: 'FAIL', touched: v.touched, changed: v.dirty ? ['extra.txt'] : [], verifyTail: verifyTailFor(v.verifyMode) }, at)
      const { ledger } = await ledgerOf(c)
      assertLastRun(ledger, expectedRun(c, report, { status: 'escalate', reason: 'VERIFY_FAILED', stuckSig: null, downgradedFrom: 'done' }))
      assertInvariants(c, before)
    }))
  })

  // =============================================================== 6. touched
  test('6. a fixer touched list equal to the dirty files stays done (5 spawns, HEAD unchanged); a rename and unquoted names are compared as the machine form names them', T, async () => {
    // 6a: a modified tracked file named by the fixer.
    const a = await makeCase({ replies: { ...HAPPY, checker: [wire(FAIL), wire(PASS)], fixer: wire(fixed(['src/a.txt'])) } })
    writeFileSync(join(a.repo, 'src/a.txt'), 'one\nchanged\n')
    const beforeA = repoSnapshot(a)
    const ra = assertReport(a, await loop(a, writeArgs(a)))
    assert.equal(ra.status, 'done')
    assert.deepEqual(ra.touched, ['src/a.txt'])
    assert.deepEqual(ra.checks, { verify: 'PASS', touched: 'MATCH', changed: ['src/a.txt'], verifyTail: verifyTailFor('pass') })
    assert.equal(ra.fixRounds, 1)
    assertLeaves(a, ['checker', 'fixer', 'checker', 'reviewer', 'qa-auditor'])
    assertLastRun((await ledgerOf(a)).ledger, expectedRun(a, ra))
    assert.equal(git(a, 'rev-parse', 'HEAD'), beforeA.head, 'HEAD unchanged')
    assertGitCalls(a, { status: true })
    assertInvariants(a, beforeA)
  })

  test('6b. an extra untracked file, a ./-prefixed path and a missing path are TOUCHED_MISMATCH (no normalization); the downgrade keeps the graph result', T, async () => {
    const variants = [
      { label: 'an extra untracked file', touched: ['src/a.txt'], extra: true, changed: ['extra.txt', 'src/a.txt'] },
      { label: 'a ./-prefixed path', touched: ['./src/a.txt'], extra: false, changed: ['src/a.txt'] },
      { label: 'a named file that is not changed', touched: ['a.txt'], extra: false, changed: ['src/a.txt'] },
    ]
    await Promise.all(variants.map(async v => {
      const c = await makeCase({ replies: { ...HAPPY, checker: [wire(FAIL), wire(PASS)], fixer: wire(fixed(v.touched)) } })
      writeFileSync(join(c.repo, 'src/a.txt'), 'one\nchanged\n')
      if (v.extra) writeFileSync(join(c.repo, 'extra.txt'), 'x\n')
      const before = repoSnapshot(c)
      const report = assertReport(c, await loop(c, writeArgs(c)))
      const at = `[${v.label}]`
      assert.equal(report.status, 'escalate', at)
      assert.equal(report.graphStatus, 'done', at)
      assert.equal(report.reason, 'TOUCHED_MISMATCH', at)
      assert.equal(report.stuckSig, null, at)
      assert.deepEqual(report.touched, v.touched, at)
      assert.deepEqual(report.checks, { verify: 'PASS', touched: 'MISMATCH', changed: v.changed, verifyTail: verifyTailFor('pass') }, at)
      assertLeaves(c, ['checker', 'fixer', 'checker', 'reviewer', 'qa-auditor'])
      const { ledger } = await ledgerOf(c)
      assertLastRun(ledger, expectedRun(c, report, { status: 'escalate', reason: 'TOUCHED_MISMATCH', stuckSig: null, downgradedFrom: 'done' }))
      assertInvariants(c, before)
    }))
  })

  test('6c. both paths of a staged rename and a code-unit sort: git status -z, no quoting, no locale order', T, async () => {
    const touched = ['z renamed é.txt', 'B.txt', 'a.txt']   // any order: set equality
    const c = await makeCase({ replies: { ...HAPPY, checker: [wire(FAIL), wire(PASS)], fixer: wire(fixed(touched)) } })
    git(c, 'mv', 'a.txt', 'z renamed é.txt')
    writeFileSync(join(c.repo, 'B.txt'), 'b\nchanged\n')
    const before = repoSnapshot(c)
    const report = assertReport(c, await loop(c, writeArgs(c)))
    assert.equal(report.status, 'done')
    assert.deepEqual(report.checks, { verify: 'PASS', touched: 'MATCH', changed: ['B.txt', 'a.txt', 'z renamed é.txt'], verifyTail: verifyTailFor('pass') })
    assert.deepEqual(report.touched, touched)
    assertInvariants(c, before)
  })

  // ============================================================== 7. refusal
  test('7. a provider refusal (the reviewer) escalates after 2 spawns: no retry, no claude call, no verify run', T, async () => {
    const c = await makeCase({ replies: { ...HAPPY, reviewer: { refuse: true } } })
    const before = repoSnapshot(c)
    const report = assertReport(c, await loop(c, writeArgs(c)))
    assert.equal(report.status, 'escalate')
    assert.equal(report.graphStatus, 'escalate')
    assert.equal(report.reason, resultOf(c, report.invocationId).result.reason)
    assert.match(report.reason, /^reviewer failed/)
    assert.equal(report.stuckSig, null)
    assert.equal(report.fixRounds, 0)
    assert.deepEqual(report.touched, [])
    assert.equal(report.checks, null)
    assertLeaves(c, ['checker', 'reviewer'])
    const rows = rowFiles(nativeRunDir(c, report.invocationId)).filter(row => row.binding.agentType === 'reviewer')
    assert.equal(rows.length, 1, 'the refused leaf has one row')
    assert.equal(rows[0].state, 'failed')
    assert.equal(rows[0].completion.code, 'PROVIDER_REFUSAL')
    assert.equal(existsSync(c.verifyLog), false, 'verify did not run')
    const { ledger } = await ledgerOf(c)
    assert.equal(ledger.runs.length, 1)
    const run = assertLastRun(ledger, expectedRun(c, report))
    assert.equal('loopChecks' in run, false)
    assert.equal(existsSync(c.inflight), false)
    assertGitCalls(c, { status: false })
    assertInvariants(c, before)
  })

  // ========================================================= 8. crash recovery
  test('8. the host and qa-loop are SIGKILLed while the reviewer is held: the rerun resumes the same invocation (OWNER_BUSY, then CHECKPOINT_UNCERTAIN after unlock) and, after fail, records an escalate with zero new spawns', T, async () => {
    const c = await makeCase()
    await seedLedger(c, { runs: [seedRun], stuckSigs: ['seed-sig'], blockedOn: 'blocked: waiting for a human', idleRuns: 1 })
    const before = repoSnapshot(c)
    const file = writeArgs(c)
    const ledgerBytes = readFileSync(c.ledgerFile)
    // A FIFO named script.json holds the fake inside its own code: it reads the script
    // only after stdin closes, and blocks there until something writes.
    const fifo = join(c.fake, 'script.json')
    unlinkSync(fifo)
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'fixture: mkfifo')
    const run = startLoop(c, ['--args-file', file])
    let id, runDir, hostPid, fakePid
    try {
      await feedFifo(fifo, scriptText({ checker: HAPPY.checker }), run)
      await until(() => spawnCalls(c).length === 1, 'the checker leaf')
      await until(() => existsSync(c.inflight), 'the inflight file')
      ;({ invocationId: id, runDir } = readJson(c.inflight))
      const lock = join(runDir, 'checkpoints', '.lock')
      await until(() => pidsOf(c).length === 2 && rowOf(runDir, 'reviewer')?.state === 'prepared' && existsSync(lock), 'the reviewer leaf spawned with its row prepared')
      fakePid = pidsOf(c).at(-1)
      hostPid = readJson(lock).pid
      assert.equal(run.child.exitCode, null, 'qa-loop is still running')
      assert.ok(alive(hostPid) && alive(fakePid), 'the host and the held fake codex are running')
      // The whole tree: qa-loop first, then the host (by pid, the group is the test's), then the fake's group.
      run.child.kill('SIGKILL')
      assert.equal((await run.done).signal, 'SIGKILL')
      process.kill(hostPid, 'SIGKILL')
      await until(() => !alive(hostPid), 'the host to die')
      killGroup(fakePid)
      await until(() => !alive(fakePid), 'the fake codex process group to die')
      unlinkSync(fifo)
      writeFileSync(fifo, scriptText())
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL')
      await run.done
      if (hostPid !== undefined && alive(hostPid)) process.kill(hostPid, 'SIGKILL')
      const held = pidsOf(c).at(-1)
      if (held !== undefined && alive(held)) killGroup(held)
    }
    assert.match(id, INVOCATION)
    assert.equal(runDir, nativeRunDir(c, id))
    const inflightBytes = readFileSync(c.inflight)
    assert.equal(inflightBytes.toString(), JSON.stringify({ schemaVersion: 1, invocationId: id, runDir }) + '\n')
    assert.equal(mode(c.inflight), 0o600)
    const hostArgsBytes = readFileSync(hostArgsPath(c, id))
    assert.deepEqual(readFileSync(c.ledgerFile), ledgerBytes, 'the crash left the ledger alone')
    assert.equal(spawnCalls(c).length, 1)
    assert.equal(pidsOf(c).length, 2)

    // 1. A rerun resumes the same invocation: the host's lock is still held by the dead pid.
    const busy = await loop(c, file)
    assertExit4(c, busy, 'OWNER_BUSY', id, runDir)
    assert.deepEqual(readFileSync(c.ledgerFile), ledgerBytes)
    assert.deepEqual(readFileSync(c.inflight), inflightBytes, 'the same invocation is resumed')
    assert.deepEqual(readFileSync(hostArgsPath(c, id)), hostArgsBytes)
    assert.equal(spawnCalls(c).length, 1)
    assert.equal(pidsOf(c).length, 2)

    // 2. After the operator breaks the lock, the held call is uncertain.
    const lockBytes = readFileSync(join(runDir, 'checkpoints', '.lock'))
    const unlocked = await reconcile('unlock', '--run-dir', runDir, '--token', tokenOf(lockBytes))
    assert.equal(unlocked.code, 0, unlocked.stderr)
    const uncertain = await loop(c, file)
    assertExit4(c, uncertain, 'CHECKPOINT_UNCERTAIN', id, runDir)
    assert.deepEqual(readFileSync(c.ledgerFile), ledgerBytes)
    assert.deepEqual(readFileSync(c.inflight), inflightBytes)
    assert.equal(spawnCalls(c).length, 1, 'a held call was re-dispatched')
    assert.equal(pidsOf(c).length, 2)

    // 3. After the operator fails the held call, the rerun records an escalate and spawns nothing.
    const held = rowOf(runDir, 'reviewer').callId
    const failed = await reconcile('fail', '--run-dir', runDir, '--call-id', held, '--confirm', held)
    assert.equal(failed.code, 0, failed.stderr)
    const report = assertReport(c, await loop(c, file))
    assert.equal(report.invocationId, id)
    assert.equal(report.resumed, true)
    assert.equal(report.recorded, true)
    assert.equal(report.status, 'escalate')
    assert.equal(report.graphStatus, 'escalate')
    assert.equal(report.checks, null)
    assert.equal(report.ledgerWarning, null)
    assert.equal(spawnCalls(c).length, 1, 'a spawn happened on replay')
    assert.equal(pidsOf(c).length, 2, 'a spawn happened on replay')
    const { ledger } = await ledgerOf(c)
    assert.equal(ledger.runs.length, 2, 'exactly one run appended')
    assert.deepEqual(ledger.runs[0], seedRun)
    assert.equal(ledger.runs[1].invocationId, id)
    assertLastRun(ledger, expectedRun(c, report))
    assert.deepEqual([ledger.stuckSigs, ledger.blockedOn, ledger.idleRuns], [['seed-sig'], 'blocked: waiting for a human', 1])
    assert.equal(existsSync(c.inflight), false, 'the inflight file is removed')
    assert.equal(existsSync(c.verifyLog), false)
    assertInvariants(c, before)
  })

  // ========================================================= 9. already recorded
  // The crash window of done-path step 5 and 6: the ledger holds the run, the inflight
  // file is still there. Restores it, reruns, and asserts the replay never reaches the host.
  // The host leaves marks on every run (it takes and releases the checkpoint lock, rewrites
  // result.json), and the contract forbids rewriting the host args file, so an unchanged
  // stat snapshot of native-runs proves no host process ran. A host spawn is not observable
  // through PATH: qa-loop starts it by process.execPath, not through the node shim.
  async function replayRecorded(c, file, first) {
    assert.equal(first.recorded, true)
    assert.equal(existsSync(c.inflight), false)
    const id = first.invocationId
    const stat = statSync(c.ledgerFile)
    const ledgerBytes = readFileSync(c.ledgerFile)
    const spawned = spawnCalls(c).length
    const verified = verifyRuns(c).length
    const statuses = gitCalls(c).filter(call => call.argv[0] === 'status').length
    const listing = () => readdirSync(c.ledgerDir).filter(name => name !== 'native-inflight.json').sort()
    const dirBefore = listing()
    const runsBefore = statSnapshot(c.nativeRuns)
    writeFileSync(c.inflight, JSON.stringify({ schemaVersion: 1, invocationId: id, runDir: nativeRunDir(c, id) }) + '\n', { mode: 0o600 })
    const second = assertReport(c, await loop(c, file))
    assert.equal(second.recorded, false)
    assert.equal(second.resumed, true)
    assert.equal(second.invocationId, id)
    assert.deepEqual({ ...second, resumed: true, recorded: true }, { ...first, resumed: true, recorded: true },
      'the report is built from the stored run, not recomputed')
    assert.equal(spawnCalls(c).length, spawned, 'zero leaf spawns on the replay')
    assert.equal(pidsOf(c).length, spawned)
    assert.deepEqual(statSnapshot(c.nativeRuns), runsBefore, 'the host ran, or a host args file was written, on the replay')
    assert.equal(verifyRuns(c).length, verified, 'no verify run')
    assert.equal(gitCalls(c).filter(call => call.argv[0] === 'status').length, statuses, 'no status check')
    const after = statSync(c.ledgerFile)
    assert.deepEqual(readFileSync(c.ledgerFile), ledgerBytes, 'the ledger was written again')
    assert.deepEqual([after.ino, after.mtimeMs], [stat.ino, stat.mtimeMs])
    assert.deepEqual(listing(), dirBefore, 'a file appeared next to the ledger')
    assert.equal(existsSync(c.inflight), false, 'the replay removes the inflight file (done path step 6)')
    return second
  }

  test('9. a recorded done whose inflight file is restored reports recorded false with zero host, leaf and verify spawns, leaves the ledger bytes unchanged and removes the inflight file', T, async () => {
    const c = await makeCase()
    const before = repoSnapshot(c)
    const file = writeArgs(c)
    const first = assertReport(c, await loop(c, file))
    // A recomputed check could not match the stored one: verify would now fail and the tree is dirty.
    setVerifyMode(c, 'fail')
    writeFileSync(join(c.repo, 'late.txt'), 'x\n')
    const second = await replayRecorded(c, file, first)
    assert.equal(second.status, 'done')
    assert.equal(second.graphStatus, 'done')
    assert.equal((await ledgerOf(c)).ledger.runs.length, 1)
    // late.txt is this test's own addition after the repo snapshot.
    rmSync(join(c.repo, 'late.txt'))
    assertInvariants(c, before)
  })

  test('9b. a recorded escalate whose stuckSig changed the ledger stuckSigs is replayed without the host (bughunt F1): no CONFLICT, exit 0, recorded false', T, async () => {
    const c = await makeCase({ replies: { checker: wire(FAIL), fixer: wire(fixed([])), reviewer: wire(CLEAN), 'qa-auditor': wire(CLEAN) } })
    const before = repoSnapshot(c)
    const file = writeArgs(c, { maxFixRounds: 1 })
    const first = assertReport(c, await loop(c, file))
    assert.equal(first.status, 'escalate')
    assert.equal(first.stuckSig, FAIL_SIG)
    assert.deepEqual((await ledgerOf(c)).ledger.stuckSigs, [FAIL_SIG], 'the recorded run changed stuckSigs')
    // From the ledger the workflow args are now {knownStuckSigs: [FAIL_SIG]}: a host rerun would bind
    // another argsHash than the stored rows and be refused with CONFLICT.
    assert.equal(rowFiles(nativeRunDir(c, first.invocationId)).length, 3)
    const second = await replayRecorded(c, file, first)
    assert.equal(second.status, 'escalate')
    assert.equal(second.graphStatus, 'escalate')
    assert.equal(second.stuckSig, FAIL_SIG)
    assert.equal(second.fixRounds, 1)
    assert.equal(second.checks, null)
    assertLeaves(c, ['checker', 'fixer', 'checker'])
    assert.equal(existsSync(c.verifyLog), false)
    const { ledger } = await ledgerOf(c)
    assert.equal(ledger.runs.length, 1)
    assert.deepEqual(ledger.stuckSigs, [FAIL_SIG])
    assertInvariants(c, before)
  })

  test('9c. a recorded downgrade replays with graphStatus from downgradedFrom and the stored checks', T, async () => {
    const c = await makeCase()
    setVerifyMode(c, 'fail')
    const before = repoSnapshot(c)
    const file = writeArgs(c)
    const first = assertReport(c, await loop(c, file))
    assert.deepEqual([first.status, first.graphStatus, first.reason], ['escalate', 'done', 'VERIFY_FAILED'])
    const second = await replayRecorded(c, file, first)
    assert.deepEqual([second.status, second.graphStatus, second.reason, second.stuckSig], ['escalate', 'done', 'VERIFY_FAILED', null])
    assert.equal(second.checks.verify, 'FAIL')
    assertInvariants(c, before)
  })

  // ===================================================== 10. ledger and inflight
  test('10. an unparseable ledger is read as empty with LEDGER_UNPARSEABLE and rewritten valid', T, async () => {
    const variants = [['not JSON', '{"runs": '], ['a JSON array', '[]'], ['a wrong type', '{"runs":"x","stuckSigs":[],"blockedOn":null,"idleRuns":0}']]
    await Promise.all(variants.map(async ([label, text]) => {
      const c = await makeCase()
      mkdirSync(c.ledgerDir, { mode: 0o700 })
      writeFileSync(c.ledgerFile, text)
      const before = repoSnapshot(c)
      const report = assertReport(c, await loop(c, writeArgs(c)))
      const at = `[${label}]`
      assert.equal(report.ledgerWarning, 'LEDGER_UNPARSEABLE', at)
      assert.equal(report.status, 'done', at)
      assert.equal(report.recorded, true, at)
      assert.deepEqual(readJson(hostArgsPath(c, report.invocationId)).args, { repo: c.repo, maxFixRounds: 3, knownStuckSigs: [] }, at)
      const { ledger, warning } = await ledgerOf(c)
      assert.equal(warning, null, `${at} the file is a valid ledger again`)
      assert.equal(ledger.runs.length, 1, at)
      assert.deepEqual([ledger.stuckSigs, ledger.blockedOn, ledger.idleRuns], [[], null, 0], at)
      assertLastRun(ledger, expectedRun(c, report))
      assertInvariants(c, before)
    }))
  })

  test('10b. a corrupt inflight file is exit 2 INFLIGHT_INVALID with nothing spawned, written or removed', T, async () => {
    const c = await makeCase()
    const before = repoSnapshot(c)
    mkdirSync(c.ledgerDir, { mode: 0o700 })
    const good = { schemaVersion: 1, invocationId: 'qa-20260101T000000Z-0123abcd', runDir: nativeRunDir(c, 'qa-20260101T000000Z-0123abcd') }
    const text = value => JSON.stringify(value) + '\n'
    const variants = [
      ['not JSON', () => writeFileSync(c.inflight, 'garbage')],
      ['empty', () => writeFileSync(c.inflight, '')],
      ['a JSON array', () => writeFileSync(c.inflight, '[]\n')],
      ['an extra key', () => writeFileSync(c.inflight, text({ ...good, extra: 1 }))],
      ['a missing key', () => writeFileSync(c.inflight, text({ schemaVersion: 1, invocationId: good.invocationId }))],
      ['schemaVersion 2', () => writeFileSync(c.inflight, text({ ...good, schemaVersion: 2 }))],
      ['an invocationId off the pattern', () => writeFileSync(c.inflight, text({ ...good, invocationId: 'qa-bad', runDir: nativeRunDir(c, 'qa-bad') }))],
      ['an uppercase hex invocationId', () => {
        const bad = 'qa-20260101T000000Z-0123ABCD'
        writeFileSync(c.inflight, text({ ...good, invocationId: bad, runDir: nativeRunDir(c, bad) }))
      }],
      ['a runDir elsewhere', () => writeFileSync(c.inflight, text({ ...good, runDir: join(c.dir, 'elsewhere') }))],
      ['a runDir with a trailing slash', () => writeFileSync(c.inflight, text({ ...good, runDir: good.runDir + '/' }))],
      ['more than 4096 bytes', () => writeFileSync(c.inflight, text(good) + ' '.repeat(4097))],
      ['a symlink to a valid inflight file', () => {
        writeFileSync(join(c.dir, 'valid-inflight.json'), text(good))
        symlinkSync(join(c.dir, 'valid-inflight.json'), c.inflight)
      }],
      ['a directory', () => mkdirSync(c.inflight)],
    ]
    const file = writeArgs(c)
    for (const [label, make] of variants) {
      make()
      const snapshot = treeSnapshot(c.ledgerDir)
      const r = await loop(c, file)
      try {
        assertError(c, r, 2, 'INFLIGHT_INVALID')
        assert.deepEqual(treeSnapshot(c.ledgerDir), snapshot, 'something was written or removed')
        assert.equal(lstatSync(c.inflight, { throwIfNoEntry: false }) !== undefined, true, 'the inflight entry was removed')
        assert.equal(existsSync(c.nativeRuns), false, 'native-runs was created')
        assert.equal(existsSync(c.ledgerFile), false, 'a ledger was written')
        assertNoSpawns(c)
      } catch (error) { error.message = `[${label}] ${error.message}`; throw error }
      rmSync(c.inflight, { recursive: true, force: true })
    }
    assert.equal(gitCalls(c).length, 2 * variants.length, 'each refusal ran exactly the two repository lookups')
    assertInvariants(c, before)
  })

  // ===================================================== 11. production catalog
  test('11. the production catalog: installationRoot set to the candidate root exits 2 OFFERING_UNSUPPORTED with zero spawns, no run directory and no inflight file', T, async () => {
    // Amended for CP-06: the production dev row is partial now, so this case uses a copy of the
    // candidate root whose dev codex row is `unavailable` (the state the contract describes),
    // with the same INERT verify.sh as the fixture root.
    const unavailableRoot = realpathSync(mkdtempSync(join(WORK, 'root-unavailable-')))
    copyTree(unavailableRoot)
    const catalog = readJson(join(unavailableRoot, CATALOG))
    catalog.offerings.find(o => o.id === 'dev').providers.codex = { implementation: 'unavailable', transportId: null,
      limitations: ['NATIVE_UNVERIFIED', 'NO_PROVIDER_TRANSPORT', 'REQUIREMENTS_INCOMPLETE'] }
    writeFileSync(join(unavailableRoot, CATALOG), JSON.stringify(catalog, null, 2) + '\n')
    writeFileSync(join(unavailableRoot, 'core/skills/verify/verify.sh'), INERT_VERIFY)
    // No replies: a regressed refusal could only escalate, never reach a `done` and the real verify.sh.
    const c = await makeCase({ replies: {} })
    const before = repoSnapshot(c)
    const r = await loop(c, writeArgs(c, { installationRoot: unavailableRoot }))
    assertError(c, r, 2, 'OFFERING_UNSUPPORTED')
    assertNoSpawns(c)
    assert.equal(existsSync(c.inflight), false, 'the inflight file is removed when no run directory exists')
    assert.equal(existsSync(c.ledgerFile), false, 'nothing is recorded')
    assert.equal(existsSync(c.verifyLog), false)
    const entries = readdirSync(c.nativeRuns)
    assert.equal(entries.length, 1, `native-runs holds only the host args file: ${entries}`)
    assert.match(entries[0], /^qa-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.host-args\.json$/)
    const id = entries[0].replace('.host-args.json', '')
    assert.equal(existsSync(nativeRunDir(c, id)), false, 'no run directory')
    assert.equal(readJson(hostArgsPath(c, id)).installationRoot, unavailableRoot)
    assertGitCalls(c, { status: false })
    assertInvariants(c, before)
  })

  // ===================================================== 12. every case
  test('12. HEAD, refs, staged entries and the work tree are unchanged; the git wrapper saw only rev-parse and status; the gh and claude stubs recorded nothing', T, async () => {
    const c = await makeCase()
    // A staged add, an unstaged edit and an untracked file: none of them may be touched.
    writeFileSync(join(c.repo, 'staged.txt'), 's\n')
    git(c, 'add', 'staged.txt')
    writeFileSync(join(c.repo, 'a.txt'), 'a\nunstaged\n')
    writeFileSync(join(c.repo, 'untracked.txt'), 'u\n')
    const before = repoSnapshot(c)
    assert.ok(before.staged.includes('staged.txt'))
    const report = assertReport(c, await loop(c, writeArgs(c)))
    assert.equal(report.status, 'escalate')
    assert.equal(report.reason, 'TOUCHED_MISMATCH')
    assert.deepEqual(report.checks.changed, ['a.txt', 'staged.txt', 'untracked.txt'])
    assertLeaves(c, ['checker', 'reviewer', 'qa-auditor'])
    const calls = gitCalls(c)
    assert.deepEqual(calls.map(call => call.argv[0]), ['rev-parse', 'rev-parse', 'status'])
    assertGitCalls(c, { status: true })
    assertInvariants(c, before)
    assert.equal(git(c, 'rev-parse', 'HEAD'), before.head)
    assert.equal(git(c, 'ls-files', '-s', '-z'), before.staged)
    assert.equal(existsSync(c.claudeCalls), false)
    assert.equal(existsSync(c.ghCalls), false)
  })
})

// A FIFO writer for the held-leaf cases: writes `text` once a reader has the FIFO open
// (non-blocking open, so a reader that never comes is a bounded failure, not a hang).
async function feedFifo(path, text, run) {
  let fd
  await until(() => {
    assert.equal(run.child.exitCode, null, 'qa-loop exited before the leaf read its script')
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

// ---------------------------------------------------------------- case 13
// One iteration at a time (step 2a; bughunt F1). Self-contained: the candidate's qa-loop.mjs
// and qa-ledger.mjs are copied into an owned code root whose graph-host.mjs is a stub that
// records each call and writes a valid `done` result, and whose verify.sh parks until the
// test creates `release` (so a parked verify never depends on how many iterations run).
// No codex, claude, gh, network or HOME; the repository's own verify.sh is never run.
const L13_STUB_HOST = `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const args = JSON.parse(readFileSync(process.argv[3], 'utf8'))
appendFileSync(process.env.L13_DIR + '/host-calls.log', args.invocationId + '\\n')
mkdirSync(args.runDir, { recursive: true })
writeFileSync(args.runDir + '/result.json', JSON.stringify({ schemaVersion: 1, workflowId: 'harness-repair', offeringId: 'dev',
  invocationId: args.invocationId, status: 'done',
  result: { status: 'done', touched: [], fixRounds: 0, reason: 'stub', stuckSig: null } }))
process.stdout.write('{"status":"done"}\\n')
`
// Marks itself in verify, then waits (at most ~40 s, under the 60 s verify timeout) for `release`.
const L13_VERIFY = `: > "$L13_DIR/in-verify.$$"
for _ in $(seq 1 800); do
  [ -e "$L13_DIR/release" ] && break
  sleep 0.05
done
printf 'VERIFY: PASS\\n'
`
const L13_TOKEN = '0123456789abcdef' // allow-secret: a fixture lock token
const l13Lock = (pid, extra = {}) => Buffer.from(JSON.stringify({ schemaVersion: 1, pid, token: L13_TOKEN, ...extra }) + '\n')
const l13Hint = pid => `another qa-loop iteration (pid ${pid}) is running in this repository; run it again after that one exits`

// Recursive listing of a directory: relative path -> 'dir' or the file's bytes (hex).
function l13Snapshot(dir, prefix = '') {
  const out = {}
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name
    if (entry.isDirectory()) { out[rel] = 'dir'; Object.assign(out, l13Snapshot(join(dir, entry.name), rel + '/')) } else out[rel] = readFileSync(join(dir, entry.name)).toString('hex')
  }
  return out
}

// A non-throwing bounded wait: true when `check` became true.
async function l13Wait(check, ms) {
  for (const end = Date.now() + ms; Date.now() < end && !check(); await sleep(10));
  return check()
}

// One owned repository + code root. verify parks until `release()`; cleanup releases and kills.
function l13Fixture(t) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cp-05d-case13-')))
  const state = join(work, 'state')
  const repo = join(work, 'repo')
  const install = join(work, 'install')
  const codeRoot = join(work, 'code')
  for (const dir of [state, repo, join(install, 'core/skills/verify'), join(codeRoot, 'graphs/qa/tool'),
    join(codeRoot, 'core/skills/native-runtime')]) mkdirSync(dir, { recursive: true })
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  assert.equal(spawnSync('git', ['init', '-q', repo], { env: gitEnv }).status, 0, 'fixture: git init')
  writeFileSync(join(install, 'core/skills/verify/verify.sh'), L13_VERIFY)
  for (const name of ['qa-loop.mjs', 'qa-ledger.mjs']) cpSync(join(ROOT, 'graphs/qa/tool', name), join(codeRoot, 'graphs/qa/tool', name))
  writeFileSync(join(codeRoot, 'core/skills/native-runtime/graph-host.mjs'), L13_STUB_HOST)
  writeFileSync(join(codeRoot, 'core/skills/native-runtime/graph-reconcile.mjs'), '')
  const argsFile = join(work, 'loop-args.json')
  writeFileSync(argsFile, JSON.stringify({ schemaVersion: 1, repo, installationRoot: install, codexBin: join(work, 'codex'),
    env: {}, timeoutMs: 60000 }))
  const ledgerDir = spawnSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'harness-loop'],
    { env: gitEnv, encoding: 'utf8' }).stdout.trim()
  assert.ok(ledgerDir.startsWith('/'), 'fixture: ledger dir')

  const children = []
  const env = { ...gitEnv, L13_DIR: state }
  const fixture = {
    ledgerDir,
    lockFile: join(ledgerDir, 'native-loop.lock'),
    start() {
      const proc = { exited: false, stdout: '', stderr: '' }
      const child = spawn(process.execPath, [join(codeRoot, 'graphs/qa/tool/qa-loop.mjs'), '--args-file', argsFile],
        { env, stdio: ['ignore', 'pipe', 'pipe'] })
      // qa-loop runs node directly, so the spawned pid is the pid its lock names.
      proc.pid = child.pid
      children.push(child)
      child.stdout.on('data', d => { proc.stdout += d })
      child.stderr.on('data', d => { proc.stderr += d })
      proc.done = new Promise(resolve => child.on('close', code => { proc.exited = true; proc.code = code; resolve(proc) }))
      return proc
    },
    release: () => writeFileSync(join(state, 'release'), 'go\n'),
    inVerify: () => readdirSync(state).filter(name => name.startsWith('in-verify.')).length,
    hostCalls: () => lines(join(state, 'host-calls.log')),
    ledgerRuns: () => existsSync(join(ledgerDir, 'ledger.json')) ? readJson(join(ledgerDir, 'ledger.json')).runs : [],
    lockResidue: () => existsSync(ledgerDir) ? readdirSync(ledgerDir).filter(name => name.startsWith('native-loop.lock')) : [],
    plantLock(bytes) {
      mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
      writeFileSync(fixture.lockFile, bytes, { mode: 0o600 })
    },
    detail: procs => `host calls: ${JSON.stringify(fixture.hostCalls())}; ledger runs: ${fixture.ledgerRuns().length}; ` +
      `lock files: ${JSON.stringify(fixture.lockResidue())}; ` + procs.map((p, i) => `proc${i} exit ${p.code} stdout ${JSON.stringify(p.stdout)} stderr ${JSON.stringify(p.stderr)}`).join('; '),
  }
  t.after(async () => {
    try { fixture.release() } catch { /* the work directory may already be gone */ }
    for (const child of children) { try { child.kill('SIGKILL') } catch { /* already exited */ } }
    await sleep(50)
    rmSync(work, { recursive: true, force: true })
  })
  return fixture
}

// Asserts `proc` refused with exit 4 OWNER_BUSY naming `pid`: one stderr line, empty stdout.
function l13AssertBusy(proc, pid, detail) {
  assert.equal(proc.code, 4, `expected exit 4 OWNER_BUSY. ${detail}`)
  assert.equal(proc.stdout, '', `a refused iteration prints nothing on stdout. ${detail}`)
  assert.ok(proc.stderr.endsWith('\n') && proc.stderr.indexOf('\n') === proc.stderr.length - 1, `stderr must be exactly one line. ${detail}`)
  assert.deepEqual(JSON.parse(proc.stderr), { error: 'OWNER_BUSY', invocationId: null, hint: l13Hint(pid) }, detail)
}

// A pid that is dead: a trivial child that has exited.
async function l13DeadPid() {
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise(resolve => dead.on('close', resolve))
  return dead.pid
}

describe('13. one iteration at a time (step 2a; bughunt F1)', () => {
  test('live owner: a second iteration is refused while the first finalises, and writes nothing', T, async t => {
    const fx = l13Fixture(t)
    const a = fx.start()
    assert.ok(await l13Wait(() => fx.inVerify() >= 1 || a.exited, 60000) && fx.inVerify() >= 1,
      `fixture: A never reached verify. ${fx.detail([a])}`)
    const before = l13Snapshot(fx.ledgerDir)
    assert.ok(Object.hasOwn(before, 'native-inflight.json'), 'fixture: A left no inflight file while parked')

    // B: bounded wait for it to finish, or for it to have run the host (a missing lock).
    const b = fx.start()
    await l13Wait(() => b.exited || fx.hostCalls().length >= 2 || fx.inVerify() >= 2, 15000)
    const bFinished = b.exited
    const afterB = l13Snapshot(fx.ledgerDir)
    const callsDuringB = fx.hostCalls().length
    fx.release()
    await a.done
    await b.done
    const detail = fx.detail([a, b])

    assert.equal(bFinished, true, `B did not refuse while A was running (it re-ran the host or waited). ${detail}`)
    l13AssertBusy(b, a.pid, detail)
    assert.equal(callsDuringB, 1, `B ran the host. ${detail}`)
    assert.deepEqual(afterB, before, `B changed the ledger directory. ${detail}`)
    assert.equal(a.code, 0, `A must finish normally. ${detail}`)
    assert.equal(fx.hostCalls().length, 1, `exactly one host call. ${detail}`)
    assert.equal(fx.ledgerRuns().length, 1, `exactly one ledger run. ${detail}`)
    assert.equal(existsSync(fx.lockFile), false, `native-loop.lock must be released. ${detail}`)
  })

  test('a lock whose pid is alive (the test process) refuses and is left untouched', T, async t => {
    const fx = l13Fixture(t)
    fx.release()
    const bytes = l13Lock(process.pid)
    fx.plantLock(bytes)
    const before = l13Snapshot(fx.ledgerDir)
    assert.deepEqual(Object.keys(before), ['native-loop.lock'], 'fixture: only the planted lock')
    const run = fx.start()
    await run.done
    const detail = fx.detail([run])
    assert.equal(fx.hostCalls().length, 0, `the host ran. ${detail}`)
    l13AssertBusy(run, process.pid, detail)
    assert.ok(existsSync(fx.lockFile) && readFileSync(fx.lockFile).equals(bytes), `the lock bytes changed. ${detail}`)
    assert.deepEqual(l13Snapshot(fx.ledgerDir), before, `the ledger directory changed (only the lock may exist). ${detail}`)
  })

  test('a lock whose pid is dead is taken over: exit 0, one host call, no lock, no stale file', T, async t => {
    const fx = l13Fixture(t)
    fx.release()
    fx.plantLock(l13Lock(await l13DeadPid()))
    const run = fx.start()
    await run.done
    const detail = fx.detail([run])
    assert.equal(run.code, 0, `a dead owner's lock must be taken over. ${detail}`)
    assert.equal(fx.hostCalls().length, 1, detail)
    assert.equal(fx.ledgerRuns().length, 1, detail)
    assert.deepEqual(fx.lockResidue(), [], `no native-loop.lock and no native-loop.lock.stale-* file may remain. ${detail}`)
  })

  const invalidLocks = {
    'text that is not JSON': Buffer.from('not a lock\n'),
    'an empty file': Buffer.alloc(0),
    'an extra key, pid alive': l13Lock(process.pid, { extra: 1 }),
    'a token that is not 16 lowercase hex, pid alive': Buffer.from(JSON.stringify({ schemaVersion: 1, pid: process.pid, token: 'ABCDEF0123456789' }) + '\n'), // allow-secret: invalid-token fixture
    'schemaVersion 2, pid alive': Buffer.from(JSON.stringify({ schemaVersion: 2, pid: process.pid, token: L13_TOKEN }) + '\n'),
    'a pid that is not a positive integer': Buffer.from(JSON.stringify({ schemaVersion: 1, pid: 0, token: L13_TOKEN }) + '\n'),
  }
  for (const [what, bytes] of Object.entries(invalidLocks)) {
    test(`a lock with invalid bytes (${what}) is taken over: exit 0, one host call, no lock, no stale file`, T, async t => {
      const fx = l13Fixture(t)
      fx.release()
      fx.plantLock(bytes)
      const run = fx.start()
      await run.done
      const detail = fx.detail([run])
      assert.equal(run.code, 0, `an invalid lock is stale and must be taken over. ${detail}`)
      assert.equal(fx.hostCalls().length, 1, detail)
      assert.equal(fx.ledgerRuns().length, 1, detail)
      assert.deepEqual(fx.lockResidue(), [], `no native-loop.lock and no native-loop.lock.stale-* file may remain. ${detail}`)
    })
  }

  test("two iterations started together over a dead owner's lock: one runs, the other is refused", T, async t => {
    const fx = l13Fixture(t)
    fx.plantLock(l13Lock(await l13DeadPid()))
    const procs = [fx.start(), fx.start()]
    // Either one is refused at once, or (no lock) both reach verify.
    await l13Wait(() => procs.some(p => p.exited) || fx.inVerify() >= 2, 15000)
    fx.release()
    await Promise.all(procs.map(p => p.done))
    const detail = fx.detail(procs)
    assert.equal(fx.hostCalls().length, 1, `exactly one host call. ${detail}`)
    assert.equal(fx.ledgerRuns().length, 1, `exactly one ledger run. ${detail}`)
    assert.deepEqual(procs.map(p => p.code).sort(), [0, 4], `exactly one iteration must exit 4 and the other 0. ${detail}`)
    const loser = procs.find(p => p.code === 4)
    const winner = procs.find(p => p.code === 0)
    l13AssertBusy(loser, winner.pid, detail)
    assert.deepEqual(fx.lockResidue(), [], `no lock or stale file may remain. ${detail}`)
  })
})
