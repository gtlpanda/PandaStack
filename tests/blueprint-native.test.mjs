// CP-04c implementation edges the frozen acceptance does not pin: the key rules' upper
// and lower bounds are admitted (a 4096-byte path, timeoutMs 1001 and 86400000); a
// provider the factory refuses is INVALID_ARGS with no native-runs directory; a
// native-runs symlink is IO_ERROR before the host runs; a host refusal passes through
// with the host's own code and exit, leaving native-runs empty and 0700; start's
// `redacted` for a padded request, a blank request with a document, and `restart`;
// edit's report, its redaction and CP-04b's MISSING and STALE_RUN passed through; a
// CP-04a IO_ERROR is exit 3; and a documents-only
// interview hands the workflow no `request` key. Every repo is an owned temp repo; the
// CLI runs in a child. Fake keys are built at run time.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'
import { initState, readRequest, readState, writeRun, writeState } from '../graphs/blueprint/skills/blueprint/blueprint-state.mjs'
import { runGraphHost } from '../core/skills/native-runtime/graph-host.mjs'
import { assembleRoleInstructions } from '../core/skills/native-runtime/role-files.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const MODULE_PATH = join(ROOT, 'graphs/blueprint/skills/blueprint/blueprint-native.mjs')
const FAKE_CODEX = join(ROOT, 'acceptance/codex-parity/cp-02f-fake-codex.cjs')
const CATALOG = 'spec/offering-capabilities.json'
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'blueprint native ')))
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const FAKE_KEY = ['sk', 'test', 'Qw3Er5Ty7Ui9Op1As2Df'].join('_')
const sha = text => createHash('sha256').update(text).digest('hex')
// CP-02e's canonical form (sorted keys), as the checkpoint rows' argsHash uses it.
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v)

const ENV = { PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: WORK }
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })

const STATE = (over = {}) => ({
  request: 'A shelf', docs: [], brief: { goal: 'g', mode: 'app', requirements: [{ id: 'R1', text: 'add', source: 'request' }] },
  decisions: [{ id: 'Q1', question: 'q', answer: 'a', resolves: [], note: null }], assumptions: [], preflight: [], gateRounds: 0, ...over,
})
const RUN2 = { status: 'design-ready', reason: null, design: { summary: 'A shelf.', knowledge: [] }, notes: [] }
const RUN3 = { status: 'backlog-ready', reason: null, backlog: { app: 'shelf', slices: [] }, owners: [], notes: [] }

