// CP-04c frozen acceptance: the /blueprint stage CLI on the native runtime
// (spec/contracts/codex-parity-cp-04c.md). Wiring proof, not runtime certification:
// no real codex, no claude, no gh, no network, no HOME. The CLI under test runs as a
// child process; its stages go through the real CP-02e graph host and the real CP-02b
// provider around the frozen fake codex acceptance/codex-parity/cp-02f-fake-codex.cjs.
// The installation root is an owned fixture copied from the candidate tree with only
// blueprint's codex row flipped to partial (case 7 uses the candidate root itself).
//
// Every case owns a fixture git repository (its path holds a space) and a bin/ that is
// the whole PATH of the CLI and of every leaf: a `node` shim, a recording `git` wrapper
// that runs the real git, a `bash` link and recording `claude` and `gh` stubs. The leaf
// env is {PATH, FAKE_CODEX_DIR}; the CLI's own env also carries a marker that must never
// reach a leaf, an output or a state file.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = process.env.PANDASTACK_CANDIDATE_ROOT || resolve(import.meta.dirname, '..', '..')
const MODULE = 'graphs/blueprint/skills/blueprint/blueprint-native.mjs'
const MODULE_PATH = resolve(ROOT, MODULE)
const APPROVE_PATH = resolve(ROOT, 'graphs/blueprint/skills/blueprint/blueprint-approve.mjs')
const HOST_PATH = resolve(ROOT, 'core/skills/native-runtime/graph-host.mjs')
const FAKE_CODEX = fileURLToPath(new URL('./cp-02f-fake-codex.cjs', import.meta.url))
const CATALOG = 'spec/offering-capabilities.json'
const loadModule = rel => import(pathToFileURL(resolve(ROOT, rel)).href)
const sha = value => createHash('sha256').update(value).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
// CP-02e's canonical form (sorted keys), so an args hash is computed independently of the runtime.
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v)

const MARKER = `cp04c-host-marker-${process.pid}-${Date.now()}`
// Fake secrets, built at run time so no source line holds one.
const FAKE_KEY = ['sk', 'live', 'aZ0bY1cX2dW3eV4fU5gT6hS7'].join('_')
const FAKE_TOKEN = ['ghp', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'].join('_')
const KEY_LABEL = '<redacted: API key>'
const TOKEN_LABEL = '<redacted: GitHub token>'
const INVOCATION_ID = /^bp-(interview|design|backlog)-([0-9]{8}T[0-9]{6}Z)-[0-9a-f]{8}$/

// ---------------------------------------------------------------- fixture root
// Copies only what the host reads: the catalog, the workflow templates, every role file
// and every file directly in a skill directory. Regular files only (CP-02f's copy).
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
// The partial row CP-02e's and CP-02f's fixtures use. A fixture value, never a production row.
const PARTIAL = Object.freeze({ implementation: 'partial', transportId: 'codex-autobuild',
  limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] })
const ROLES = ['extractor', 'questioner', 'architect', 'slicer', 'advisor']

let WORK, REAL_GIT, REAL_BASH, FIXTURE_ROOT, PREFIXES, STATE_LIB, DECISIONS_LIB
// Built on first use, so a candidate without the v2 catalog or role loader fails each case on its own.
async function root() {
  if (FIXTURE_ROOT) return FIXTURE_ROOT
  const dir = realpathSync(mkdtempSync(join(WORK, 'root-')))
  copyTree(dir)
  const catalog = readJson(join(dir, CATALOG))
  const row = catalog.offerings.find(o => o.id === 'blueprint')
  assert.ok(row?.providers?.codex, 'the candidate catalog is v2 with provider rows (CP-01b)')
  row.providers.codex = structuredClone(PARTIAL)
  writeFileSync(join(dir, CATALOG), JSON.stringify(catalog, null, 2) + '\n')
  // Each role is identified by the instructions the host prepends to its prompt.
  const { assembleRoleInstructions } = await loadModule('core/skills/native-runtime/role-files.mjs')
  PREFIXES = ROLES.map(role => ({ role, prefix: assembleRoleInstructions({ installationRoot: dir, name: role }).instructions + '\n\n' }))
  FIXTURE_ROOT = dir
  return dir
}

before(async () => {
  WORK = realpathSync(mkdtempSync(join(tmpdir(), 'cp-04c-')))
  REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  assert.ok(REAL_GIT.startsWith('/') && !REAL_GIT.includes("'"), 'a usable real git')
  REAL_BASH = execFileSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim()
  assert.ok(REAL_BASH.startsWith('/'), 'a usable bash')
  STATE_LIB = await loadModule('graphs/blueprint/skills/blueprint/blueprint-state.mjs')
  DECISIONS_LIB = await loadModule('graphs/blueprint/skills/blueprint/blueprint-decisions.mjs')
})
after(() => { if (WORK) rmSync(WORK, { recursive: true, force: true }) })

// ---------------------------------------------------------------- scripted replies
const wire = value => ({ json: JSON.stringify(value) })
const REQUEST_TEXT = 'Build a reading list app where people track the books they want to read'
const BRIEF = {
  goal: 'Track books to read', mode: 'app', users: ['readers'],
  requirements: [{ id: 'R1', text: 'Add a book', source: 'request' }, { id: 'R2', text: 'List the books', source: 'request' }],
  decided: [], gaps: ['sign-in'], contradictions: [], constraints: [], existing_stack: 'none',
}
const QUESTION = (id, question, labels, over = {}) => ({
  id, question, stakes: `what ${id} costs to change later`,
  options: labels.map(label => ({ label, description: `about ${label}` })),
  recommended: labels[1], default_if_unasked: labels[1], resolves: [], ...over,
})
// recommended is the second option, so the workflow moves it first (recommendedFirst).
const Q1_LABELS = ['Magic link', 'Email and password']
const Q2_LABELS = ['Postgres', 'SQLite', 'Mongo']
const QUESTIONS = (over = {}) => ({
  questions: [QUESTION('Q1', 'How do people sign in?', Q1_LABELS), QUESTION('Q2', 'Which database?', Q2_LABELS)],
  preflight: [{ what: 'SMTP key', why: 'sends mail', needed_by: 'S3' }, { what: 'Domain name', why: 'serves the app', needed_by: 'S1' }],
  assumptions: [{ assumption: 'One person per list', why: 'stated' }, { assumption: 'English only', why: 'no i18n asked' }],
  ...over,
})
// Honors every decision and assumption the answers below leave: Q1, Q2, A1 (overridden), A2.
const DESIGN = {
  summary: 'A reading list.',
  modules: [
    { id: 'M1', name: 'books', responsibility: 'store books', requirements: ['R1'], boundary: false, shapes: [], pick: '', depth_reason: '' },
    { id: 'M2', name: 'reading', responsibility: 'read state', requirements: ['R2'], boundary: false, shapes: [], pick: '', depth_reason: '' },
  ],
  failure_modes: [{ id: 'F1', what: 'db down', module: 'M1', silent: false, tested: true, handled: true, plan: 'return 503' }],
  adrs: [{ id: 'ADR1', title: 'database', options: ['SQLite', 'Postgres'], decision: 'SQLite', reason: 'one user' }],
  departures: [],
  honors: ['Q1', 'Q2', 'A1', 'A2'].map(id => ({ id, how: `the design follows ${id}` })),
  conflicts: [],
  knowledge: [{ id: 'K1', knowledge: 'book shape', kind: 'type', owner: 'src/books/book.ts', used_by: ['M1', 'M2'], changes_together_because: 'one row shape' }],
  premises: [],
}
const AC = sid => [{ id: `${sid}-AC1`, criterion: `${sid} works`, fails_when: `${sid} output is wrong` }]
const SLICES = {
  app: 'reading-list',
  slices: [
    { id: 'S1', title: 'scaffold', goal: 'g1', requirements: [], acceptance: AC('S1'), depends_on: [] },
    { id: 'S2', title: 'books', goal: 'g2', requirements: ['R1'], acceptance: AC('S2'), depends_on: ['S1'] },
    { id: 'S3', title: 'reading', goal: 'g3', requirements: ['R2'], acceptance: AC('S3'), depends_on: ['S2'] },
  ],
  knowledge: [{ id: 'K1', built_in: 'S2', used_by: ['S2', 'S3'] }],
}
const APPROVE = { verdict: 'approve', issues: [], questions: [] }
const BLOCKED = question => ({ verdict: 'blocked', issues: [], questions: [question] })
const GATE_Q1 = 'Q1: Is a hosted sign-in really what you want?'
const GATE_NEW = 'new: Should there be an admin role?'
const HAPPY = Object.freeze({
  extractor: wire(BRIEF), questioner: wire(QUESTIONS()), architect: wire(DESIGN), slicer: wire(SLICES), advisor: wire(APPROVE),
})

// The interview answers every case that needs a state file gives.
const ANSWER_Q1 = 'Email and password'
const ANSWER_Q2 = 'Postgres, hosted'
const OVERRIDE_A1 = 'Two people share a list'
const INTERVIEW_ANSWERS = () => ({
  answers: [{ id: 'Q1', answer: ANSWER_Q1 }, { id: 'Q2', answer: ANSWER_Q2 }], have: ['SMTP key'],
  overrides: [{ id: 'A1', answer: OVERRIDE_A1 }],
})

