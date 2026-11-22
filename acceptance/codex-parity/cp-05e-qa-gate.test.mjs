// CP-05e frozen acceptance: the native QA gate proof (spec/contracts/codex-parity-cp-05e.md).
// Wiring proof, not runtime certification: no real codex, no claude, no gh, no network,
// no HOME. Each scenario runs the candidate's qa-loop.mjs (CP-05d) as a CLI around the real
// CP-02e host and the frozen fake codex acceptance/codex-parity/cp-02f-fake-codex.cjs, whose
// reply `writes` (W2-9) is how the scripted fixer changes the fixture repository's tree.
// The installation root is the CP-05d fixture root (the candidate catalog with only `dev`'s
// codex row flipped to partial) whose core/skills/verify/verify.sh is replaced by an INERT
// script that runs the fixture repository's own scripts/test.sh: the repository's own
// verify.sh, its capture machinery and the blocked nested-capture reproduction are never
// run (AGENTS.md). Frozen tests are self-contained: helpers are copied from cp-05d.
// A failure whose message starts with "fixture:" is a fixture bug.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = realpathSync(process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../', import.meta.url)))
const QA_LOOP = join(ROOT, 'graphs/qa/tool/qa-loop.mjs')
const FAKE_CODEX = fileURLToPath(new URL('./cp-02f-fake-codex.cjs', import.meta.url))
const CATALOG = 'spec/offering-capabilities.json'
const PROOF_REF = 'cp-05e-qa-gate'
const loadModule = rel => import(pathToFileURL(resolve(ROOT, rel)).href)
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
const T = { timeout: 240000 }
const NR01_WIRE = '{"type":"object","properties":{"json":{"type":"string"}},"required":["json"],"additionalProperties":false}'
// The sh shim that records each pid exports PWD (and, on some shells, SHLVL, _ and OLDPWD) before it execs node.
const SPAWN_ENV_NOISE = ['__CF_USER_TEXT_ENCODING', 'PWD', 'OLDPWD', 'SHLVL', '_']
const REPORT_KEYS = ['status', 'graphStatus', 'invocationId', 'resumed', 'recorded', 'reason', 'stuckSig', 'fixRounds', 'touched', 'checks', 'ledgerWarning']

// ---------------------------------------------------------------- fixture root
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

