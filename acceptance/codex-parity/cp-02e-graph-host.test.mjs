// CP-02e frozen acceptance: native graph host library and CLI
// (spec/contracts/codex-parity-cp-02e.md). Wiring proof, not runtime
// certification: no real codex, no network, no HOME. Library cases inject a
// recording provider into runGraphHost. CLI cases spawn the host CLI, which builds
// the real CP-02b provider around a stub `codex` executable created in an owned
// temp directory. Every installation root is a fixture copied from the candidate
// tree (catalog, workflows, role files and SKILL.md files only).
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, completion, pass, review } from '../native-runtime/nr-02-runtime-support.mjs'

const HOST_PATH = resolve(ROOT, 'core/skills/native-runtime/graph-host.mjs')
const loadHost = () => import(pathToFileURL(HOST_PATH).href)
const loadRoles = () => import(pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/role-files.mjs')).href)
const sha = value => createHash('sha256').update(value).digest('hex')
const sleep = ms => new Promise(done => setTimeout(done, ms))
const mode = path => statSync(path).mode & 0o777
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (check()) return true
  return check()
}

// ---------------------------------------------------------------- fixture roots
// Copies only what the host reads: the catalog, the six workflow templates, every
// role file and every file directly in a skill directory (SKILL.md, and the files a
// CP-03d role token names). Regular files only; symlinks are skipped.
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
  copy('spec/offering-capabilities.json')
  const containers = ['core', 'kit', ...dirs('graphs').map(g => `graphs/${g}`)]
  for (const c of containers) {
    for (const f of files(`${c}/agents`, '.md')) copy(`${c}/agents/${f}`)
    for (const f of files(`${c}/workflows`, '.js')) copy(`${c}/workflows/${f}`)
    for (const s of dirs(`${c}/skills`)) for (const f of files(`${c}/skills/${s}`, '')) copy(`${c}/skills/${s}/${f}`)
  }
}
const CATALOG = 'spec/offering-capabilities.json'
const readCatalog = root => JSON.parse(readFileSync(join(root, CATALOG), 'utf8'))
const writeCatalog = (root, catalog) => writeFileSync(join(root, CATALOG), JSON.stringify(catalog, null, 2) + '\n')
const PARTIAL = Object.freeze({ implementation: 'partial', transportId: 'codex-autobuild',
  limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] })
function flip(catalog, id) {
  const row = catalog.offerings.find(o => o.id === id)
  assert.ok(row?.providers?.codex, 'the candidate catalog is v2 with provider rows (CP-01b)')
  row.providers.codex = structuredClone(PARTIAL)
}

let WORK, PRISTINE, BASE_ROOT, STUB
// The base root: the candidate catalog with only `dev`'s codex row flipped to partial.
function makeRoot(edit = () => {}) {
  const root = realpathSync(mkdtempSync(join(WORK, 'root-')))
  cpSync(PRISTINE, root, { recursive: true })
  const catalog = readCatalog(root)
  flip(catalog, 'dev')
  edit(catalog, root)
  writeCatalog(root, catalog)
  return root
}
// Built on first use, so a candidate without the v2 catalog fails every case on its own.
const base = () => (BASE_ROOT ??= makeRoot())