// ---------------------------------------------------------------- case harness
let caseNo = 0
let runNo = 0
// One owned directory per case: a fixture repo whose path holds a space, a bin/ that is
// the whole PATH, and the fake codex outside PATH.
async function makeCase(replies = HAPPY) {
  await root()
  const dir = realpathSync(mkdtempSync(join(WORK, `case-${++caseNo}-`)))
  const c = { dir, repo: join(dir, 'my repo'), bin: join(dir, 'bin'), fake: join(dir, 'fake'), codex: join(dir, 'codex-bin', 'codex'),
    ghLog: join(dir, 'gh.log'), claudeLog: join(dir, 'claude.log'), runs: [] }
  for (const d of [c.repo, c.bin, c.fake, dirname(c.codex)]) mkdirSync(d, { recursive: true })
  c.repo = realpathSync(c.repo)
  c.stateDir = join(c.repo, '.git', 'harness-blueprint')
  c.nativeRuns = join(c.stateDir, 'native-runs')
  symlinkSync(process.execPath, join(c.bin, 'node'))
  symlinkSync(REAL_BASH, join(c.bin, 'bash'))
  writeFileSync(join(c.bin, 'git'), [
    '#!/bin/sh',
    'for a in "$@"; do printf \'%s\\037\' "$a" >> "$CP04C_GIT_LOG"; done',
    'printf \'\\036\' >> "$CP04C_GIT_LOG"',
    `exec '${REAL_GIT}' "$@"`, '',
  ].join('\n'), { mode: 0o755 })
  for (const [name, log] of [['gh', c.ghLog], ['claude', c.claudeLog]]) {
    writeFileSync(join(c.bin, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 1\n`, { mode: 0o755 })
  }
  cpSync(FAKE_CODEX, c.codex)
  chmodSync(c.codex, 0o755)
  setReplies(c, replies)
  initRepo(c)
  c.snap0 = snapshot(c.repo)
  return c
}
function setReplies(c, replies) {
  writeFileSync(join(c.fake, 'script.json'), JSON.stringify({ roles: PREFIXES, replies }))
}
const IDENTITY = { GIT_AUTHOR_NAME: 'CP Test', GIT_AUTHOR_EMAIL: 'cp-test@example.invalid', GIT_COMMITTER_NAME: 'CP Test', GIT_COMMITTER_EMAIL: 'cp-test@example.invalid' }
const GIT_ENV = () => ({ PATH: `${dirname(REAL_GIT)}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C', ...IDENTITY })
function git(repo, args) {
  return execFileSync(REAL_GIT, ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV(), stdio: ['ignore', 'pipe', 'pipe'] })
}
// A repo with one commit, an unstaged edit, a staged file and an untracked file, so "unchanged" means something.
function initRepo(c) {
  git(c.repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(c.repo, 'README.md'), '# app\n')
  mkdirSync(join(c.repo, 'sub', 'dir'), { recursive: true })
  writeFileSync(join(c.repo, 'sub', 'dir', 'file.txt'), 'one\n')
  git(c.repo, ['add', '-A'])
  git(c.repo, ['commit', '-q', '-m', 'init'])
  writeFileSync(join(c.repo, 'README.md'), '# app\nedited\n')
  writeFileSync(join(c.repo, 'staged.txt'), 'staged\n')
  git(c.repo, ['add', 'staged.txt'])
  writeFileSync(join(c.repo, 'untracked.txt'), 'untracked\n')
  // Fixture prerequisites: a failure here is a fixture bug, never a missing module.
  assert.equal(git(c.repo, ['rev-parse', '--show-toplevel']).trim(), c.repo, 'the fixture repo is its own top')
  assert.equal(STATE_LIB.resolveStateDir(c.repo), c.stateDir, 'the state directory is where the fixture expects it')
}
function walk(top, rel = '') {
  const out = {}
  for (const name of readdirSync(join(top, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name
    if (r === '.git') continue
    const st = lstatSync(join(top, r))
    if (st.isSymbolicLink()) out[r] = 'link'
    else if (st.isDirectory()) { out[`${r}/`] = 'dir'; Object.assign(out, walk(top, r)) }
    else out[r] = sha(readFileSync(join(top, r)))
  }
  return out
}
// HEAD, every ref, the index and the work tree bytes.
function snapshot(repo) {
  const head = spawnSync(REAL_GIT, ['-C', repo, 'symbolic-ref', '-q', 'HEAD'], { encoding: 'utf8', env: GIT_ENV() })
  return { head: head.status === 0 ? head.stdout : `detached ${git(repo, ['rev-parse', 'HEAD'])}`,
    refs: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']), index: git(repo, ['ls-files', '-s']), tree: walk(repo) }
}

// The leaf env is the args file's env, exactly. The CLI's own env has a marker that must never reach a leaf.
const leafEnv = c => ({ PATH: c.bin, FAKE_CODEX_DIR: c.fake })
const hostKeys = (c, over = {}) => ({ installationRoot: FIXTURE_ROOT, codexBin: c.codex, env: leafEnv(c), timeoutMs: 120000, ...over })
// The CLI runs with a non-UTC zone, so an invocation id stamped in local time is caught.
const cliEnv = (c, gitLog) => ({ PATH: c.bin, CP04C_HOST_ONLY: MARKER, CP04C_GIT_LOG: gitLog, GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C', TZ: 'Pacific/Kiritimati' })

function runNode(c, script, argv) {
  const id = ++runNo
  const gitLog = join(c.dir, `git-${id}.log`)
  return new Promise(done => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, [script, ...argv], { env: cliEnv(c, gitLog), stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => {
      const raw = existsSync(gitLog) ? readFileSync(gitLog, 'utf8') : ''
      const git = raw.split('\x1e').filter((rec, i, all) => i < all.length - 1).map(rec => rec.split('\x1f').slice(0, -1))
      const run = { code, stdout, stderr, git, argv, startedAt, endedAt: Date.now() }
      c.runs.push(run)
      done(run)
    })
  })
}
function writeArgs(c, text) {
  const path = join(c.dir, `args-${++runNo}.json`)
  writeFileSync(path, typeof text === 'string' ? text : JSON.stringify(text))
  return path
}
// The CLI as the contract states it: <verb> --args-file <absolute path>.
function invoke(c, verb, args) {
  assert.ok(existsSync(MODULE_PATH), `${MODULE} exists`)
  const path = writeArgs(c, args)
  const run = runNode(c, MODULE_PATH, [verb, '--args-file', path])
  return run.then(r => Object.assign(r, { argsPath: path, args }))
}
const invokeRaw = (c, argv) => {
  assert.ok(existsSync(MODULE_PATH), `${MODULE} exists`)
  return runNode(c, MODULE_PATH, argv)
}
// CP-04d's show on the same repo.
function show(c) {
  const path = writeArgs(c, { repo: c.repo })
  return runNode(c, APPROVE_PATH, ['show', '--args-file', path])
}


// The import and re-export statements of a module, by form: { names, specifier }, where names
// is the list of imported names for a `{ a, b as c }` form and null for any other form (a
// default, a namespace, a side-effect import), which the contract does not allow.
const IMPORT_STATEMENT = new RegExp([
  '^[ \\t]*(?:import|export)\\s*(\\{[^}]*\\}|\\*(?:\\s+as\\s+\\w+)?|\\w+(?:\\s*,\\s*\\{[^}]*\\})?)\\s*from\\s*([\'"])([^\'"\\n]+)\\2',
  '^[ \\t]*import\\s*([\'"])([^\'"\\n]+)\\4',
].join('|'), 'gm')
function importsOf(source) {
  return [...source.matchAll(IMPORT_STATEMENT)].map(m => {
    const named = m[1]?.startsWith('{') ? m[1].slice(1, -1).split(',').map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean) : null
    return { names: named, specifier: m[3] ?? m[5] }
  })
}
const ALLOWED_IMPORTS = {
  './blueprint-state.mjs': ['resolveStateDir', 'initState', 'readRequest', 'readState', 'writeRun', 'freshness', 'designArgs', 'backlogArgs',
    'readArgsFile', 'redactJSON', 'FILES'],
  './blueprint-decisions.mjs': ['applyInterviewAnswers', 'applyGateAnswers', 'applyApprovalEdit'],
  '../../../../core/skills/native-runtime/graph-host.mjs': ['runGraphHost'],
  '../../../../core/skills/native-runtime/codex-provider.mjs': ['createCodexProvider'],
}
// Runs fn over items, `limit` at a time.
async function parallel(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i], i)
  }))
  return results
}

// ---------------------------------------------------------------- output assertions
function assertError(r, error, exit, extra = {}) {
  assert.equal(r.stdout, '', 'stdout is empty on an error')
  assert.equal(r.stderr, JSON.stringify({ error, ...extra }) + '\n')
  assert.equal(r.code, exit)
}
function assertReport(r, report) {
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stderr, '')
  assert.equal(r.stdout, JSON.stringify(report) + '\n')
}
// A stage report: {status, file, invocationId, redacted}, one line, keys in that order.
// Returns the invocation id after checking its shape and its UTC stamp.
function assertStageReport(r, stage, status, file, redacted = false) {
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stderr, '')
  const report = JSON.parse(r.stdout)
  assert.deepEqual(Object.keys(report), ['status', 'file', 'invocationId', 'redacted'])
  const m = INVOCATION_ID.exec(report.invocationId)
  assert.ok(m, `invocationId ${report.invocationId} matches the contract's shape`)
  assert.equal(m[1], stage)
  const [, , stamp] = m
  const at = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15))
  assert.ok(at >= Math.floor(r.startedAt / 1000) * 1000 - 1000 && at <= r.endedAt + 1000, `the invocation id is stamped in UTC (${stamp})`)
  assert.equal(r.stdout, JSON.stringify({ status, file, invocationId: report.invocationId, redacted }) + '\n')
  return report.invocationId
}
// Nothing but stateDir (and the report's own fields) may carry a path, and none of `secrets` may appear.
function assertNoLeak(c, r, secrets = []) {
  const text = (r.stdout + r.stderr).split(c.stateDir).join('<stateDir>')
  for (const bad of [MARKER, c.dir, c.repo, FIXTURE_ROOT, c.codex, r.argsPath, ...secrets].filter(Boolean)) {
    assert.ok(!text.includes(bad), `the output does not carry ${bad.slice(0, 40)}`)
  }
}