// The INERT verify.sh: bash builtins only (PATH is the case's bin/), runs the fixture
// repository's own scripts/test.sh from the repository top level, and prints a VERIFY
// block whose last line is `VERIFY: PASS` only when that test exited 0.
const INERT_MARK = 'CP05E-INERT-VERIFY'
const INERT_VERIFY = `# ${INERT_MARK}: an acceptance fixture, never the repository's verify.sh.
bash scripts/test.sh
code=$?
printf '  [%s] bash scripts/test.sh\\n' "$code"
if [ "$code" -eq 0 ]; then
  printf 'VERIFY: PASS\\n'
  exit 0
fi
printf 'VERIFY: FAIL\\n'
exit 1
`
// Exits 0 only when src/value.txt holds exactly "fixed\n" (builtins only: no cat, no cmp).
const TEST_SH = `content=
IFS= read -r -d '' content < src/value.txt
[ "$content" = $'fixed\\n' ]
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
async function root() {
  if (FIXTURE_ROOT) return FIXTURE_ROOT
  const dir = realpathSync(mkdtempSync(join(WORK, 'root-')))
  copyTree(dir)
  const catalog = readJson(join(dir, CATALOG))
  const row = catalog.offerings.find(o => o.id === 'dev')
  assert.ok(row?.providers?.codex, 'fixture: the candidate catalog is v2 with provider rows (CP-01b)')
  row.providers.codex = structuredClone(PARTIAL)
  writeFileSync(join(dir, CATALOG), JSON.stringify(catalog, null, 2) + '\n')
  mkdirSync(join(dir, 'core/skills/verify'), { recursive: true })
  writeFileSync(join(dir, 'core/skills/verify/verify.sh'), INERT_VERIFY)
  assert.ok(readFileSync(join(dir, 'core/skills/verify/verify.sh'), 'utf8').includes(INERT_MARK), 'fixture: verify.sh is inert')
  const { assembleRoleInstructions } = await loadModule('core/skills/native-runtime/role-files.mjs')
  PREFIXES = QA_ROLES.map(role => ({ role, prefix: assembleRoleInstructions({ installationRoot: dir, name: role }).instructions + '\n\n' }))
  FIXTURE_ROOT = dir
  return dir
}

before(() => {
  WORK = realpathSync(mkdtempSync(join(tmpdir(), 'cp-05e-')))
  REAL_GIT = findOnPath('git')
  REAL_BASH = findOnPath('bash')
})
after(() => rmSync(WORK, { recursive: true, force: true }))

// --------------------------------------------------------------------- replies
const wire = value => ({ json: JSON.stringify(value) })
const FAIL = { verdict: 'FAIL', verify_block: '  [1] bash scripts/test.sh\nVERIFY: FAIL',
  failures: [{ step: 'bash scripts/test.sh', exit: 1, error_key: 'cp05e-fixture-failure', excerpt: 'src/value.txt is not fixed' }] }
const PASS = { verdict: 'PASS', verify_block: '  [0] bash scripts/test.sh\nVERIFY: PASS', failures: [] }
const CLEAN = { files_reviewed: 1, findings: [] }
const fixerReply = content => ({
  ...wire({ fixed: ['src/value.txt'], unfixed: [], touched: ['src/value.txt'], verify_verdict: 'NOT_RUN', summary: 'fixture' }),
  writes: { 'src/value.txt': content } })
const repliesFor = content => ({ checker: [wire(FAIL), wire(PASS)], fixer: fixerReply(content), reviewer: wire(CLEAN), 'qa-auditor': wire(CLEAN) })
const SANDBOX = { checker: 'workspace-write', fixer: 'workspace-write' }

// ------------------------------------------------------------------ case helpers
const GIT_ENV = { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'cp05e', GIT_AUTHOR_EMAIL: 'cp05e@example.invalid', GIT_COMMITTER_NAME: 'cp05e', GIT_COMMITTER_EMAIL: 'cp05e@example.invalid' }
// The test's own git: the real one, by absolute path, never through the recording wrapper.
function git(c, ...args) {
  const r = spawnSync(REAL_GIT, ['-c', 'init.defaultBranch=main', ...args], { cwd: c.repo, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(r.status, 0, `fixture: git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}
const stubScript = file => `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(file)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`