// ------------------------------------------------------------------- the stub
// Each spawn takes the step at its call index from <STUB_DIR>/steps.json and
// appends one record to <STUB_DIR>/calls.jsonl. Step fields: output (written to the
// --output-last-message path), hang (never exit), trap (ignore SIGTERM). When the
// --output-schema file is not the NR-01 wire schema (CP-02h) and output is exactly
// {"json": <string>}, the inner string is written instead (the bare object).
const NR01_WIRE = JSON.stringify({ type: 'object', properties: { json: { type: 'string' } }, required: ['json'], additionalProperties: false })
const STUB_SOURCE = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const dir = process.env.STUB_DIR
const argv = process.argv.slice(2)
const flag = name => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1] }
const chunks = []
process.stdin.on('data', c => chunks.push(c))
process.stdin.on('end', () => {
  const callsFile = path.join(dir, 'calls.jsonl')
  const index = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\\n').filter(Boolean).length : 0
  const step = JSON.parse(fs.readFileSync(path.join(dir, 'steps.json'), 'utf8'))[index]
  fs.appendFileSync(callsFile, JSON.stringify({ argv, cwd: process.cwd(), env: { ...process.env }, pid: process.pid,
    stdin: Buffer.concat(chunks).toString('utf8') }) + '\\n')
  if (!step) process.exit(97)
  if (step.trap) process.on('SIGTERM', () => {})
  if (step.hang) { fs.writeFileSync(path.join(dir, 'ready'), String(process.pid)); setInterval(() => {}, 1000); return }
  fs.writeFileSync(flag('--output-last-message'), followSchema(step.output, fs.readFileSync(flag('--output-schema'), 'utf8')))
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n')
  process.exit(0)
})
function followSchema(text, schema) {
  if (schema === ${JSON.stringify(NR01_WIRE)}) return text
  let value
  try { value = JSON.parse(text) } catch { return text }
  const wire = value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 1 && typeof value.json === 'string'
  return wire ? value.json : text
}
`
const wire = value => JSON.stringify({ json: JSON.stringify(value) })
const HAPPY_STEPS = [{ output: wire(pass()) }, { output: wire(review()) }, { output: wire(review()) }]

before(() => {
  WORK = realpathSync(mkdtempSync(join(tmpdir(), 'cp-02e-')))
  PRISTINE = join(WORK, 'pristine')
  copyTree(PRISTINE)
  STUB = join(WORK, 'codex-stub')
  writeFileSync(STUB, STUB_SOURCE)
  chmodSync(STUB, 0o755)
})
after(() => rmSync(WORK, { recursive: true, force: true }))

// One owned directory per case. The run directory is never created up front.
function makeCase() {
  const dir = realpathSync(mkdtempSync(join(WORK, 'case-')))
  const c = { dir, runDir: join(dir, 'run'), repo: join(dir, 'repo'), stubDir: join(dir, 'stub'), cwd: join(dir, 'cwd') }
  for (const d of [c.repo, c.stubDir, c.cwd]) mkdirSync(d)
  return c
}
const checkpointDir = c => join(c.runDir, 'checkpoints')
const lockFile = c => join(checkpointDir(c), '.lock')
const resultFile = c => join(c.runDir, 'result.json')
function checkpointRows(c) {
  const dir = checkpointDir(c)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => /^nr-[0-9a-f]{64}\.json$/.test(name))
    .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')))
}
const stubCalls = c => {
  const file = join(c.stubDir, 'calls.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}

// ------------------------------------------------------------- library helpers
const answerFor = req => req.agentType === 'checker' ? pass() : review()
function recorder(onCall) {
  const calls = []
  const provider = { async runLeaf(req) { calls.push(req); return onCall ? onCall(req, calls.length) : completion(req, answerFor(req)) } }
  return { provider, calls }
}
const options = (c, provider, patch = {}) => ({ installationRoot: base(), workflowId: 'harness-repair', offeringId: 'dev',
  invocationId: 'inv-1', args: { repo: c.repo }, runDir: c.runDir, provider, timeoutMs: 30000, maxConcurrentSubagents: 1, ...patch })
async function host(opts) { const { runGraphHost } = await loadHost(); return runGraphHost(opts) }
const instructionsFor = async (root, name) => (await loadRoles()).assembleRoleInstructions({ installationRoot: root, name }).instructions
const resultBytes = (o, outcome) => JSON.stringify({ schemaVersion: 1, workflowId: o.workflowId, offeringId: o.offeringId,
  invocationId: o.invocationId, status: outcome.status, result: outcome.result }, null, 2) + '\n'

function assertNoRun(c, outcome, exitCode, error, calls) {
  assert.deepEqual(outcome, { exitCode, error })
  assert.equal(calls.length, 0, 'the provider was called')
  assert.equal(existsSync(c.runDir), false, 'the run directory was created')
}

// ------------------------------------------------------------------ CLI helpers
const MARK = 'CP02E-SECRET-MARK'
function cliFile(c, patch = {}) {
  return { schemaVersion: 1, installationRoot: base(), workflowId: 'harness-repair', offeringId: 'dev', invocationId: 'inv-cli',
    args: { repo: c.repo }, runDir: c.runDir, codexBin: STUB, cwd: c.cwd, env: { STUB_DIR: c.stubDir, MARK: 'kept' },
    timeoutMs: 30000, maxConcurrentSubagents: 1, graceMs: 200, ...patch }
}
function writeArgs(c, value, name = `args-${MARK}.json`) {
  const path = join(c.dir, name)
  writeFileSync(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
  return path
}
// The host CLI runs with its own small environment; nothing from it may reach a leaf.
function cli(argv, { input, onSpawn } = {}) {
  return new Promise(done => {
    const started = Date.now()
    const child = spawn(process.execPath, [HOST_PATH, ...argv], { env: { HOST_ONLY: MARK }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', (code, signal) => done({ code, signal, stdout, stderr, ms: Date.now() - started }))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
    onSpawn?.(child)
  })
}
const errorLine = code => JSON.stringify({ error: code }) + '\n'
function assertCliError(r, exitCode, code) {
  assert.equal(r.code, exitCode, r.stderr)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, errorLine(code))
}

// ============================================================== library: refusals
describe('CP-02e refusal before dispatch (exit 2, no run directory, no provider call)', () => {
  const cases = [
    ['a catalog workflow pin that does not match the bytes gives REGISTRY_MISMATCH', 'REGISTRY_MISMATCH', () => makeRoot(catalog => {
      const row = catalog.workflows.find(w => w.source.endsWith('/harness-repair.js'))
      row.sha256 = row.sha256.replace(/^./, ch => (ch === '0' ? '1' : '0'))
    })],
    ['a changed byte in another registered workflow gives REGISTRY_MISMATCH', 'REGISTRY_MISMATCH', () => makeRoot((catalog, root) => {
      appendFileSync(join(root, 'graphs/release/workflows/release-flow.js'), '\n')
    })],
    ['a workflow row whose source is not graphs/<g>/workflows/<id>.js gives REGISTRY_MISMATCH', 'REGISTRY_MISMATCH', () => makeRoot(catalog => {
      catalog.workflows.find(w => w.source.endsWith('/harness-repair.js')).source = 'graphs/qa/flows/harness-repair.js'
    })],
    ['two workflow rows with one id give REGISTRY_MISMATCH', 'REGISTRY_MISMATCH', () => makeRoot(catalog => {
      const row = catalog.workflows.find(w => w.source.endsWith('/harness-repair.js'))
      catalog.workflows.push({ ...structuredClone(row), source: 'graphs/other/workflows/harness-repair.js' })
    })],
    ['a pin set that is not the registry six passes the registry code through unchanged', 'INVALID_RUNTIME_INPUT', () => makeRoot(catalog => {
      catalog.workflows = catalog.workflows.filter(w => !w.source.endsWith('/blueprint-design.js'))
    })],
    ['a v1 catalog gives CATALOG_NO_PINS', 'CATALOG_NO_PINS', () => {
      const root = makeRoot()
      cpSync(join(ROOT, 'acceptance/native-runtime/oc-01-catalog.fixture.json'), join(root, CATALOG))
      return root
    }],
  ]
  for (const [name, code, build] of cases) {
    test(name, async () => {
      const c = makeCase(), { provider, calls } = recorder()
      assertNoRun(c, await host(options(c, provider, { installationRoot: build() })), 2, code, calls)
    })
  }

  test('an unlisted workflow gives UNKNOWN_WORKFLOW', async () => {
    for (const workflowId of ['no-such-flow', 'loop', 'harness-review']) {
      const c = makeCase(), { provider, calls } = recorder()
      assertNoRun(c, await host(options(c, provider, { workflowId })), 2, 'UNKNOWN_WORKFLOW', calls)
    }
  })

  test('a codex-unavailable, unknown, non-owning or Codex-refused offering gives OFFERING_UNSUPPORTED', async () => {
    const refusedRoot = makeRoot(catalog => flip(catalog, 'security-audit'))
    const variants = [
      { offeringId: 'blueprint' },                                     // codex `unavailable`
      { offeringId: 'no-such-offering' },                              // not in the catalog
      { workflowId: 'dev-build', offeringId: 'bughunt' },              // partial, but graphs/dev is owned by dev
      { workflowId: 'bughunt-flow', offeringId: 'blueprint' },
      { installationRoot: refusedRoot, workflowId: 'security-audit-flow', offeringId: 'security-audit' },
    ]
    for (const patch of variants) {
      const c = makeCase(), { provider, calls } = recorder()
      assertNoRun(c, await host(options(c, provider, patch)), 2, 'OFFERING_UNSUPPORTED', calls)
    }
  })

  test('a role file the workflow or its registered child needs is checked before the run (CP-03c code)', async () => {
    const noFixer = makeRoot((catalog, root) => unlinkSync(join(root, 'graphs/qa/agents/fixer.md')))
    let c = makeCase(), r = recorder()
    assertNoRun(c, await host(options(c, r.provider, { installationRoot: noFixer })), 2, 'ROLE_NOT_FOUND', r.calls)
    // reviewer is reached only through dev-build's registered child harness-repair.
    const noReviewer = makeRoot((catalog, root) => unlinkSync(join(root, 'graphs/qa/agents/reviewer.md')))
    c = makeCase(); r = recorder()
    assertNoRun(c, await host(options(c, r.provider, { installationRoot: noReviewer, workflowId: 'dev-build' })), 2, 'ROLE_NOT_FOUND', r.calls)
  })

  test('the refusal order is catalog, pins, registry, workflow, offering', async () => {
    const v1 = makeRoot()
    cpSync(join(ROOT, 'acceptance/native-runtime/oc-01-catalog.fixture.json'), join(v1, CATALOG))
    const drifted = makeRoot((catalog, root) => appendFileSync(join(root, 'graphs/qa/workflows/harness-repair.js'), '\n'))
    const ordered = [
      [{ installationRoot: v1, workflowId: 'no-such-flow', offeringId: 'blueprint' }, 'CATALOG_NO_PINS'],
      [{ installationRoot: drifted, workflowId: 'no-such-flow', offeringId: 'blueprint' }, 'REGISTRY_MISMATCH'],
      [{ workflowId: 'no-such-flow', offeringId: 'blueprint' }, 'UNKNOWN_WORKFLOW'],
    ]
    for (const [patch, code] of ordered) {
      const c = makeCase(), { provider, calls } = recorder()
      assertNoRun(c, await host(options(c, provider, patch)), 2, code, calls)
    }
  })

  test('the catalog loader codes pass through unchanged', async () => {
    const missing = makeRoot((catalog, root) => {})
    rmSync(join(missing, CATALOG))
    const c = makeCase(), { provider, calls } = recorder()
    assertNoRun(c, await host(options(c, provider, { installationRoot: missing })), 2, 'NOT_FOUND', calls)
  })
})

// ================================================================== library: input
describe('CP-02e library input (exit 1 INVALID_HOST_INPUT, nothing touched)', () => {
  test('each bad option is refused before the catalog is read', async () => {
    const { provider } = recorder()
    const bad = [
      ['an unknown key', o => ({ ...o, extra: 1 })],
      ['a missing provider', o => { const { provider: _, ...rest } = o; return rest }],
      ['a provider without runLeaf', o => ({ ...o, provider: {} })],
      ['a relative runDir', o => ({ ...o, runDir: 'run' })],
      ['a relative installationRoot', o => ({ ...o, installationRoot: 'root' })],
      ['an invocation id with a slash', o => ({ ...o, invocationId: 'a/b' })],
      ['an empty invocation id', o => ({ ...o, invocationId: '' })],
      ['a workflow id with a slash', o => ({ ...o, workflowId: '../harness-repair' })],
      ['a numeric offering id', o => ({ ...o, offeringId: 7 })],
      ['timeoutMs 0', o => ({ ...o, timeoutMs: 0 })],
      ['timeoutMs over a day', o => ({ ...o, timeoutMs: 86400001 })],
      ['maxConcurrentSubagents 0', o => ({ ...o, maxConcurrentSubagents: 0 })],
      ['maxConcurrentSubagents 65', o => ({ ...o, maxConcurrentSubagents: 65 })],
      ['args that are not JSON', o => ({ ...o, args: { f() {} } })],
      ['a signal that is not an AbortSignal', o => ({ ...o, signal: { aborted: false } })],
      ['an options object that is not plain', o => Object.assign(Object.create({ inherited: 1 }), o)],
    ]
    for (const [name, mutate] of bad) {
      const c = makeCase()
      const outcome = await host(mutate(options(c, provider)))
      assert.deepEqual(outcome, { exitCode: 1, error: 'INVALID_HOST_INPUT' }, name)
      assert.equal(existsSync(c.runDir), false, name)
    }
  })
})

// ================================================================ library: running
describe('CP-02e harness-repair through the library (fake provider)', () => {
  test('a run persists result.json (0600) and exits 0 with the graph status', async () => {
    const c = makeCase(), { provider, calls } = recorder()
    const o = options(c, provider)
    const outcome = await host(o)
    assert.deepEqual(Object.keys(outcome).sort(), ['exitCode', 'result', 'status'])
    assert.equal(outcome.exitCode, 0)
    assert.equal(outcome.status, 'done')
    assert.equal(outcome.result.status, 'done')
    assert.equal(readFileSync(resultFile(c), 'utf8'), resultBytes(o, outcome))
    assert.equal(mode(resultFile(c)), 0o600)
    assert.equal(mode(c.runDir), 0o700)
    assert.equal(mode(checkpointDir(c)), 0o700)
    assert.equal(existsSync(lockFile(c)), false, 'the run lock is released')
    // No temp file is left, and the library never creates provider/.
    assert.deepEqual(readdirSync(c.runDir).sort(), ['checkpoints', 'result.json'])
    assert.deepEqual(calls.map(r => r.agentType), ['checker', 'reviewer', 'qa-auditor'])
    const rows = checkpointRows(c)
    assert.equal(rows.length, 3)
    assert.ok(rows.every(row => row.state === 'returned' && row.binding.invocationId === 'inv-1'))
    for (const req of calls) {
      // CP-02c resolveLeaf picked the selection and profile.
      assert.equal(req.selection.provider, 'codex')
      assert.equal(req.selection.model, req.agentType === 'checker' ? 'gpt-6-luna' : 'gpt-6.1-sol')
      assert.equal(req.profile, req.agentType === 'checker' ? 'build-workspace' : 'source-review')
      // The leaf prompt is the role's assembled instructions, a blank line, then the
      // workflow's own prompt byte for byte (its hash is the runtime binding's).
      const instructions = await instructionsFor(base(), req.agentType)
      assert.ok(req.prompt.startsWith(instructions + '\n\n'), `${req.agentType} prompt lacks its role instructions`)
      const own = req.prompt.slice(instructions.length + 2)
      const row = rows.find(r => r.callId === req.callId)
      assert.equal(sha(own), row.binding.promptHash)
      assert.ok(own.includes(`Repo: ${c.repo}.`))
    }
  })

  test('escalate also exits 0: bad args, and a failed leaf envelope', async () => {
    let c = makeCase(), r = recorder()
    let o = options(c, r.provider, { args: {} })
    let outcome = await host(o)
    assert.equal(outcome.exitCode, 0)
    assert.equal(outcome.status, 'escalate')
    assert.equal(r.calls.length, 0)
    assert.equal(readFileSync(resultFile(c), 'utf8'), resultBytes(o, outcome))

    c = makeCase()
    r = recorder(req => ({ outcome: 'failed', code: 'TIMEOUT', usage: null, receipt: { ...req.selection, invocationId: 'fake-' + req.callId } }))
    o = options(c, r.provider)
    outcome = await host(o)
    assert.equal(outcome.exitCode, 0)
    assert.equal(outcome.status, 'escalate')
    assert.equal(r.calls.length, 1)
    assert.equal(checkpointRows(c)[0].state, 'failed')
    assert.equal(JSON.parse(readFileSync(resultFile(c), 'utf8')).status, 'escalate')
  })

  test('a store close failure after the result is written is exit 3 and leaves result.json in place', async () => {
    // No fault seam: during the last leaf the provider replaces the run lock with a
    // directory, so CP-02d's close cannot read its lock (IO_ERROR, lock kept).
    const c = makeCase()
    const { provider, calls } = recorder((req, n) => {
      if (n === 3) { unlinkSync(lockFile(c)); mkdirSync(lockFile(c)) }
      return completion(req, answerFor(req))
    })
    const o = options(c, provider)
    assert.deepEqual(await host(o), { exitCode: 3, error: 'IO_ERROR' })
    assert.equal(calls.length, 3)
    const result = JSON.parse(readFileSync(resultFile(c), 'utf8'))
    assert.deepEqual([result.invocationId, result.status, result.result.status], ['inv-1', 'done', 'done'])
    assert.equal(mode(resultFile(c)), 0o600)
    assert.ok(statSync(lockFile(c)).isDirectory(), 'the lock the store could not read is left for an operator')
    // The kept lock still refuses the next run, and the host never deletes result.json.
    assert.deepEqual(await host(options(c, recorder().provider, { invocationId: 'inv-next' })), { exitCode: 4, error: 'OWNER_BUSY' })
    assert.equal(JSON.parse(readFileSync(resultFile(c), 'utf8')).invocationId, 'inv-1')
  })

  test('a provider throw exits 3, holds the call and writes no result', async () => {
    const c = makeCase(), { provider, calls } = recorder(() => { throw new Error(`provider exploded ${MARK}`) })
    const outcome = await host(options(c, provider))
    assert.deepEqual(outcome, { exitCode: 3, error: 'DISPATCH_UNCERTAIN' })
    assert.equal(calls.length, 1, 'a thrown call is never retried')
    assert.equal(existsSync(resultFile(c)), false)
    assert.equal(existsSync(lockFile(c)), false, 'the run lock is released after a failure')
    const rows = checkpointRows(c)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'uncertain')
    assert.equal(rows[0].code, 'DISPATCH_UNCERTAIN')
  })

  test('the runtime deadline exits 3; the host adds no timer of its own', async () => {
    // A provider that settles on abort: RUNTIME_ABORTED at the deadline.
    let c = makeCase()
    let r = recorder(req => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })))
    let started = Date.now()
    let outcome = await host(options(c, r.provider, { timeoutMs: 1000 }))
    let ms = Date.now() - started
    assert.deepEqual(outcome, { exitCode: 3, error: 'RUNTIME_ABORTED' })
    assert.ok(ms >= 900 && ms < 1000 + 1000 + 1000, `settled after ${ms} ms`)
    assert.equal(existsSync(resultFile(c)), false)
    assert.equal(existsSync(lockFile(c)), false)

    // A provider that ignores the abort: the runtime gives up after its own drain
    // bound (deadline + 1000 ms) with CLEANUP_UNCONFIRMED, and the host returns then.
    c = makeCase()
    r = recorder(() => new Promise(() => {}))
    started = Date.now()
    outcome = await host(options(c, r.provider, { timeoutMs: 1000 }))
    ms = Date.now() - started
    assert.deepEqual(outcome, { exitCode: 3, error: 'CLEANUP_UNCONFIRMED' })
    assert.ok(ms >= 1900 && ms < 1000 + 1000 + 1500, `settled after ${ms} ms`)
    assert.equal(existsSync(lockFile(c)), false, 'the run lock is released even when cleanup is unconfirmed')
    const next = recorder()
    assert.equal((await host(options(c, next.provider, { invocationId: 'inv-after-deadline' }))).exitCode, 0)
  })
})

// ================================================================= library: resume
describe('CP-02e resume (decision 4: held calls stay terminal)', () => {
  test('a completed run replays with zero provider calls and the same result bytes', async () => {
    const c = makeCase(), first = recorder()
    const o = options(c, first.provider)
    assert.equal((await host(o)).exitCode, 0)
    const bytes = readFileSync(resultFile(c))
    const again = recorder(() => { throw new Error('replay must not dispatch') })
    const outcome = await host({ ...o, provider: again.provider })
    assert.equal(outcome.exitCode, 0)
    assert.equal(outcome.status, 'done')
    assert.equal(again.calls.length, 0)
    assert.deepEqual(readFileSync(resultFile(c)), bytes)
  })

  test('a completed leaf replays; an uncertain leaf is held with CHECKPOINT_UNCERTAIN; a new invocation id starts fresh', async () => {
    const c = makeCase()
    // checker returns and settles, then the reviewer throws and is held.
    const first = recorder((req, n) => { if (n === 2) throw new Error('lost'); return completion(req, answerFor(req)) })
    assert.deepEqual(await host(options(c, first.provider)), { exitCode: 3, error: 'DISPATCH_UNCERTAIN' })
    assert.deepEqual(first.calls.map(r => r.agentType), ['checker', 'reviewer'])

    const second = recorder()
    assert.deepEqual(await host(options(c, second.provider)), { exitCode: 3, error: 'CHECKPOINT_UNCERTAIN' })
    assert.equal(second.calls.length, 0, 'the checker replayed and the held reviewer was not re-dispatched')
    assert.equal(existsSync(resultFile(c)), false)

    const fresh = recorder()
    const outcome = await host(options(c, fresh.provider, { invocationId: 'inv-2' }))
    assert.equal(outcome.exitCode, 0)
    assert.equal(outcome.status, 'done')
    assert.deepEqual(fresh.calls.map(r => r.agentType), ['checker', 'reviewer', 'qa-auditor'])
    assert.equal(JSON.parse(readFileSync(resultFile(c), 'utf8')).invocationId, 'inv-2')
  })
})

// =================================================================== library: lock
describe('CP-02e run lock (exit 4, never auto-broken)', () => {
  test('a held lock file exits 4 and is left byte for byte', async () => {
    const c = makeCase()
    mkdirSync(checkpointDir(c), { recursive: true })
    writeFileSync(lockFile(c), 'held by someone else\n')
    const { provider, calls } = recorder()
    assert.deepEqual(await host(options(c, provider)), { exitCode: 4, error: 'OWNER_BUSY' })
    assert.equal(calls.length, 0)
    assert.equal(readFileSync(lockFile(c), 'utf8'), 'held by someone else\n')
    assert.equal(existsSync(resultFile(c)), false)
    assert.deepEqual(readdirSync(checkpointDir(c)), ['.lock'])
    unlinkSync(lockFile(c)) // the operator's deliberate action
    assert.equal((await host(options(c, recorder().provider))).exitCode, 0)
  })

  test('a second run on a run directory that is in use exits 4', async () => {
    const c = makeCase()
    let release
    const gate = new Promise(done => { release = done })
    const first = recorder(async (req, n) => { if (n === 1) await gate; return completion(req, answerFor(req)) })
    const running = host(options(c, first.provider))
    assert.ok(await until(() => first.calls.length === 1), 'the first run never dispatched')
    const second = recorder()
    assert.deepEqual(await host(options(c, second.provider, { invocationId: 'inv-other' })), { exitCode: 4, error: 'OWNER_BUSY' })
    assert.equal(second.calls.length, 0)
    release()
    assert.equal((await running).exitCode, 0)
  })
})

// ======================================================================= the CLI
describe('CP-02e CLI: --args-file is the only input route', () => {
  test('a bad argv or args file exits 1 with one JSON error line and touches nothing', async () => {
    const c = makeCase()
    writeFileSync(join(c.stubDir, 'steps.json'), JSON.stringify(HAPPY_STEPS))
    const good = writeArgs(c, cliFile(c), 'good.json')
    const binDir = join(c.dir, 'bin')
    mkdirSync(binDir)
    cpSync(STUB, join(binDir, 'codex'))
    chmodSync(join(binDir, 'codex'), 0o755)
    const big = cliFile(c, { args: { repo: c.repo, pad: 'x'.repeat(1048576) } })
    const argvs = [
      ['no arguments, valid args on stdin', [], JSON.stringify(cliFile(c))],
      ['--args-file without a path', ['--args-file']],
      ['a relative args file path', ['--args-file', 'good.json']],
      ['--args-file twice', ['--args-file', good, '--args-file', good]],
      ['an inline --args flag', ['--args', JSON.stringify(cliFile(c))]],
      ['a positional path', [good]],
      ['--args-file plus another flag', ['--args-file', good, '--timeout-ms', '1000']],
      ['a missing file', ['--args-file', join(c.dir, `missing-${MARK}.json`)]],
      ['a directory', ['--args-file', c.dir]],
      ['bytes that are not UTF-8', ['--args-file', writeArgs(c, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), 'bad-utf8.json')]],
      ['text that is not JSON', ['--args-file', writeArgs(c, `{"schemaVersion":1, ${MARK}`, 'not-json.json')]],
      ['a JSON array', ['--args-file', writeArgs(c, [cliFile(c)], 'array.json')]],
      ['an unknown key', ['--args-file', writeArgs(c, cliFile(c, { [MARK]: 1 }), 'unknown.json')]],
      ['a missing key', ['--args-file', writeArgs(c, (({ env, ...rest }) => rest)(cliFile(c)), 'missing-key.json')]],
      ['schemaVersion 2', ['--args-file', writeArgs(c, cliFile(c, { schemaVersion: 2 }), 'version.json')]],
      ['a relative runDir', ['--args-file', writeArgs(c, cliFile(c, { runDir: `run-${MARK}` }), 'rel-run.json')]],
      ['a bare codex name (no PATH lookup)', ['--args-file', writeArgs(c, cliFile(c, { codexBin: 'codex', env: { STUB_DIR: c.stubDir, PATH: binDir } }), 'bare.json')]],
      ['a relative cwd', ['--args-file', writeArgs(c, cliFile(c, { cwd: 'cwd' }), 'rel-cwd.json')]],
      ['an env value that is not a string', ['--args-file', writeArgs(c, cliFile(c, { env: { STUB_DIR: c.stubDir, N: 1 } }), 'env.json')]],
      ['timeoutMs that leaves no room for a leaf', ['--args-file', writeArgs(c, cliFile(c, { graceMs: 500, timeoutMs: 1000 }), 'tight.json')]],
      ['a negative graceMs', ['--args-file', writeArgs(c, cliFile(c, { graceMs: -1 }), 'grace.json')]],
      ['a non-boolean skipGitRepoCheck', ['--args-file', writeArgs(c, cliFile(c, { skipGitRepoCheck: 'yes' }), 'skip.json')]],
      ['an invocation id with a slash', ['--args-file', writeArgs(c, cliFile(c, { invocationId: `a/${MARK}` }), 'inv.json')]],
      ['a file over 1 MiB', ['--args-file', writeArgs(c, big, 'big.json')]],
    ]
    for (const [name, argv, input] of argvs) {
      const r = await cli(argv, { input })
      assert.equal(r.code, 1, `${name}: ${r.stderr}`)
      assert.equal(r.stdout, '', name)
      assert.equal(r.stderr, errorLine('INVALID_HOST_INPUT'), name)
      assert.equal(existsSync(c.runDir), false, name)
      assert.deepEqual(stubCalls(c), [], name)
    }
  })

  test('a harness-repair run builds the CP-02b provider from codexBin and prints the status', async () => {
    const c = makeCase()
    writeFileSync(join(c.stubDir, 'steps.json'), JSON.stringify(HAPPY_STEPS))
    const r = await cli(['--args-file', writeArgs(c, cliFile(c))])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, JSON.stringify({ status: 'done' }) + '\n')
    assert.equal(r.stderr, '')
    const result = JSON.parse(readFileSync(resultFile(c), 'utf8'))
    assert.deepEqual(Object.keys(result), ['schemaVersion', 'workflowId', 'offeringId', 'invocationId', 'status', 'result'])
    assert.deepEqual([result.schemaVersion, result.workflowId, result.offeringId, result.invocationId, result.status],
      [1, 'harness-repair', 'dev', 'inv-cli', 'done'])
    assert.equal(mode(resultFile(c)), 0o600)
    assert.equal(existsSync(lockFile(c)), false)
    assert.deepEqual(readdirSync(c.runDir).sort(), ['checkpoints', 'provider', 'result.json'])

    const calls = stubCalls(c), rows = checkpointRows(c)
    assert.equal(calls.length, 3)
    const sandbox = call => call.argv[call.argv.indexOf('--sandbox') + 1]
    assert.deepEqual(calls.map(sandbox), ['workspace-write', 'read-only', 'read-only'])
    for (const [i, call] of calls.entries()) {
      assert.ok(call.argv.includes('--ignore-user-config'))
      assert.ok(call.argv.includes(i === 0 ? 'gpt-6-luna' : 'gpt-6.1-sol'))
      assert.equal(call.cwd, c.cwd)
      // The leaf environment is exactly the args file's env: nothing from the host CLI's.
      assert.deepEqual(Object.keys(call.env).filter(k => k !== '__CF_USER_TEXT_ENCODING').sort(), ['MARK', 'STUB_DIR'])
      const out = call.argv[call.argv.indexOf('--output-last-message') + 1]
      assert.equal(dirname(out), join(c.runDir, 'provider'))
    }
    const roles = ['checker', 'reviewer', 'qa-auditor']
    for (const [i, call] of calls.entries()) {
      const instructions = await instructionsFor(base(), roles[i])
      assert.ok(call.stdin.startsWith(instructions + '\n\n'))
      const row = rows.find(r => r.binding.agentType === roles[i])
      assert.equal(sha(call.stdin.slice(instructions.length + 2)), row.binding.promptHash)
    }
  })

  test('a leaf timeout settles inside the deadline and escalates (exit 0), even when SIGTERM is ignored', async () => {
    const c = makeCase()
    writeFileSync(join(c.stubDir, 'steps.json'), JSON.stringify([{ hang: true, trap: true }]))
    const timeoutMs = 3000
    const r = await cli(['--args-file', writeArgs(c, cliFile(c, { timeoutMs, graceMs: 200 }))])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, JSON.stringify({ status: 'escalate' }) + '\n')
    assert.ok(r.ms < timeoutMs + 1500, `took ${r.ms} ms`)
    const rows = checkpointRows(c)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'failed')
    assert.equal(rows[0].completion.code, 'TIMEOUT')
    assert.equal(alive(Number(readFileSync(join(c.stubDir, 'ready'), 'utf8'))), false)
  })

  test('a refusal and a held lock print one JSON error line (exit 2 and 4)', async () => {
    let c = makeCase()
    writeFileSync(join(c.stubDir, 'steps.json'), JSON.stringify(HAPPY_STEPS))
    assertCliError(await cli(['--args-file', writeArgs(c, cliFile(c, { offeringId: 'blueprint' }))]), 2, 'OFFERING_UNSUPPORTED')
    assert.equal(existsSync(c.runDir), false)
    assert.deepEqual(stubCalls(c), [])

    c = makeCase()
    writeFileSync(join(c.stubDir, 'steps.json'), JSON.stringify(HAPPY_STEPS))
    mkdirSync(checkpointDir(c), { recursive: true })
    writeFileSync(lockFile(c), 'held\n')
    assertCliError(await cli(['--args-file', writeArgs(c, cliFile(c))]), 4, 'OWNER_BUSY')
    assert.equal(readFileSync(lockFile(c), 'utf8'), 'held\n')
    assert.deepEqual(stubCalls(c), [])
  })

  test('SIGTERM to the host aborts the run (exit 3), releases the lock and holds the call', async () => {
    const c = makeCase()
    writeFileSync(join(c.stubDir, 'steps.json'), JSON.stringify([{ hang: true, trap: true }, ...HAPPY_STEPS]))
    const args = writeArgs(c, cliFile(c))
    const r = await cli(['--args-file', args], {
      onSpawn: async child => {
        if (await until(() => existsSync(join(c.stubDir, 'ready')), 10000)) child.kill('SIGTERM')
      },
    })
    assertCliError(r, 3, 'RUNTIME_ABORTED')
    assert.equal(existsSync(lockFile(c)), false)
    assert.equal(existsSync(resultFile(c)), false)
    assert.ok(await until(() => !alive(Number(readFileSync(join(c.stubDir, 'ready'), 'utf8'))), 3000))

    assertCliError(await cli(['--args-file', args]), 3, 'CHECKPOINT_UNCERTAIN')
    assert.equal(stubCalls(c).length, 1, 'the held call was re-dispatched')

    const fresh = await cli(['--args-file', writeArgs(c, cliFile(c, { invocationId: 'inv-cli-2' }), 'fresh.json')])
    assert.equal(fresh.code, 0, fresh.stderr)
    assert.equal(fresh.stdout, JSON.stringify({ status: 'done' }) + '\n')
    assert.equal(stubCalls(c).length, 4)
  })
})