// ---------------------------------------------------------------- spawns and checkpoints
const calls = c => lines(join(c.fake, 'calls.jsonl'))
function checkpointRows(runDir) {
  const dir = join(runDir, 'checkpoints')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => /^nr-[0-9a-f]{64}\.json$/.test(name)).map(name => readJson(join(dir, name)))
}
const runDirOf = (c, invocationId) => join(c.nativeRuns, invocationId)
const resultOf = (c, invocationId) => readJson(join(runDirOf(c, invocationId), 'result.json'))
// Every spawn of one stage invocation was a dispatched, returned checkpoint row of this
// workflow with the stage's exact args, and its codex output went under the invocation's run directory.
function assertStageRows(c, invocationId, roles, args) {
  const rows = checkpointRows(runDirOf(c, invocationId))
  assert.deepEqual(rows.map(row => row.binding.agentType).sort(), [...roles].sort(), 'one checkpoint row per spawn')
  for (const row of rows) {
    assert.equal(row.state, 'returned')
    assert.equal(row.binding.invocationId, invocationId)
    assert.equal(row.binding.workflowId, 'blueprint-design')
    assert.deepEqual(row.binding.workflowPath, ['blueprint-design'])
    assert.equal(row.binding.argsHash, sha(canonical(args)), `${row.binding.agentType}: the workflow args`)
  }
  const result = resultOf(c, invocationId)
  assert.deepEqual([result.schemaVersion, result.workflowId, result.offeringId, result.invocationId],
    [1, 'blueprint-design', 'blueprint', invocationId])
  return result
}
const assertRunFile = (c, file, expected) => assert.deepEqual(readJson(join(c.stateDir, file)), expected, `${file} is the stored ledger`)

// ---------------------------------------------------------------- case 8: every case
// HEAD, refs, index and work tree unchanged; the git wrapper saw only rev-parse; the gh
// and claude stubs recorded nothing; the env marker is in no output, state file or leaf
// environment; every spawn was read-only, in the repo top, with exactly the args file's env.
// A dangling symlink (a fixture) has no bytes to read.
function bytesOf(file) {
  try { return readFileSync(file) } catch { return Buffer.from('<unreadable>') }
}
function filesUnder(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])
}
function assertEveryCase(c) {
  assert.deepEqual(snapshot(c.repo), c.snap0, 'HEAD, refs, the index and the work tree are unchanged')
  for (const run of c.runs) {
    for (const call of run.git) {
      const sub = call[0] === '-C' ? call[2] : call[0]
      assert.equal(sub, 'rev-parse', `the git wrapper saw only rev-parse, not ${JSON.stringify(call)}`)
    }
    assert.ok(!(run.stdout + run.stderr).includes(MARKER), 'the env marker is in no output')
  }
  assert.equal(existsSync(c.ghLog), false, 'gh was never run')
  assert.equal(existsSync(c.claudeLog), false, 'claude was never run')
  for (const file of [...filesUnder(c.stateDir), ...filesUnder(c.fake)]) {
    assert.ok(!bytesOf(file).toString('utf8').includes(MARKER), `the env marker is not in ${file.slice(c.dir.length)}`)
  }
  for (const call of calls(c)) {
    assert.deepEqual(Object.keys(call.env).filter(k => k !== '__CF_USER_TEXT_ENCODING').sort(), ['FAKE_CODEX_DIR', 'PATH'], 'the leaf env is the args file\'s, exactly')
    assert.equal(call.env.PATH, c.bin)
    assert.equal(call.env.FAKE_CODEX_DIR, c.fake)
    assert.equal(call.cwd, c.repo, `${call.role} ran in the repo top`)
    assert.equal(call.sandbox, 'read-only', `${call.role} sandbox`)
    assert.ok(call.role !== null, 'every spawn was a known blueprint-design role')
  }
}
// The CLI's first git call for a run that got past the argument checks.
function assertFirstGit(r, repoArg) {
  assert.deepEqual(r.git[0], ['-C', repoArg, 'rev-parse', '--show-toplevel'], 'the repo check is the first git call')
}
// What the state directory holds, for "no run file written" checks.
function stateListing(c) {
  const out = {}
  for (const file of filesUnder(c.stateDir)) out[file.slice(c.stateDir.length + 1)] = sha(bytesOf(file))
  return out
}
// A refusal before the host creates nothing at all (strict); one the host makes (case 7) may leave the empty native-runs.
const noNativeRuns = (c, strict = true) => strict ? assert.equal(existsSync(c.nativeRuns), false, 'nothing was created under native-runs')
  : assert.ok(!existsSync(c.nativeRuns) || readdirSync(c.nativeRuns).length === 0, 'no run directory was created')
const noSpawns = c => assert.equal(existsSync(join(c.fake, 'calls.jsonl')), false, 'zero spawns')

// ---------------------------------------------------------------- seeds (CP-04a's own writers)
const DECISION = (id, answer, over = {}) => ({ id, question: `question for ${id}`, answer, resolves: [], note: null, ...over })
const STATE = (over = {}) => ({
  request: REQUEST_TEXT, docs: [],
  brief: { goal: 'track books', mode: 'app', requirements: [{ id: 'R1', text: 'add', source: 'request' }, { id: 'R2', text: 'list', source: 'request' }] },
  decisions: [DECISION('Q1', ANSWER_Q1), DECISION('Q2', ANSWER_Q2), DECISION('A1', OVERRIDE_A1, { note: 'override' })],
  assumptions: [{ id: 'A2', assumption: 'English only', why: 'no i18n asked' }],
  preflight: [{ what: 'SMTP key', why: 'sends mail', needed_by: 'S3', have: true }, { what: 'Domain name', why: 'serves the app', needed_by: 'S1', have: false }],
  gateRounds: 0, ...over,
})
const RUN1 = (over = {}) => ({
  status: 'needs-human', reason: 'seeded', brief: STATE().brief,
  questions: [QUESTION('Q1', 'How do people sign in?', Q1_LABELS), QUESTION('Q2', 'Which database?', Q2_LABELS)],
  preflight: [], assumptions: [], history: [], ...over,
})
const RUN2_READY = { status: 'design-ready', reason: 'seeded', design: { summary: 's', knowledge: [{ id: 'K1' }] } }
const RUN2_NEEDS = { status: 'needs-human', reason: 'seeded', design: { summary: 's' }, questions: [{ about: 'Q1', question: 'again?' }] }
// request.json, then state.json and the runs asked for, through CP-04a (so meta.json holds real bases).
function seed(c, { request = REQUEST_TEXT, docs, state, run1, run2 } = {}) {
  STATE_LIB.initState(c.stateDir, { request, ...(docs ? { docs } : {}) })
  if (run1) STATE_LIB.writeRun(c.stateDir, 1, run1)
  if (state) STATE_LIB.writeState(c.stateDir, state)
  if (run2) STATE_LIB.writeRun(c.stateDir, 2, run2)
}


// The keys each verb's args file may hold (the contract's CLI table), and the args files the
// CLI must refuse as INVALID_ARGS before any git call. `file` marks the ones CP-04a's
// readArgsFile itself refuses (not a plain object of allowed keys); the rest break a key rule.
const VERB_KEYS = {
  start: ['repo', 'request', 'docs', 'restart'], interview: ['repo', 'installationRoot', 'codexBin', 'env', 'timeoutMs'],
  answer: ['repo', 'answers', 'have', 'overrides'], design: ['repo', 'installationRoot', 'codexBin', 'env', 'timeoutMs'],
  gate: ['repo', 'answers'], backlog: ['repo', 'installationRoot', 'codexBin', 'env', 'timeoutMs'], edit: ['repo', 'edit'],
}
function argsMatrix(c) {
  const ok = { start: { repo: c.repo, request: 'x' }, interview: stageArgs(c), answer: { repo: c.repo, answers: [{ id: 'Q1', answer: 'x' }] },
    gate: { repo: c.repo, answers: [{ id: 'G1', answer: 'x' }] }, edit: { repo: c.repo, edit: 'x' } }
  ok.design = ok.backlog = ok.interview
  const out = []
  const add = (verb, value, file) => out.push({ verb, value, file })
  for (const text of ['', 'not json', '[]', 'null', '5', '"s"', '{"repo":', '[{"repo":"/x"}]']) add('interview', text, true)
  const only = (verb, key) => Object.fromEntries(Object.entries(ok[verb]).filter(([k]) => k !== key))
  const withKeys = (verb, patch) => ({ ...ok[verb], ...patch })
  for (const verb of ['interview', 'design', 'backlog']) {
    for (const key of VERB_KEYS[verb]) add(verb, only(verb, key), false)
    for (const extra of [{ request: 'x' }, { answers: [] }, { extra: 1 }, { maxConcurrentSubagents: 1 }, { docs: [] }]) add(verb, withKeys(verb, extra), true)
  }
  add('start', only('start', 'repo'), false)
  for (const extra of [{ installationRoot: FIXTURE_ROOT }, { answers: [] }, { env: {} }]) add('start', withKeys('start', extra), true)
  add('answer', only('answer', 'repo'), false)
  add('answer', only('answer', 'answers'), false)
  for (const extra of [{ request: 'x' }, { edit: 'x' }, { timeoutMs: 5000 }]) add('answer', withKeys('answer', extra), true)
  add('gate', only('gate', 'answers'), false)
  for (const extra of [{ have: [] }, { overrides: [] }]) add('gate', withKeys('gate', extra), true)
  add('edit', only('edit', 'edit'), false)
  for (const extra of [{ answers: [] }, { repo2: '/x' }]) add('edit', withKeys('edit', extra), true)
  // Values: repo, the host paths, env and timeoutMs.
  for (const repo of ['relative/repo', '', 5, null, ['/abs'], '/tmp/bad\u0001path', '/tmp/bad\u007fpath', '/tmp/bad\u009fpath', '/' + 'a'.repeat(4096)]) {
    for (const verb of ['interview', 'start', 'answer', 'edit']) add(verb, withKeys(verb, { repo }), false)
  }
  for (const key of ['installationRoot', 'codexBin']) {
    for (const value of ['relative/path', '', 5, null, '/tmp/bad\u0000path', '/tmp/bad\npath']) add('design', withKeys('design', { [key]: value }), false)
  }
  for (const env of ['PATH=/bin', null, 5, [], [['PATH', '/bin']], { PATH: 5 }, { PATH: null }, { PATH: '/bin', N: ['x'] }, { PATH: '/bin', N: {} }]) {
    add('backlog', withKeys('backlog', { env }), false)
  }
  for (const timeoutMs of [0, 1000, 1000.5, -1, 86400001, '5000', null, true, [5000], 1e21]) add('interview', withKeys('interview', { timeoutMs }), false)
  return out
}