async function makeCase(replies) {
  await root()
  assert.ok(REAL_GIT && REAL_BASH, 'fixture: git and bash must be found on PATH')
  const dir = realpathSync(mkdtempSync(join(WORK, 'case-')))
  const c = { dir, repo: join(dir, 'repo'), fake: join(dir, 'fake'), bin: join(dir, 'bin'), codex: join(dir, 'codex-bin', 'codex'),
    pids: join(dir, 'pids.txt'), gitLog: join(dir, 'git-calls.log'), claudeCalls: join(dir, 'claude-calls.jsonl'),
    ghCalls: join(dir, 'gh-calls.jsonl') }
  for (const d of [c.repo, c.fake, c.bin, dirname(c.codex)]) mkdirSync(d)
  for (const path of [c.pids, c.gitLog, c.dir, process.execPath, REAL_GIT]) assert.ok(!path.includes("'"), 'fixture: shim paths quote safely')
  writeFileSync(join(c.bin, 'node'), `#!/bin/sh\necho $$ >> '${c.pids}'\nexec '${process.execPath}' "$@"\n`)
  writeFileSync(join(c.bin, 'git'), `#!/bin/sh\n{ printf '%s' "$(pwd -P)"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> '${c.gitLog}'\nexec '${REAL_GIT}' "$@"\n`)
  writeFileSync(join(c.bin, 'claude'), stubScript(c.claudeCalls))
  writeFileSync(join(c.bin, 'gh'), stubScript(c.ghCalls))
  for (const name of ['node', 'git', 'claude', 'gh']) chmodSync(join(c.bin, name), 0o755)
  symlinkSync(REAL_BASH, join(c.bin, 'bash'))
  cpSync(FAKE_CODEX, c.codex)
  chmodSync(c.codex, 0o755)
  writeFileSync(join(c.fake, 'script.json'), JSON.stringify({ roles: PREFIXES, replies }))
  // The fixture repository: one commit holding the real failing test and the broken value.
  git(c, 'init', '-q')
  mkdirSync(join(c.repo, 'scripts'))
  mkdirSync(join(c.repo, 'src'))
  writeFileSync(join(c.repo, 'scripts/test.sh'), TEST_SH)
  writeFileSync(join(c.repo, 'src/value.txt'), 'broken\n')
  git(c, 'add', '-A')
  git(c, 'commit', '-q', '-m', 'fixture')
  c.valueFile = join(c.repo, 'src/value.txt')
  c.ledgerFile = join(c.repo, '.git', 'harness-loop', 'ledger.json')
  return c
}
const leafEnv = c => ({ PATH: c.bin, FAKE_CODEX_DIR: c.fake })
const loopEnv = c => ({ PATH: c.bin, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
// The inert verify.sh run by hand, in the repository, with the same PATH the loop gives it.
function runVerify(c) {
  return spawnSync(REAL_BASH, [join(FIXTURE_ROOT, 'core/skills/verify/verify.sh')],
    { cwd: c.repo, env: { PATH: c.bin }, encoding: 'utf8' })
}
const lastLine = text => text.split('\n').map(l => l.trimEnd()).filter(l => l !== '').at(-1)

function runLoop(c) {
  assert.ok(existsSync(QA_LOOP), `qa-loop.mjs must exist at ${QA_LOOP} (CP-05d is not built at this freeze)`)
  const argsFile = join(c.dir, 'loop-args.json')
  writeFileSync(argsFile, JSON.stringify({ schemaVersion: 1, repo: c.repo, installationRoot: FIXTURE_ROOT, codexBin: c.codex,
    env: leafEnv(c), timeoutMs: 120000 }))
  const child = spawn(process.execPath, [QA_LOOP, '--args-file', argsFile], { cwd: c.dir, env: loopEnv(c), stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise(done => {
    let stdout = '', stderr = ''
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 120000)
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', (code, signal) => { clearTimeout(watchdog); done({ code, signal, stdout, stderr }) })
  })
}

const spawnCalls = c => lines(join(c.fake, 'calls.jsonl')).map(line => JSON.parse(line))
const gitCalls = c => lines(c.gitLog).map(line => { const [cwd, ...argv] = line.split('\t'); return { cwd, argv } })
const resultOf = (c, id) => readJson(join(c.repo, '.git', 'harness-loop', 'native-runs', id, 'result.json'))
function parseReport(r) {
  assert.equal(r.code, 0, `exit ${r.code}, stderr: ${r.stderr}`)
  assert.equal(r.stderr, '', 'stderr is empty')
  assert.ok(r.stdout.endsWith('\n') && r.stdout.indexOf('\n') === r.stdout.length - 1, 'stdout is exactly one line')
  const report = JSON.parse(r.stdout)
  assert.deepEqual(Object.keys(report), REPORT_KEYS, 'report keys, in order')
  return report
}
function repoSnapshot(c) {
  return { head: git(c, 'rev-parse', 'HEAD'), refs: git(c, 'for-each-ref', '--format=%(refname) %(objectname)'),
    staged: git(c, 'ls-files', '-s', '-z') }
}
function assertLeaves(c, roles) {
  const seen = spawnCalls(c)
  assert.deepEqual(seen.map(call => call.role), roles, 'spawn order')
  assert.deepEqual(seen.map(call => call.sandbox), roles.map(role => SANDBOX[role] ?? 'read-only'), 'sandboxes')
  return seen
}

// One scenario per fixer content, run once and shared by the cases that read it (cases 1 to 3).
const SCENARIOS = new Map()
function scenario(name, content) {
  if (!SCENARIOS.has(name)) {
    SCENARIOS.set(name, (async () => {
      const c = await makeCase(repliesFor(content))
      const verifyBefore = runVerify(c)
      const before = repoSnapshot(c)
      const r = await runLoop(c)
      return { c, verifyBefore, before, r }
    })())
  }
  return SCENARIOS.get(name)
}
const REAL_FIX = () => scenario('fix', 'fixed\n')
const UNPROVEN = () => scenario('unproven', 'still broken\n')

// ============================================================ 1. a real fix
describe('CP-05e native QA gate (frozen acceptance; wiring proof on the fake codex)', () => {
  test('1. the gate passes on a real fix: the real test fails before, the fixer changes the file, verify PASS, touched MATCH, done, nothing committed', T, async () => {
    const { c, verifyBefore, before, r } = await REAL_FIX()
    // The test is real: before the iteration the inert verify.sh fails on the committed tree.
    assert.equal(verifyBefore.status, 1, `verify exit before (stderr ${verifyBefore.stderr})`)
    assert.equal(lastLine(verifyBefore.stdout), 'VERIFY: FAIL')

    const report = parseReport(r)
    assertLeaves(c, ['checker', 'fixer', 'checker', 'reviewer', 'qa-auditor'])
    assert.equal(report.status, 'done')
    assert.equal(report.graphStatus, 'done')
    assert.equal(report.recorded, true)
    assert.equal(report.fixRounds, 1)
    assert.deepEqual(report.touched, ['src/value.txt'])
    assert.equal(report.checks.verify, 'PASS')
    assert.equal(report.checks.touched, 'MATCH')
    assert.deepEqual(report.checks.changed, ['src/value.txt'])

    const { readLedger } = await loadModule('graphs/qa/tool/qa-ledger.mjs')
    const { ledger, warning } = await readLedger(c.ledgerFile)
    assert.equal(warning, null)
    assert.equal(ledger.runs.length, 1, 'exactly one recorded ledger run')
    const run = ledger.runs[0]
    assert.equal(run.status, 'done')
    assert.equal(run.invocationId, report.invocationId)
    assert.equal(run.loopChecks.verify, 'PASS')
    assert.equal(run.loopChecks.touched, 'MATCH')
    assert.deepEqual(run.loopChecks.changed, ['src/value.txt'])
    assert.equal(resultOf(c, report.invocationId).result.status, 'done')

    assert.equal(readFileSync(c.valueFile, 'utf8'), 'fixed\n')
    // W2-8: no commit. HEAD, refs and the index are what they were before the run.
    assert.deepEqual(repoSnapshot(c), before, 'HEAD, refs and the index are unchanged')
    assert.equal(git(c, 'status', '--porcelain=v1', '--untracked-files=all'), ' M src/value.txt\n')
    // The inert verify.sh now passes on the fixed tree: the test the gate ran is the real one.
    assert.equal(lastLine(runVerify(c).stdout), 'VERIFY: PASS')
  })

  // ========================================================== 2. an unproven fix
  test('2. the gate refuses an unproven fix: the checker claims PASS, the real test still fails, so qa-loop records escalate VERIFY_FAILED (downgradedFrom done)', T, async () => {
    const { c, before, r } = await UNPROVEN()
    const report = parseReport(r)
    assertLeaves(c, ['checker', 'fixer', 'checker', 'reviewer', 'qa-auditor'])
    assert.equal(report.graphStatus, 'done', 'the graph itself said done (the second checker claimed a pass)')
    assert.equal(report.status, 'escalate')
    assert.equal(report.reason, 'VERIFY_FAILED')
    assert.equal(report.recorded, true)
    assert.equal(report.checks.verify, 'FAIL')
    assert.equal(readFileSync(c.valueFile, 'utf8'), 'still broken\n')

    const { readLedger } = await loadModule('graphs/qa/tool/qa-ledger.mjs')
    const { ledger, warning } = await readLedger(c.ledgerFile)
    assert.equal(warning, null)
    assert.equal(ledger.runs.length, 1, 'exactly one recorded ledger run')
    const run = ledger.runs[0]
    assert.equal(run.status, 'escalate')
    assert.equal(run.reason, 'VERIFY_FAILED')
    assert.equal(run.downgradedFrom, 'done')
    assert.equal(run.loopChecks.verify, 'FAIL')
    assert.equal(run.invocationId, report.invocationId)
    assert.equal(resultOf(c, report.invocationId).result.status, 'done', 'the graph result stays done')

    // Nothing is committed.
    assert.deepEqual(repoSnapshot(c), before, 'HEAD, refs and the index are unchanged')
    assert.equal(lastLine(runVerify(c).stdout), 'VERIFY: FAIL')
  })

  // ========================================================== 3. what reached Codex
  test('3. what reached Codex, over both runs: an object schema with additionalProperties false, the resolved verify.sh path, no .claude, the leaf env and --ignore-user-config, no claude or gh, git only rev-parse and status', T, async () => {
    const runs = [await REAL_FIX(), await UNPROVEN()]
    for (const { c, r } of runs) {
      parseReport(r)
      const calls = spawnCalls(c)
      assert.equal(calls.length, 5)
      const verifyCommand = `bash "${join(FIXTURE_ROOT, 'core/skills/verify/verify.sh')}"`
      for (const call of calls) {
        assert.ok(typeof call.schema === 'string' && call.schema.length > 0, `${call.role} was handed an --output-schema file`)
        assert.notEqual(call.schema, NR01_WIRE, `${call.role} schema is not the NR-01 wire string`)
        const schema = JSON.parse(call.schema)
        assert.equal(typeof schema, 'object', `${call.role} schema is an object`)
        assert.notEqual(schema, null)
        assert.equal(schema.additionalProperties, false, `${call.role} schema additionalProperties`)
        if (call.role === 'checker' || call.role === 'fixer') {
          assert.ok(call.stdin.includes(verifyCommand), `${call.role} stdin runs ${verifyCommand}`)
        }
        assert.ok(!call.stdin.includes('.claude'), `${call.role} stdin carries .claude`)
        assert.ok(!call.stdin.includes('CLAUDE_CONFIG_DIR'), `${call.role} stdin carries CLAUDE_CONFIG_DIR`)
        assert.deepEqual(Object.keys(call.env).filter(k => !SPAWN_ENV_NOISE.includes(k)).sort(), ['FAKE_CODEX_DIR', 'PATH'], `${call.role} env keys`)
        assert.equal(call.env.PATH, c.bin)
        assert.equal(call.env.FAKE_CODEX_DIR, c.fake)
        assert.ok(call.argv.includes('--ignore-user-config'), `${call.role} argv has --ignore-user-config`)
      }
      assert.equal(existsSync(c.claudeCalls), false, 'a claude binary was invoked')
      assert.equal(existsSync(c.ghCalls), false, 'gh was invoked')
      const seenGit = gitCalls(c)
      assert.ok(seenGit.length > 0)
      for (const call of seenGit) assert.ok(['rev-parse', 'status'].includes(call.argv[0]), `git was run as: git ${call.argv.join(' ')}`)
    }
  })
})

// ===================================================================== catalog
describe('CP-05e catalog', () => {
  test('4. dev records the gate proof as proofRefs [cp-02f-host-wiring, cp-05e-qa-gate]; no other row carries it; dev codex stays unavailable; the drift guard passes', async () => {
    const catalog = readJson(resolve(ROOT, CATALOG))
    const dev = catalog.offerings.find(o => o.id === 'dev')
    assert.deepEqual(dev?.proofRefs, ['cp-02f-host-wiring', PROOF_REF])
    assert.deepEqual(catalog.offerings.filter(o => o.proofRefs?.includes(PROOF_REF)).map(o => o.id), ['dev'], 'only dev carries it')
    assert.equal(dev.providers.codex.implementation, 'unavailable')
    const { checkCatalogDrift } = await loadModule('core/skills/native-runtime/catalog.mjs')
    assert.deepEqual(checkCatalogDrift({ installationRoot: ROOT }), { ok: true, problems: [] })
  })
})