let caseNo = 0
// An owned repo (its path holds a space) and its state directory.
function makeRepo() {
  const repo = join(WORK, `repo ${++caseNo}`)
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  return { repo, stateDir: join(repo, '.git', 'harness-blueprint'), nativeRuns: join(repo, '.git', 'harness-blueprint', 'native-runs') }
}
function writeArgs(value) {
  const path = join(WORK, `args-${++caseNo}.json`)
  writeFileSync(path, JSON.stringify(value))
  return path
}
// The CLI in a child: { code, stdout, stderr }.
function cli(verb, args) {
  const r = spawnSync(process.execPath, [MODULE_PATH, verb, '--args-file', writeArgs(args)], { encoding: 'utf8', env: ENV, timeout: 120000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}
function assertError(r, error, code) {
  assert.deepEqual(r, { code, stdout: '', stderr: `${JSON.stringify({ error })}\n` })
}
function assertReport(r, report) {
  assert.deepEqual(r, { code: 0, stdout: `${JSON.stringify(report)}\n`, stderr: '' })
}
const hostKeys = (over = {}) => ({ installationRoot: join(WORK, 'no-such-root'), codexBin: join(WORK, 'no-such-codex'), env: { PATH: '/usr/bin' },
  timeoutMs: 5000, ...over })

try {
  await test('the key rules admit their bounds: a 4096-byte path and timeoutMs 1001 and 86400000 reach the repo check', () => {
    const long = `/${'a'.repeat(4095)}`
    assert.equal(Buffer.byteLength(long), 4096)
    for (const args of [{ repo: long, ...hostKeys() }, { repo: join(WORK, 'none'), ...hostKeys({ installationRoot: long, codexBin: long }) },
      { repo: join(WORK, 'none'), ...hostKeys({ timeoutMs: 1001 }) }, { repo: join(WORK, 'none'), ...hostKeys({ timeoutMs: 86400000 }) }]) {
      assertError(cli('interview', args), 'NOT_A_REPO', 2)
    }
    // One byte or one millisecond past a bound is the CLI's own refusal.
    assertError(cli('interview', { repo: `${long}a`, ...hostKeys() }), 'INVALID_ARGS', 1)
    assertError(cli('interview', { repo: join(WORK, 'none'), ...hostKeys({ timeoutMs: 1000 }) }), 'INVALID_ARGS', 1)
  })

  await test('a provider the factory refuses (a NUL in an env value) is INVALID_ARGS, exit 1, and creates no native-runs directory', () => {
    const c = makeRepo()
    initState(c.stateDir, { request: 'A shelf' })
    assertError(cli('interview', { repo: c.repo, ...hostKeys({ env: { PATH: '/usr/bin', BAD: 'a\u0000b' } }) }), 'INVALID_ARGS', 1)
    assert.equal(existsSync(c.nativeRuns), false)
  })

  await test('a native-runs symlink is IO_ERROR, exit 3, before the host runs: its target stays empty and no run file is written', () => {
    const c = makeRepo()
    initState(c.stateDir, { request: 'A shelf' })
    const target = join(WORK, `elsewhere-${caseNo}`)
    mkdirSync(target)
    symlinkSync(target, c.nativeRuns)
    assertError(cli('interview', { repo: c.repo, ...hostKeys() }), 'IO_ERROR', 3)
    assert.deepEqual(readdirSync(target), [])
    assert.equal(existsSync(join(c.stateDir, 'run1.json')), false)
  })

  await test('a host refusal passes through with the host\'s own code and exit; native-runs is left empty and 0700', async () => {
    const c = makeRepo()
    initState(c.stateDir, { request: 'A shelf' })
    const r = cli('interview', { repo: c.repo, ...hostKeys() })
    // The same host input, run directly, is the expected outcome.
    const direct = await runGraphHost({ installationRoot: join(WORK, 'no-such-root'), workflowId: 'blueprint-design', offeringId: 'blueprint',
      invocationId: 'direct', args: {}, runDir: join(WORK, 'direct-run'), timeoutMs: 5000, maxConcurrentSubagents: 1,
      provider: { runLeaf: () => { throw new Error('never called') } } })
    assert.notEqual(direct.exitCode, 0)
    assertError(r, direct.error, direct.exitCode)
    assert.deepEqual(readdirSync(c.nativeRuns), [])
    assert.equal(statSync(c.nativeRuns).mode & 0o777, 0o700)
    assert.equal(existsSync(join(c.stateDir, 'run1.json')), false)
  })

  await test('start: a padded request is not redacted, a blank request with a document is not, and restart replaces a state', () => {
    const c = makeRepo()
    assertReport(cli('start', { repo: c.repo, request: '  A shelf  ' }), { stateDir: c.stateDir, redacted: false })
    assert.equal(readRequest(c.stateDir).request, 'A shelf')
    const doc = join(WORK, `doc-${caseNo}.md`)
    writeFileSync(doc, '# doc\n')
    writeState(c.stateDir, STATE())
    assertError(cli('start', { repo: c.repo, request: '   ', docs: [doc] }), 'STATE_EXISTS', 2)
    assertReport(cli('start', { repo: c.repo, request: '   ', docs: [doc], restart: true }), { stateDir: c.stateDir, redacted: false })
    assert.deepEqual(readRequest(c.stateDir), { request: null, docs: [doc] })
    assert.equal(existsSync(join(c.stateDir, 'state.json')), false)
    // A key in the request is stored as its label and reported.
    assertReport(cli('start', { repo: c.repo, request: `Use ${FAKE_KEY}`, restart: true }), { stateDir: c.stateDir, redacted: true })
    assert.ok(!readFileSync(join(c.stateDir, 'request.json'), 'utf8').includes(FAKE_KEY))
  })

  await test('edit: the report counts the new decision; a key-shaped edit is stored redacted and reported; a stale backlog is STALE_RUN', () => {
    const c = makeRepo()
    initState(c.stateDir, { request: 'A shelf' })
    writeState(c.stateDir, STATE())
    writeRun(c.stateDir, 2, RUN2)
    writeRun(c.stateDir, 3, RUN3)
    assertReport(cli('edit', { repo: c.repo, edit: 'Rename the app' }), { decisions: 2, redacted: false })
    // CP-04b removed the runs the edit made wrong, so a second edit has no backlog to answer.
    assert.deepEqual(['run2.json', 'run3.json', 'meta.json'].map(f => existsSync(join(c.stateDir, f))), [false, false, false])
    assertError(cli('edit', { repo: c.repo, edit: 'Again' }), 'MISSING', 2)
    writeRun(c.stateDir, 2, RUN2)
    writeRun(c.stateDir, 3, RUN3)
    assertReport(cli('edit', { repo: c.repo, edit: `Use ${FAKE_KEY}` }), { decisions: 3, redacted: true })
    assert.ok(!JSON.stringify(readState(c.stateDir)).includes(FAKE_KEY))
    // A backlog whose state changed after it was built is CP-04b's STALE_RUN, passed through.
    writeRun(c.stateDir, 2, RUN2)
    writeRun(c.stateDir, 3, RUN3)
    writeState(c.stateDir, STATE({ gateRounds: 1 }))
    assertError(cli('edit', { repo: c.repo, edit: 'Again' }), 'STALE_RUN', 2)
  })

  await test('a CP-04a IO_ERROR (an unreadable state directory) is exit 3', { skip: IS_ROOT && 'root reads a 000 directory' }, () => {
    const c = makeRepo()
    initState(c.stateDir, { request: 'A shelf' })
    chmodSync(c.stateDir, 0o000)
    try {
      assertError(cli('answer', { repo: c.repo, answers: [{ id: 'Q1', answer: 'x' }] }), 'IO_ERROR', 3)
    } finally {
      chmodSync(c.stateDir, 0o700)
    }
  })

  await test('a documents-only interview hands the workflow {repo, docs} with no request key, and stores run1', () => {
    // CP-02f's fixture root (the catalog, workflows, roles and skill files) with only
    // blueprint's codex row flipped to partial. Fixture values, never a production row.
    const fixture = join(WORK, 'root')
    const copy = rel => {
      mkdirSync(dirname(join(fixture, rel)), { recursive: true })
      cpSync(join(ROOT, rel), join(fixture, rel))
    }
    const filesIn = (rel, suffix) => (existsSync(join(ROOT, rel))
      ? readdirSync(join(ROOT, rel), { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith(suffix)).map(e => `${rel}/${e.name}`) : [])
    const dirsIn = rel => (existsSync(join(ROOT, rel))
      ? readdirSync(join(ROOT, rel), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => `${rel}/${e.name}`) : [])
    copy(CATALOG)
    for (const base of ['core', 'kit', ...dirsIn('graphs')]) {
      for (const rel of [...filesIn(`${base}/agents`, '.md'), ...filesIn(`${base}/workflows`, '.js')]) copy(rel)
      for (const skill of dirsIn(`${base}/skills`)) for (const rel of filesIn(skill, '')) copy(rel)
    }
    const catalog = JSON.parse(readFileSync(join(fixture, CATALOG), 'utf8'))
    catalog.offerings.find(o => o.id === 'blueprint').providers.codex = { implementation: 'partial', transportId: 'codex-autobuild',
      limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] }
    writeFileSync(join(fixture, CATALOG), `${JSON.stringify(catalog, null, 2)}\n`)

    const c = makeRepo()
    const bin = join(WORK, `bin-${caseNo}`), fake = join(WORK, `fake-${caseNo}`), codex = join(WORK, `codex-${caseNo}`)
    mkdirSync(bin)
    mkdirSync(fake)
    symlinkSync(process.execPath, join(bin, 'node'))
    cpSync(FAKE_CODEX, codex)
    chmodSync(codex, 0o755)
    const roles = ['extractor', 'questioner'].map(role => ({ role, prefix: `${assembleRoleInstructions({ installationRoot: fixture, name: role }).instructions}\n\n` }))
    const brief = { goal: 'g', mode: 'app', users: [], requirements: [{ id: 'R1', text: 'add', source: 'doc' }], decided: [], gaps: [],
      contradictions: [], constraints: [], existing_stack: 'none' }
    const questions = { questions: [{ id: 'Q1', question: 'Which store?', stakes: 's', options: [{ label: 'SQLite', description: 'd' }, { label: 'Postgres', description: 'd' }],
      recommended: 'SQLite', default_if_unasked: 'SQLite', resolves: [] }], preflight: [], assumptions: [] }
    writeFileSync(join(fake, 'script.json'), JSON.stringify({ roles, replies: { extractor: { json: JSON.stringify(brief) }, questioner: { json: JSON.stringify(questions) } } }))

    const doc = join(WORK, `doc-${caseNo}.md`)
    writeFileSync(doc, '# A shelf\n')
    assertReport(cli('start', { repo: c.repo, docs: [doc] }), { stateDir: c.stateDir, redacted: false })
    const r = cli('interview', { repo: c.repo, installationRoot: fixture, codexBin: codex, env: { PATH: bin, FAKE_CODEX_DIR: fake }, timeoutMs: 60000 })
    assert.equal(r.code, 0, r.stderr)
    const report = JSON.parse(r.stdout)
    assert.deepEqual([report.status, report.file, report.redacted], ['needs-human', 'run1.json', false])
    const checkpoints = join(c.nativeRuns, report.invocationId, 'checkpoints')
    const rows = readdirSync(checkpoints).filter(name => /^nr-[0-9a-f]{64}\.json$/.test(name)).map(name => JSON.parse(readFileSync(join(checkpoints, name), 'utf8')))
    assert.deepEqual(rows.map(row => row.binding.agentType).sort(), ['extractor', 'questioner'])
    for (const row of rows) assert.equal(row.binding.argsHash, sha(canonical({ repo: c.repo, docs: [doc] })))
    assert.equal(JSON.parse(readFileSync(join(c.stateDir, 'run1.json'), 'utf8')).status, 'needs-human')
    assert.ok(lstatSync(join(c.nativeRuns, report.invocationId)).isDirectory())
  })
} finally {
  spawnSync('/bin/chmod', ['-R', 'u+rwx', WORK])
  rmSync(WORK, { recursive: true, force: true })
}