// ---------------------------------------------------------------- the stages, as the session drives them
const stageArgs = (c, over = {}) => ({ repo: c.repo, ...hostKeys(c), ...over })
const designArgsFor = c => ({ ...STATE_LIB.designArgs(c.stateDir), repo: c.repo, stage: 'design', statePath: join(c.stateDir, 'state.json') })
const backlogArgsFor = c => ({ ...STATE_LIB.backlogArgs(c.stateDir), repo: c.repo, stage: 'backlog',
  statePath: join(c.stateDir, 'state.json'), designPath: join(c.stateDir, 'run2.json') })

// =====================================================================
// Fixture prerequisites. The real host CLI (CP-02e) and the real CP-04a/CP-04b modules
// (all already built) are driven by the test itself, on the same fixture root, fake and
// scripted replies the cases use, so a fixture bug is distinguishable from the missing
// blueprint-native.mjs. These pass today. They also pin the expectations the cases rely
// on: what each scripted stage returns, that CP-04a stores it unredacted, and that
// CP-04b and CP-04d accept the resulting files.
describe('fixture prerequisites (the host, the fake and CP-04a/b/d run the scripted stages)', () => {
  let stampNo = 0
  // One host stage the way the CLI is contracted to run it: a new run directory under native-runs.
  async function hostStage(c, stage, args, replies = HAPPY, installationRoot = FIXTURE_ROOT) {
    setReplies(c, replies)
    const invocationId = `bp-${stage}-20260101T0000${String(++stampNo).padStart(2, '0')}Z-0000000${stampNo % 10}`
    assert.match(invocationId, INVOCATION_ID)
    const file = writeArgs(c, { schemaVersion: 1, installationRoot, workflowId: 'blueprint-design', offeringId: 'blueprint',
      invocationId, args, runDir: runDirOf(c, invocationId), codexBin: c.codex, cwd: c.repo, env: leafEnv(c), timeoutMs: 60000,
      maxConcurrentSubagents: 1 })
    return new Promise(done => {
      const child = spawn(process.execPath, [HOST_PATH, '--args-file', file], { env: cliEnv(c, join(c.dir, 'host-git.log')), stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', d => { stdout += d })
      child.stderr.on('data', d => { stderr += d })
      child.on('close', code => done({ code, stdout, stderr, invocationId }))
    })
  }
  const status = value => JSON.stringify({ status: value }) + '\n'
  // The ledger the host returned, stored through CP-04a: it must come back unchanged (redacted: false).
  function store(c, id, n, expectedStatus) {
    const ledger = resultOf(c, id).result
    assert.equal(ledger.status, expectedStatus)
    assert.deepEqual(STATE_LIB.writeRun(c.stateDir, n, ledger), ledger, `CP-04a stores run${n} unredacted`)
    assert.deepEqual(readJson(join(c.stateDir, `run${n}.json`)), ledger)
    return ledger
  }

  test('the fixture root flips only blueprint\'s codex row, and every blueprint role has instructions', async () => {
    const dir = await root()
    const production = readJson(resolve(ROOT, CATALOG))
    const flipped = readJson(join(dir, CATALOG))
    assert.deepEqual(flipped.offerings.find(o => o.id === 'blueprint').providers.codex, PARTIAL)
    flipped.offerings.find(o => o.id === 'blueprint').providers.codex = production.offerings.find(o => o.id === 'blueprint').providers.codex
    assert.deepEqual(flipped, production)
    assert.deepEqual(PREFIXES.map(p => p.role), ROLES)
    for (const p of PREFIXES) assert.ok(p.prefix.length > 2, `${p.role} has role instructions`)
  })

  test('interview, answer, design and backlog: every scripted stage reaches its status, and CP-04a, CP-04b and CP-04d accept the files', async () => {
    const c = await makeCase()
    const doc = join(c.dir, 'design doc.md')
    writeFileSync(doc, '# doc\n')
    STATE_LIB.initState(c.stateDir, { request: REQUEST_TEXT, docs: [doc] })

    const interviewArgs = { repo: c.repo, request: REQUEST_TEXT, docs: [doc] }
    let r = await hostStage(c, 'interview', interviewArgs)
    assert.equal(r.stdout, status('needs-human'), r.stderr)
    assert.deepEqual(calls(c).map(call => call.role), ['extractor', 'questioner'])
    assertStageRows(c, r.invocationId, ['extractor', 'questioner'], interviewArgs)
    const run1 = store(c, r.invocationId, 1, 'needs-human')
    assert.deepEqual(run1.questions.map(q => q.id), ['Q1', 'Q2'])
    assert.deepEqual(run1.assumptions.map(a => a.id), ['A1', 'A2'])

    const answered = DECISIONS_LIB.applyInterviewAnswers(c.stateDir, INTERVIEW_ANSWERS())
    assert.deepEqual([answered.decisions.length, answered.assumptions.length, answered.preflight.filter(p => p.have === false).length], [3, 1, 1])
    assert.deepEqual(answered.decisions.map(d => [d.id, d.answer, d.note]), [['Q1', ANSWER_Q1, null], ['Q2', ANSWER_Q2, null], ['A1', OVERRIDE_A1, 'override']])
    assert.deepEqual(STATE_LIB.designArgs(c.stateDir), { mode: 'app', requirements: ['R1', 'R2'],
      decisions: [{ id: 'Q1', answer: ANSWER_Q1 }, { id: 'Q2', answer: ANSWER_Q2 }, { id: 'A1', answer: OVERRIDE_A1 }], assumptions: ['A2'] })

    const design = designArgsFor(c)
    r = await hostStage(c, 'design', design)
    assert.equal(r.stdout, status('design-ready'), r.stderr)
    assertStageRows(c, r.invocationId, ['architect', 'advisor'], design)
    store(c, r.invocationId, 2, 'design-ready')

    const backlog = backlogArgsFor(c)
    assert.deepEqual(backlog.knowledge, ['K1'])
    assert.equal(STATE_LIB.freshness(c.stateDir).design, 'fresh')
    r = await hostStage(c, 'backlog', backlog)
    assert.equal(r.stdout, status('backlog-ready'), r.stderr)
    assertStageRows(c, r.invocationId, ['slicer', 'advisor'], backlog)
    const run3 = store(c, r.invocationId, 3, 'backlog-ready')
    assert.deepEqual(run3.owners, SLICES.knowledge)
    assert.deepEqual(STATE_LIB.freshness(c.stateDir), { design: 'fresh', backlog: 'fresh' })

    const shown = await show(c)
    assert.equal(shown.code, 0, shown.stderr)
    assert.ok(shown.stdout.startsWith('Blueprint approval: reading-list\nBranch: integration/reading-list\n'), shown.stdout.slice(0, 120))
  })

  test('gates: a blocking advisor reaches needs-human, CP-04b applies two gate answers and then refuses a third', async () => {
    const c = await makeCase({ ...HAPPY, advisor: [wire(BLOCKED(GATE_Q1)), wire(BLOCKED(GATE_NEW))] })
    seed(c, { state: STATE() })
    const advisors = [wire(BLOCKED(GATE_Q1)), wire(BLOCKED(GATE_NEW))]
    let design = designArgsFor(c)
    let r = await hostStage(c, 'design', design, { ...HAPPY, advisor: advisors[0] })
    assert.equal(r.stdout, status('needs-human'), r.stderr)
    assertStageRows(c, r.invocationId, ['architect', 'advisor'], design)
    const run2 = store(c, r.invocationId, 2, 'needs-human')
    assert.deepEqual(run2.questions, [{ about: 'Q1', question: 'Is a hosted sign-in really what you want?' }])
    assert.deepEqual(Object.keys(readJson(join(c.stateDir, 'meta.json')).basis), ['run2.json'])
    let state = DECISIONS_LIB.applyGateAnswers(c.stateDir, { answers: [{ id: 'G1', answer: 'Keep email and password' }] })
    assert.equal(state.gateRounds, 1)
    assert.deepEqual([existsSync(join(c.stateDir, 'run2.json')), existsSync(join(c.stateDir, 'meta.json'))], [false, false])
    assert.deepEqual(state.decisions.find(d => d.id === 'Q1'), { ...DECISION('Q1', 'Keep email and password'), note: 'design gate' })

    design = designArgsFor(c)
    r = await hostStage(c, 'design', design, { ...HAPPY, advisor: advisors[1] })
    assert.equal(r.stdout, status('needs-human'), r.stderr)
    assert.deepEqual(store(c, r.invocationId, 2, 'needs-human').questions, [{ about: null, question: 'Should there be an admin role?' }])
    state = DECISIONS_LIB.applyGateAnswers(c.stateDir, { answers: [{ id: 'G1', answer: 'No admin' }] })
    assert.equal(state.gateRounds, 2)
    assert.deepEqual(state.decisions.find(d => d.id === 'D1'), { id: 'D1', question: 'Should there be an admin role?', answer: 'No admin', resolves: [], note: 'design gate' })
    assert.throws(() => DECISIONS_LIB.applyGateAnswers(c.stateDir, { answers: [{ id: 'G1', answer: 'One more' }] }), { code: 'GATE_ROUNDS_EXHAUSTED' })
  })

  test('a refused architect is one failed row and an escalate ledger CP-04a stores unredacted', async () => {
    const c = await makeCase()
    seed(c, { state: STATE() })
    const design = designArgsFor(c)
    const r = await hostStage(c, 'design', design, { ...HAPPY, architect: { refuse: true } })
    assert.equal(r.stdout, status('escalate'), r.stderr)
    assert.deepEqual(calls(c).map(call => call.role), ['architect'])
    const rows = checkpointRows(runDirOf(c, r.invocationId))
    assert.deepEqual(rows.map(row => [row.binding.agentType, row.state, row.completion.outcome, row.completion.code]), [['architect', 'failed', 'failed', 'PROVIDER_REFUSAL']])
    assert.equal(rows[0].binding.argsHash, sha(canonical(design)))
    const ledger = store(c, r.invocationId, 2, 'escalate')
    assert.equal(ledger.design, null)
    assert.ok(typeof ledger.reason === 'string' && ledger.reason.length > 0)
  })

  test('the args matrix: CP-04a\'s readArgsFile refuses exactly the file-level entries, and the CLI\'s key rules are what refuse the rest', async () => {
    const c = await makeCase()
    const matrix = argsMatrix(c)
    assert.ok(matrix.some(e => e.file) && matrix.some(e => !e.file))
    for (const { verb, value, file } of matrix) {
      const path = writeArgs(c, value)
      const label = `${verb} ${JSON.stringify(value).slice(0, 80)}`
      if (file) assert.throws(() => STATE_LIB.readArgsFile(path, VERB_KEYS[verb]), { code: 'INVALID_ARGS' }, label)
      else assert.doesNotThrow(() => STATE_LIB.readArgsFile(path, VERB_KEYS[verb]), label)
    }
    // A byte order mark is accepted by readArgsFile, so the matrix must not list it as a refusal.
    const bom = join(c.dir, 'bom.json')
    writeFileSync(bom, '﻿' + JSON.stringify({ repo: c.repo }))
    assert.deepEqual(STATE_LIB.readArgsFile(bom, ['repo']), { repo: c.repo })
    for (const path of ['relative/args.json', join(c.dir, 'no-such-args.json'), c.dir]) {
      assert.throws(() => STATE_LIB.readArgsFile(path, ['repo']), { code: 'INVALID_ARGS' }, path)
    }
  })

  test('CP-04a and CP-04b refuse what the case 4 refusals pass through, with the codes and ids the cases pin', async () => {
    const c = await makeCase()
    seed(c, { run1: RUN1() })
    const a = id => ({ id, answer: id === 'Q1' ? ANSWER_Q1 : ANSWER_Q2 })
    const apply = opts => () => DECISIONS_LIB.applyInterviewAnswers(c.stateDir, opts)
    assert.throws(apply({ answers: [a('Q1'), a('Q2'), { id: 'Q9', answer: 'x' }] }), { code: 'UNKNOWN_ID', ids: ['Q9'] })
    assert.throws(apply({ answers: [a('Q1'), a('Q1'), a('Q2')] }), { code: 'DUPLICATE_ID', ids: ['Q1'] })
    assert.throws(apply({ answers: [a('Q1')] }), { code: 'MISSING_ANSWER', ids: ['Q2'] })
    assert.throws(apply({ answers: [a('Q1'), a('Q2')], have: ['not a preflight item'] }), { code: 'BAD_PREFLIGHT' })
    assert.throws(apply({ answers: 'Q1' }), { code: 'INVALID_INPUT' })
    assert.equal(existsSync(join(c.stateDir, 'state.json')), false, 'a refused answer writes nothing')
    assert.throws(() => STATE_LIB.initState(c.stateDir, { request: 5 }), { code: 'INVALID_INPUT' })
    assert.throws(() => STATE_LIB.initState(c.stateDir, { docs: ['relative.md'] }), { code: 'DOC_INVALID' })
    assert.throws(() => STATE_LIB.initState(c.stateDir, { docs: [join(c.dir, 'no-such-doc.md')] }), { code: 'DOC_MISSING' })
    assert.deepEqual(STATE_LIB.readRequest(c.stateDir), { request: REQUEST_TEXT, docs: [] }, 'a refused start keeps the earlier request')

    const d = await makeCase()
    assert.throws(() => STATE_LIB.initState(d.stateDir, {}), { code: 'NO_REQUEST' })
    assert.equal(existsSync(d.stateDir), false, 'NO_REQUEST creates no state directory')
    assert.throws(() => STATE_LIB.designArgs(d.stateDir), { code: 'MISSING' })
    seed(d)
    assert.throws(() => STATE_LIB.designArgs(d.stateDir), { code: 'MISSING' })
    seed(d, { state: STATE(), run2: RUN2_NEEDS })
    assert.throws(() => STATE_LIB.backlogArgs(d.stateDir), { code: 'NOT_DESIGN_READY' })
    // A state.json that is a dangling symlink is "present" to lstat.
    const e = await makeCase()
    mkdirSync(e.stateDir, { mode: 0o700 })
    symlinkSync(join(e.dir, 'nowhere.json'), join(e.stateDir, 'state.json'))
    assert.equal(lstatSync(join(e.stateDir, 'state.json')).isSymbolicLink(), true)
    assert.deepEqual(stateListing(e), { 'state.json': sha(Buffer.from('<unreadable>')) })
  })

  test('redaction: a token-shaped request and a key-shaped questioner output are stored with their labels, and the leaky ledger still answers', async () => {
    const c = await makeCase()
    const request = `Deploy with token ${FAKE_TOKEN} to the reading list host`
    const stored = STATE_LIB.initState(c.stateDir, { request })
    assert.equal(stored.request, `Deploy with token ${TOKEN_LABEL} to the reading list host`)
    assert.notEqual(stored.request, request.trim())
    const leaky = QUESTIONS({ questions: [
      QUESTION('Q1', 'How do people sign in?', Q1_LABELS, { stakes: `Costs a lot; the old key was ${FAKE_KEY}` }),
      QUESTION('Q2', 'Which database?', Q2_LABELS)] })
    const r = await hostStage(c, 'interview', { repo: c.repo, request: stored.request, docs: [] }, { ...HAPPY, questioner: wire(leaky) })
    assert.equal(r.stdout, status('needs-human'), r.stderr)
    const raw = resultOf(c, r.invocationId).result
    assert.ok(JSON.stringify(raw).includes(FAKE_KEY), 'the key is in the workflow\'s own result')
    const run1 = STATE_LIB.writeRun(c.stateDir, 1, raw)
    assert.notEqual(JSON.stringify(run1), JSON.stringify(raw), 'redacted is true')
    assert.equal(run1.questions[0].stakes, `Costs a lot; the old key was ${KEY_LABEL}`)
    assert.ok(!readFileSync(join(c.stateDir, 'run1.json'), 'utf8').includes(FAKE_KEY))
    raw.questions[0].stakes = run1.questions[0].stakes
    assert.deepEqual(run1, raw, 'only the secret changed')
    // answer: the free-text key is redacted in state.json, and the verb's own keys differ once redacted.
    const answers = { answers: [{ id: 'Q1', answer: `Use ${FAKE_KEY} for it` }, { id: 'Q2', answer: ANSWER_Q2 }] }
    assert.notEqual(JSON.stringify(STATE_LIB.redactJSON(answers)), JSON.stringify(answers))
    assert.equal(JSON.stringify(STATE_LIB.redactJSON(INTERVIEW_ANSWERS())), JSON.stringify(INTERVIEW_ANSWERS()))
    const state = DECISIONS_LIB.applyInterviewAnswers(c.stateDir, answers)
    assert.deepEqual([state.decisions.length, state.assumptions.length, state.preflight.filter(p => p.have === false).length], [2, 2, 2])
    assert.equal(state.decisions[0].answer, `Use ${KEY_LABEL} for it`)
    assert.ok(!readFileSync(join(c.stateDir, 'state.json'), 'utf8').includes(FAKE_KEY))
  })

  test('the harness: the import parser, the report and error checks, the UTC stamp check and the every-case checks work on a real CLI', async () => {
    const sample = [
      "import { realpathSync, lstatSync } from 'node:fs'",
      "import { spawnSync } from 'node:child_process'",
      'import {', '  resolveStateDir, initState as init,', '  FILES,', "} from './blueprint-state.mjs'",
      "import { runGraphHost } from '../../../../core/skills/native-runtime/graph-host.mjs'",
      "// import { evil } from './evil.mjs'", "const x = Buffer.from('abc')",
    ].join('\n')
    assert.deepEqual(importsOf(sample), [
      { names: ['realpathSync', 'lstatSync'], specifier: 'node:fs' }, { names: ['spawnSync'], specifier: 'node:child_process' },
      { names: ['resolveStateDir', 'initState', 'FILES'], specifier: './blueprint-state.mjs' },
      { names: ['runGraphHost'], specifier: '../../../../core/skills/native-runtime/graph-host.mjs' }])
    assert.deepEqual(importsOf("import * as fs from './blueprint-state.mjs'\nimport x from './y.mjs'\nimport './z.mjs'\nexport { a } from './w.mjs'").map(i => [i.names, i.specifier]),
      [[null, './blueprint-state.mjs'], [null, './y.mjs'], [null, './z.mjs'], [['a'], './w.mjs']])

    const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    const fake = at => ({ code: 0, stderr: '', startedAt: Date.now(), endedAt: Date.now(),
      stdout: JSON.stringify({ status: 'done', file: 'run2.json', invocationId: `bp-design-${stamp(at)}-0a1b2c3d`, redacted: false }) + '\n' })
    const now = fake(new Date())
    assert.equal(assertStageReport(now, 'design', 'done', 'run2.json'), JSON.parse(now.stdout).invocationId)
    assert.throws(() => assertStageReport(fake(new Date(Date.now() + 14 * 3600 * 1000)), 'design', 'done', 'run2.json'))
    assert.throws(() => assertStageReport(fake(new Date()), 'backlog', 'done', 'run2.json'))

    // The real CP-04d CLI through the same runNode: a refusal and a first git call of the contracted shape.
    const c = await makeCase()
    const r = await show(c)
    assertError(r, 'MISSING', 2)
    assertFirstGit(r, c.repo)
    assertNoLeak(c, r, [REQUEST_TEXT])
    assert.throws(() => assertError(r, 'STALE', 2))
    assert.throws(() => assertFirstGit(r, c.dir))
    assert.ok(r.git.every(call => call[0] === '-C' && call[2] === 'rev-parse'))
    assertEveryCase(c)
    // A write to the work tree, a stray git subcommand and a marker in a state file are each caught.
    writeFileSync(join(c.repo, 'untracked.txt'), 'changed\n')
    assert.throws(() => assertEveryCase(c), /work tree/)
    writeFileSync(join(c.repo, 'untracked.txt'), 'untracked\n')
    c.runs.push({ stdout: '', stderr: '', git: [['-C', c.repo, 'status']] })
    assert.throws(() => assertEveryCase(c), /only rev-parse/)
    c.runs.pop()
    mkdirSync(c.stateDir, { recursive: true })
    writeFileSync(join(c.stateDir, 'run1.json'), MARKER)
    assert.throws(() => assertEveryCase(c), /marker/)
  })

  test('the production catalog makes the host refuse OFFERING_UNSUPPORTED before any run directory exists', async () => {
    const c = await makeCase()
    seed(c, { state: STATE() })
    const r = await hostStage(c, 'design', designArgsFor(c), HAPPY, ROOT)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, JSON.stringify({ error: 'OFFERING_UNSUPPORTED' }) + '\n')
    assert.equal(r.code, 2)
    assert.equal(existsSync(runDirOf(c, r.invocationId)), false)
    noSpawns(c)
  })
})

// =====================================================================
describe('1. catalog and imports', () => {
  test('blueprint declares the native-runtime edge, the drift guard is clean, and the codex row is still unavailable', async () => {
    const catalog = readJson(resolve(ROOT, CATALOG))
    const blueprint = catalog.offerings.find(o => o.id === 'blueprint')
    assert.deepEqual(blueprint.dependencies, ['backlog', 'default-stack', 'knowledge-map', 'native-runtime'])
    const { checkCatalogDrift } = await loadModule('core/skills/native-runtime/catalog.mjs')
    assert.deepEqual(checkCatalogDrift({ installationRoot: ROOT }), { ok: true, problems: [] })
    assert.equal(blueprint.providers.codex.implementation, 'unavailable')
  })

  test('blueprint-native.mjs imports node: built-ins and the pinned names only, statically, with no dynamic import()', () => {
    assert.ok(existsSync(MODULE_PATH), `${MODULE} exists`)
    const source = readFileSync(MODULE_PATH, 'utf8')
    const imports = importsOf(source)
    const seen = new Map()
    for (const { names, specifier } of imports) {
      if (specifier.startsWith('node:')) continue
      assert.ok(Object.hasOwn(ALLOWED_IMPORTS, specifier), `${specifier} is not an allowed import`)
      assert.ok(Array.isArray(names) && names.length > 0 && names.every(name => ALLOWED_IMPORTS[specifier].includes(name)),
        `${specifier} imports only ${ALLOWED_IMPORTS[specifier].join(', ')} as named imports: got ${JSON.stringify(names)}`)
      seen.set(specifier, names)
    }
    assert.ok(seen.get('../../../../core/skills/native-runtime/graph-host.mjs')?.includes('runGraphHost'), 'runGraphHost comes from the graph host')
    assert.ok(seen.get('../../../../core/skills/native-runtime/codex-provider.mjs')?.includes('createCodexProvider'), 'createCodexProvider comes from the provider')
    // Each specifier resolves to the candidate's own file.
    for (const specifier of seen.keys()) assert.ok(existsSync(resolve(dirname(MODULE_PATH), specifier)), `${specifier} resolves`)
    assert.ok(!/\bimport\s*\(/.test(source), 'no dynamic import()')
  })

  test('importing blueprint-native.mjs has no effect; running it through a symlink is the CLI (realpath of argv[1])', async () => {
    assert.ok(existsSync(MODULE_PATH), `${MODULE} exists`)
    const dir = realpathSync(mkdtempSync(join(WORK, 'import-')))
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(MODULE_PATH).href)})`],
      { encoding: 'utf8', env: { PATH: dir, TZ: 'UTC' }, cwd: dir })
    assert.deepEqual([imported.status, imported.stdout, imported.stderr], [0, '', ''], 'an import prints nothing and exits 0')
    const link = join(dir, 'link.mjs')
    symlinkSync(MODULE_PATH, link)
    const ran = spawnSync(process.execPath, [link, 'bogus'], { encoding: 'utf8', env: { PATH: dir }, cwd: dir })
    assert.deepEqual([ran.status, ran.stdout, ran.stderr], [1, '', JSON.stringify({ error: 'INVALID_ARGS' }) + '\n'], 'a symlink to the module runs as the CLI')
  })
})

// =====================================================================
describe('2. the whole path', () => {
  test('start, interview, answer, design, backlog each exit 0 with the exact report; the runs are fresh and complete for show', async () => {
    const c = await makeCase()
    const doc = join(c.dir, 'design doc.md')
    writeFileSync(doc, '# design doc\n')
    const secrets = [REQUEST_TEXT, ANSWER_Q1, ANSWER_Q2, OVERRIDE_A1, 'Track books to read', 'sends mail', doc, c.fake]

    // start: the request is trimmed, so nothing was redacted.
    let r = await invoke(c, 'start', { repo: c.repo, request: `  ${REQUEST_TEXT}\n`, docs: [doc] })
    assertReport(r, { stateDir: c.stateDir, redacted: false })
    assertFirstGit(r, c.repo)
    assertNoLeak(c, r, secrets)
    assert.deepEqual(STATE_LIB.readRequest(c.stateDir), { request: REQUEST_TEXT, docs: [doc] })
    assert.equal(statSync(c.stateDir).mode & 0o777, 0o700)

    // interview: extractor, questioner; needs-human; run1.json.
    r = await invoke(c, 'interview', stageArgs(c))
    assertFirstGit(r, c.repo)
    const inv1 = assertStageReport(r, 'interview', 'needs-human', 'run1.json')
    assertNoLeak(c, r, secrets)
    assert.deepEqual(calls(c).map(call => call.role), ['extractor', 'questioner'])
    const result1 = assertStageRows(c, inv1, ['extractor', 'questioner'], { repo: c.repo, request: REQUEST_TEXT, docs: [doc] })
    assert.equal(result1.status, 'needs-human')
    assertRunFile(c, 'run1.json', result1.result)
    assert.deepEqual(readJson(join(c.stateDir, 'run1.json')).questions.map(q => [q.id, q.options[0].label]), [['Q1', 'Email and password'], ['Q2', 'SQLite']])
    assert.equal(statSync(c.nativeRuns).mode & 0o777, 0o700, 'native-runs is 0700')
    assert.deepEqual(readdirSync(c.nativeRuns), [inv1])
    assert.equal(existsSync(join(c.stateDir, 'state.json')), false)

    // answer: Q1, Q2 asked; A1 overridden; one preflight item had.
    r = await invoke(c, 'answer', { repo: c.repo, ...INTERVIEW_ANSWERS() })
    assertReport(r, { decisions: 3, assumptions: 1, owed: 1, redacted: false })
    assertFirstGit(r, c.repo)
    assertNoLeak(c, r, secrets)
    const state = STATE_LIB.readState(c.stateDir)
    assert.deepEqual(state.decisions.map(d => [d.id, d.answer, d.note]), [['Q1', ANSWER_Q1, null], ['Q2', ANSWER_Q2, null], ['A1', OVERRIDE_A1, 'override']])
    assert.deepEqual(state.assumptions.map(a => a.id), ['A2'])
    assert.deepEqual(state.preflight.map(p => [p.what, p.have]), [['SMTP key', true], ['Domain name', false]])
    assert.equal(state.gateRounds, 0)
    assert.equal(existsSync(join(c.stateDir, 'run1.json')), true, 'answer keeps run1.json')

    // design: architect, advisor approve; design-ready; run2.json and its meta basis.
    const design = designArgsFor(c)
    assert.deepEqual(STATE_LIB.designArgs(c.stateDir), { mode: 'app', requirements: ['R1', 'R2'],
      decisions: [{ id: 'Q1', answer: ANSWER_Q1 }, { id: 'Q2', answer: ANSWER_Q2 }, { id: 'A1', answer: OVERRIDE_A1 }], assumptions: ['A2'] })
    r = await invoke(c, 'design', stageArgs(c))
    assertFirstGit(r, c.repo)
    const inv2 = assertStageReport(r, 'design', 'design-ready', 'run2.json')
    assertNoLeak(c, r, secrets)
    assert.deepEqual(calls(c).map(call => call.role), ['extractor', 'questioner', 'architect', 'advisor'])
    const result2 = assertStageRows(c, inv2, ['architect', 'advisor'], design)
    assertRunFile(c, 'run2.json', result2.result)
    const stateSha = sha(readFileSync(join(c.stateDir, 'state.json')))
    assert.deepEqual(readJson(join(c.stateDir, 'meta.json')), { version: 1, basis: { 'run2.json': { 'state.json': stateSha } } })

    // backlog: slicer, advisor approve; backlog-ready; run3.json and both bases.
    const backlog = backlogArgsFor(c)
    assert.deepEqual(backlog.knowledge, ['K1'])
    r = await invoke(c, 'backlog', stageArgs(c))
    assertFirstGit(r, c.repo)
    const inv3 = assertStageReport(r, 'backlog', 'backlog-ready', 'run3.json')
    assertNoLeak(c, r, secrets)
    assert.deepEqual(calls(c).map(call => call.role), ['extractor', 'questioner', 'architect', 'advisor', 'slicer', 'advisor'])
    const result3 = assertStageRows(c, inv3, ['slicer', 'advisor'], backlog)
    assertRunFile(c, 'run3.json', result3.result)
    assert.equal(result3.result.backlog.app, 'reading-list')
    assert.deepEqual(readJson(join(c.stateDir, 'meta.json')), { version: 1, basis: {
      'run2.json': { 'state.json': stateSha },
      'run3.json': { 'state.json': stateSha, 'run2.json': sha(readFileSync(join(c.stateDir, 'run2.json'))) } } })
    assert.deepEqual(STATE_LIB.freshness(c.stateDir), { design: 'fresh', backlog: 'fresh' })

    // Three stages, three new invocations; each spawn wrote under its own invocation's provider directory.
    assert.equal(new Set([inv1, inv2, inv3]).size, 3)
    assert.deepEqual(readdirSync(c.nativeRuns).sort(), [inv1, inv2, inv3].sort())
    const spawns = calls(c)
    const perStage = [inv1, inv1, inv2, inv2, inv3, inv3]
    spawns.forEach((call, i) => {
      assert.equal(dirname(call.argv[call.argv.indexOf('--output-last-message') + 1]), join(runDirOf(c, perStage[i]), 'provider'))
    })

    // CP-04d's show accepts the same repo.
    const shown = await show(c)
    assert.equal(shown.code, 0, shown.stderr)
    assert.equal(shown.stderr, '')
    assert.ok(shown.stdout.startsWith('Blueprint approval: reading-list\nBranch: integration/reading-list\n'), shown.stdout.slice(0, 120))
    assert.ok(!shown.stdout.includes(MARKER))
    assertEveryCase(c)
  })
})

// =====================================================================
describe('3. redaction', () => {
  test('a GitHub-token-shaped request is stored with its label, start reports redacted, and no leaf ever sees the token', async () => {
    const c = await makeCase()
    const request = `Deploy with token ${FAKE_TOKEN} to the reading list host`
    const stored = `Deploy with token ${TOKEN_LABEL} to the reading list host`
    let r = await invoke(c, 'start', { repo: c.repo, request })
    assertReport(r, { stateDir: c.stateDir, redacted: true })
    assertNoLeak(c, r, [FAKE_TOKEN])
    assert.deepEqual(readJson(join(c.stateDir, 'request.json')), { request: stored, docs: [] })
    assert.ok(!readFileSync(join(c.stateDir, 'request.json'), 'utf8').includes(FAKE_TOKEN))

    // The interview reads the stored request, so the workflow args and every prompt carry the label only.
    r = await invoke(c, 'interview', stageArgs(c))
    const inv = assertStageReport(r, 'interview', 'needs-human', 'run1.json')
    assertStageRows(c, inv, ['extractor', 'questioner'], { repo: c.repo, request: stored, docs: [] })
    for (const call of calls(c)) assert.ok(!call.stdin.includes(FAKE_TOKEN), `${call.role} never saw the token`)
    assert.ok(calls(c)[0].stdin.includes(stored), 'the extractor saw the stored request')
    assertEveryCase(c)
  })

  test('a key-shaped string in a questioner output is stored with its label and the stage reports redacted', async () => {
    const leaky = QUESTIONS({ questions: [
      QUESTION('Q1', 'How do people sign in?', Q1_LABELS, { stakes: `Costs a lot; the old key was ${FAKE_KEY}` }),
      QUESTION('Q2', 'Which database?', Q2_LABELS)] })
    const c = await makeCase({ ...HAPPY, questioner: wire(leaky) })
    let r = await invoke(c, 'start', { repo: c.repo, request: REQUEST_TEXT })
    assertReport(r, { stateDir: c.stateDir, redacted: false })
    r = await invoke(c, 'interview', stageArgs(c))
    const inv = assertStageReport(r, 'interview', 'needs-human', 'run1.json', true)
    assertNoLeak(c, r, [FAKE_KEY])
    const text = readFileSync(join(c.stateDir, 'run1.json'), 'utf8')
    assert.ok(!text.includes(FAKE_KEY), 'run1.json holds no key')
    const run1 = JSON.parse(text)
    assert.equal(run1.questions[0].stakes, `Costs a lot; the old key was ${KEY_LABEL}`)
    // Only the secret changed: the stored ledger is the workflow's with that one string replaced.
    const raw = resultOf(c, inv).result
    raw.questions[0].stakes = run1.questions[0].stakes
    assert.deepEqual(run1, raw)

    // The same rule on answer: a key in a free-text answer is stored redacted, and the report says so.
    const answers = { repo: c.repo, answers: [{ id: 'Q1', answer: `Use ${FAKE_KEY} for it` }, { id: 'Q2', answer: ANSWER_Q2 }] }
    r = await invoke(c, 'answer', answers)
    assertReport(r, { decisions: 2, assumptions: 2, owed: 2, redacted: true })
    assertNoLeak(c, r, [FAKE_KEY])
    assert.ok(!readFileSync(join(c.stateDir, 'state.json'), 'utf8').includes(FAKE_KEY))
    assert.equal(STATE_LIB.readState(c.stateDir).decisions[0].answer, `Use ${KEY_LABEL} for it`)
    assertEveryCase(c)
  })
})

// =====================================================================
describe('4. refusals, each with zero spawns and no run file', () => {
  // The CLI refused: nothing in the state directory changed, no run directory, no spawn.
  async function refused(c, make) {
    const before = stateListing(c)
    const r = await make()
    assertNothingHappened(c, before, r)
    return r
  }
  function assertNothingHappened(c, before, r) {
    assert.deepEqual(stateListing(c), before, 'no run file or state file was written')
    noNativeRuns(c)
    noSpawns(c)
    assertNoLeak(c, r)
  }

  test('bad argv and bad args files are INVALID_ARGS, exit 1, with no git call and no file access in the repo', async () => {
    const c = await makeCase()
    const good = writeArgs(c, stageArgs(c))
    const argv = [
      [], ['interview'], ['interview', '--args-file'], ['bogus', '--args-file', good], ['interview', '--args-file', good, 'extra'],
      ['interview', '--args', good], ['--args-file', good, 'interview'], ['interview', '--args-file', 'relative/args.json'],
      ['interview', '--args-file', join(c.dir, 'no-such-args.json')], ['interview', '--args-file', c.dir], ['Interview', '--args-file', good],
      ['interview', '--args-file=' + good],
    ]
    const before = stateListing(c)
    const attempts = await parallel(argv, 6, a => invokeRaw(c, a))
    attempts.forEach((r, i) => {
      assertError(r, 'INVALID_ARGS', 1)
      assert.deepEqual(r.git, [], `no git call for argv ${JSON.stringify(argv[i])}`)
      assertNothingHappened(c, before, r)
    })
    const bad = argsMatrix(c)
    const results = await parallel(bad, 6, ({ verb, value }) => invokeRaw(c, [verb, '--args-file', writeArgs(c, value)]))
    results.forEach((r, i) => {
      assertError(r, 'INVALID_ARGS', 1)
      assert.deepEqual(r.git, [], `no git call for ${bad[i].verb} ${JSON.stringify(bad[i].value).slice(0, 80)}`)
      assertNothingHappened(c, before, r)
    })
    assertEveryCase(c)
  })

  test('a subdirectory, a plain directory and a missing path are NOT_A_REPO, exit 2, for every verb', async () => {
    const c = await makeCase()
    const plain = join(c.dir, 'plain')
    mkdirSync(plain)
    assert.notEqual(spawnSync(REAL_GIT, ['-C', plain, 'rev-parse', '--show-toplevel'], { env: GIT_ENV() }).status, 0, 'the plain directory is not inside a repo')
    const sub = join(c.repo, 'sub', 'dir')
    const attempts = []
    for (const repo of [sub, plain, join(c.dir, 'no-such-repo')]) {
      const per = { start: { repo, request: 'x' }, interview: stageArgs(c, { repo }), design: stageArgs(c, { repo }), backlog: stageArgs(c, { repo }),
        answer: { repo, answers: [{ id: 'Q1', answer: 'x' }] }, gate: { repo, answers: [{ id: 'G1', answer: 'x' }] }, edit: { repo, edit: 'x' } }
      for (const [verb, args] of Object.entries(per)) attempts.push({ verb, args, repo })
    }
    const before = stateListing(c)
    const results = await parallel(attempts, 6, ({ verb, args }) => invoke(c, verb, args))
    results.forEach((r, i) => {
      assertError(r, 'NOT_A_REPO', 2)
      assertFirstGit(r, attempts[i].repo)
      assertNothingHappened(c, before, r)
    })
    assertEveryCase(c)
  })

  test('interview with state.json present (a symlink counts) is STATE_EXISTS, before the request is read', async () => {
    const c = await makeCase()
    seed(c, { state: STATE() })
    let r = await refused(c, () => invoke(c, 'interview', stageArgs(c)))
    assertError(r, 'STATE_EXISTS', 2)
    assertFirstGit(r, c.repo)
    // A dangling symlink named state.json, and no request.json at all: still STATE_EXISTS.
    const d = await makeCase()
    mkdirSync(d.stateDir, { mode: 0o700 })
    symlinkSync(join(d.dir, 'nowhere.json'), join(d.stateDir, 'state.json'))
    r = await refused(d, () => invoke(d, 'interview', stageArgs(d)))
    assertError(r, 'STATE_EXISTS', 2)
    assertEveryCase(c)
    assertEveryCase(d)
  })

  test('design with no state is MISSING, exit 2', async () => {
    const c = await makeCase()
    let r = await refused(c, () => invoke(c, 'design', stageArgs(c)))
    assertError(r, 'MISSING', 2)
    assertFirstGit(r, c.repo)
    // With only a request saved (the interview ran, nobody answered): still no state.
    seed(c)
    r = await refused(c, () => invoke(c, 'design', stageArgs(c)))
    assertError(r, 'MISSING', 2)
    assertEveryCase(c)
  })

  test('backlog after state.json changed since run2 is STALE, exit 2', async () => {
    const c = await makeCase()
    seed(c, { state: STATE(), run2: RUN2_READY })
    assert.deepEqual(STATE_LIB.freshness(c.stateDir), { design: 'fresh', backlog: 'missing' })
    STATE_LIB.writeState(c.stateDir, STATE({ decisions: [DECISION('Q1', 'Magic link'), DECISION('Q2', ANSWER_Q2), DECISION('A1', OVERRIDE_A1, { note: 'override' })] }))
    assert.equal(STATE_LIB.freshness(c.stateDir).design, 'stale')
    const r = await refused(c, () => invoke(c, 'backlog', stageArgs(c)))
    assertError(r, 'STALE', 2)
    assertFirstGit(r, c.repo)
    assertEveryCase(c)
  })

  test('backlog with run2 needs-human is NOT_DESIGN_READY, exit 2', async () => {
    const c = await makeCase()
    seed(c, { state: STATE(), run2: RUN2_NEEDS })
    const r = await refused(c, () => invoke(c, 'backlog', stageArgs(c)))
    assertError(r, 'NOT_DESIGN_READY', 2)
    assertFirstGit(r, c.repo)
    assertEveryCase(c)
  })

  test('answer naming an unknown, duplicate or missing id prints CP-04b\'s code with its ids, exit 2; nothing is written', async () => {
    const c = await makeCase()
    seed(c, { run1: RUN1() })
    const a = id => ({ id, answer: id === 'Q1' ? ANSWER_Q1 : ANSWER_Q2 })
    const cases = [
      [[a('Q1'), a('Q2'), { id: 'Q9', answer: 'x' }], 'UNKNOWN_ID', ['Q9']],
      [[a('Q1'), a('Q1'), a('Q2')], 'DUPLICATE_ID', ['Q1']],
      [[a('Q1')], 'MISSING_ANSWER', ['Q2']],
    ]
    for (const [answers, code, ids] of cases) {
      const r = await refused(c, () => invoke(c, 'answer', { repo: c.repo, answers }))
      assertError(r, code, 2, { ids })
      assertFirstGit(r, c.repo)
    }
    assert.equal(existsSync(join(c.stateDir, 'state.json')), false)
    // A refusal without ids prints only the code, and a bad value CP-04a or CP-04b checks is exit 2, not exit 1.
    let r = await refused(c, () => invoke(c, 'answer', { repo: c.repo, answers: [a('Q1'), a('Q2')], have: ['not a preflight item'] }))
    assertError(r, 'BAD_PREFLIGHT', 2)
    r = await refused(c, () => invoke(c, 'answer', { repo: c.repo, answers: 'Q1' }))
    assertError(r, 'INVALID_INPUT', 2)
    r = await refused(c, () => invoke(c, 'start', { repo: c.repo, request: 5 }))
    assertError(r, 'INVALID_INPUT', 2)
    r = await refused(c, () => invoke(c, 'start', { repo: c.repo, docs: ['relative.md'] }))
    assertError(r, 'DOC_INVALID', 2)
    r = await refused(c, () => invoke(c, 'start', { repo: c.repo, docs: [join(c.dir, 'no-such-doc.md')] }))
    assertError(r, 'DOC_MISSING', 2)
    assertEveryCase(c)
  })

  test('start without a request or a document is NO_REQUEST, exit 2, and creates no state directory', async () => {
    const c = await makeCase()
    const r = await refused(c, () => invoke(c, 'start', { repo: c.repo }))
    assertError(r, 'NO_REQUEST', 2)
    assert.equal(existsSync(c.stateDir), false)
    assertEveryCase(c)
  })
})

// =====================================================================
describe('5. gates', () => {
  test('a blocking design advisor gives needs-human; gate applies the answer; two gates are the limit', async () => {
    // The advisor blocks twice: first about Q1, then with a question about nothing yet decided.
    const c = await makeCase({ ...HAPPY, advisor: [wire(BLOCKED(GATE_Q1)), wire(BLOCKED(GATE_NEW))] })
    seed(c, { state: STATE() })
    const stateBytes = () => readFileSync(join(c.stateDir, 'state.json'), 'utf8')

    // Design 1: needs-human with the gate's question; run2.json and meta.json exist.
    let design = designArgsFor(c)
    let r = await invoke(c, 'design', stageArgs(c))
    const inv1 = assertStageReport(r, 'design', 'needs-human', 'run2.json')
    const result1 = assertStageRows(c, inv1, ['architect', 'advisor'], design)
    assert.deepEqual(result1.result.questions, [{ about: 'Q1', question: 'Is a hosted sign-in really what you want?' }])
    assertRunFile(c, 'run2.json', result1.result)
    assert.equal(readJson(join(c.stateDir, 'run2.json')).status, 'needs-human')
    assert.deepEqual(Object.keys(readJson(join(c.stateDir, 'meta.json')).basis), ['run2.json'])
    const bytes1 = readFileSync(join(runDirOf(c, inv1), 'result.json'))

    // Gate 1: round 1; the runs the answer makes wrong are gone.
    r = await invoke(c, 'gate', { repo: c.repo, answers: [{ id: 'G1', answer: 'Keep email and password' }] })
    assertReport(r, { gateRounds: 1, redacted: false })
    assertFirstGit(r, c.repo)
    assert.equal(existsSync(join(c.stateDir, 'run2.json')), false, 'run2.json is gone')
    assert.equal(existsSync(join(c.stateDir, 'meta.json')), false, 'meta.json is gone')
    let state = STATE_LIB.readState(c.stateDir)
    assert.equal(state.gateRounds, 1)
    assert.deepEqual(state.decisions.find(d => d.id === 'Q1'), { ...DECISION('Q1', 'Keep email and password'), note: 'design gate' })

    // Design 2: a new invocation on the changed state; the first run directory is untouched.
    design = designArgsFor(c)
    assert.equal(design.decisions[0].answer, 'Keep email and password')
    r = await invoke(c, 'design', stageArgs(c))
    const inv2 = assertStageReport(r, 'design', 'needs-human', 'run2.json')
    assert.notEqual(inv2, inv1)
    const result2 = assertStageRows(c, inv2, ['architect', 'advisor'], design)
    assert.deepEqual(result2.result.questions, [{ about: null, question: 'Should there be an admin role?' }])
    assert.deepEqual(calls(c).map(call => call.role), ['architect', 'advisor', 'architect', 'advisor'])
    assert.deepEqual(readFileSync(join(runDirOf(c, inv1), 'result.json')), bytes1, 'the earlier run directory is never reused')
    assert.equal(statSync(join(runDirOf(c, inv1), 'checkpoints')).isDirectory(), true)
    assert.deepEqual(readdirSync(c.nativeRuns).sort(), [inv1, inv2].sort())

    // Gate 2: round 2; the unasked question becomes a new decision.
    r = await invoke(c, 'gate', { repo: c.repo, answers: [{ id: 'G1', answer: 'No admin' }] })
    assertReport(r, { gateRounds: 2, redacted: false })
    assert.equal(existsSync(join(c.stateDir, 'run2.json')), false)
    assert.equal(existsSync(join(c.stateDir, 'meta.json')), false)
    state = STATE_LIB.readState(c.stateDir)
    assert.equal(state.gateRounds, 2)
    assert.deepEqual(state.decisions.find(d => d.id === 'D1'), { id: 'D1', question: 'Should there be an admin role?', answer: 'No admin', resolves: [], note: 'design gate' })

    // A third gate is refused, whatever it answers, and changes nothing.
    const before = stateBytes()
    r = await invoke(c, 'gate', { repo: c.repo, answers: [{ id: 'G1', answer: 'One more' }] })
    assertError(r, 'GATE_ROUNDS_EXHAUSTED', 2)
    assert.equal(stateBytes(), before)
    assert.equal(calls(c).length, 4, 'a refused gate spawns nothing')
    assertEveryCase(c)
  })
})
// =====================================================================
describe('6. a leaf refusal', () => {
  test('the fake refuses the architect: the stage exits 0 with the workflow\'s escalate, run2.json records it, and nothing is retried or rerouted', async () => {
    const c = await makeCase({ ...HAPPY, architect: { refuse: true } })
    seed(c, { state: STATE() })
    const design = designArgsFor(c)
    const r = await invoke(c, 'design', stageArgs(c))
    const inv = assertStageReport(r, 'design', 'escalate', 'run2.json')
    // One spawn, never retried, never rerouted: no advisor, no claude call.
    assert.deepEqual(calls(c).map(call => call.role), ['architect'])
    const rows = checkpointRows(runDirOf(c, inv))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].binding.agentType, 'architect')
    assert.equal(rows[0].binding.argsHash, sha(canonical(design)))
    assert.equal(rows[0].state, 'failed')
    assert.equal(rows[0].completion.outcome, 'failed')
    assert.equal(rows[0].completion.code, 'PROVIDER_REFUSAL')
    const result = resultOf(c, inv)
    assert.equal(result.status, 'escalate')
    assertRunFile(c, 'run2.json', result.result)
    const run2 = readJson(join(c.stateDir, 'run2.json'))
    assert.equal(run2.status, 'escalate')
    assert.equal(typeof run2.reason, 'string')
    assert.ok(run2.reason.length > 0)
    assert.equal(run2.design, null)
    assert.deepEqual(readJson(join(c.stateDir, 'meta.json')).basis['run2.json'], { 'state.json': sha(readFileSync(join(c.stateDir, 'state.json'))) })
    assertEveryCase(c)
  })
})

// =====================================================================
describe('7. the production catalog', () => {
  test('with installationRoot at the candidate root every stage exits 2 OFFERING_UNSUPPORTED: no spawn, no run directory, no run file', async () => {
    const c = await makeCase()
    const production = { ...hostKeys(c), installationRoot: ROOT }
    assert.equal(readJson(resolve(ROOT, CATALOG)).offerings.find(o => o.id === 'blueprint').providers.codex.implementation, 'unavailable')
    // interview needs a request and no state; design a state; backlog a fresh design-ready run2.
    const steps = [
      ['interview', () => seed(c)],
      ['design', () => STATE_LIB.writeState(c.stateDir, STATE())],
      ['backlog', () => STATE_LIB.writeRun(c.stateDir, 2, RUN2_READY)],
    ]
    for (const [verb, prepare] of steps) {
      prepare()
      const before = stateListing(c)
      const r = await invoke(c, verb, { repo: c.repo, ...production })
      assertError(r, 'OFFERING_UNSUPPORTED', 2)
      assertFirstGit(r, c.repo)
      assertNoLeak(c, r)
      assert.deepEqual(stateListing(c), before, `${verb} wrote no run file`)
      noNativeRuns(c, false)
      noSpawns(c)
    }
    assert.deepEqual(['run1.json', 'run2.json', 'run3.json'].map(file => existsSync(join(c.stateDir, file))), [false, true, false],
      'only the seeded run2.json exists')
    assertEveryCase(c)
  })
})

// =====================================================================
describe('8. every case', () => {
  test('a refused stage and a completed stage leave HEAD, refs, the index and the work tree unchanged, with only rev-parse, no gh or claude, and no marker', async () => {
    const c = await makeCase()
    seed(c)
    // Refused: the state directory has a request but design has no state.
    let r = await invoke(c, 'design', stageArgs(c))
    assertError(r, 'MISSING', 2)
    assert.deepEqual(snapshot(c.repo), c.snap0)
    // Completed: interview (two spawns).
    r = await invoke(c, 'interview', stageArgs(c))
    assertStageReport(r, 'interview', 'needs-human', 'run1.json')
    assert.equal(calls(c).length, 2)
    assertEveryCase(c)
    assert.ok(c.runs.length >= 2 && c.runs.every(run => run.git.length > 0), 'every run the harness recorded called git')
    assert.ok(calls(c).every(call => !JSON.stringify(call.env).includes(MARKER)), 'the marker is in no leaf environment')
  })
})
