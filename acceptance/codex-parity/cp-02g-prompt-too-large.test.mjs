// CP-02g frozen acceptance: the host settles an oversize leaf prompt as a failed
// PROMPT_TOO_LARGE leaf (spec/contracts/codex-parity-cp-02g.md, wave-2 decision W2-2).
// Wiring proof, not runtime certification: no real codex, no network, no HOME.
// Library cases inject a recording provider into runGraphHost that rejects a prompt
// over 1 MiB the way codex-provider.mjs does. The CLI case spawns the host CLI, which
// builds the real CP-02b provider around a stub `codex` in an owned temp directory.
// Every installation root is a fixture copied from the candidate tree.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, completion, pass, review } from '../native-runtime/nr-02-runtime-support.mjs'

const HOST_PATH = resolve(ROOT, 'core/skills/native-runtime/graph-host.mjs')
const loadHost = () => import(pathToFileURL(HOST_PATH).href)
const loadRoles = () => import(pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/role-files.mjs')).href)
const MIB = 1048576
const CODE = 'PROMPT_TOO_LARGE'
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const MARK = 'CP02G-PROMPT-MARK'
const bytes = text => Buffer.byteLength(text, 'utf8')

// ---------------------------------------------------------------- fixture roots
// Copies only what the host reads: the catalog, the six workflow templates, every
// role file and every file directly in a skill directory. Regular files only.
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
const PARTIAL = Object.freeze({ implementation: 'partial', transportId: 'codex-autobuild',
  limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] })

let WORK, PRISTINE, BASE_ROOT, BIG_ROLE_ROOT, STUB, CALIBRATION
// The candidate catalog with only `dev`'s codex row flipped to partial (CP-02e's fixture).
function makeRoot(edit = () => {}) {
  const root = realpathSync(mkdtempSync(join(WORK, 'root-')))
  cpSync(PRISTINE, root, { recursive: true })
  const catalog = JSON.parse(readFileSync(join(root, CATALOG), 'utf8'))
  const row = catalog.offerings.find(o => o.id === 'dev')
  assert.ok(row?.providers?.codex, 'the candidate catalog is v2 with provider rows (CP-01b)')
  row.providers.codex = structuredClone(PARTIAL)
  writeFileSync(join(root, CATALOG), JSON.stringify(catalog, null, 2) + '\n')
  edit(root)
  return root
}
const base = () => (BASE_ROOT ??= makeRoot())
// The checker's role file grows by MIB bytes of padding that carry MARK, so its
// instructions alone are over the limit while the workflow's prompt stays small.
const ROLE_PADDING = '\n' + (MARK + ' ').repeat(Math.ceil(MIB / (MARK.length + 1))) + '\n'
const bigRoleRoot = () => (BIG_ROLE_ROOT ??= makeRoot(root => {
  const file = join(root, 'core/agents/checker.md')
  writeFileSync(file, readFileSync(file, 'utf8') + ROLE_PADDING)
}))

// ------------------------------------------------------------------- the stub
// Records every spawn in <STUB_DIR>/calls.jsonl and exits 97 without a step: a
// CLI case that expects zero spawns sees any spawn as a record.
const STUB_SOURCE = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const chunks = []
process.stdin.on('data', c => chunks.push(c))
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(process.env.STUB_DIR, 'calls.jsonl'), JSON.stringify({ argv: process.argv.slice(2),
    stdinBytes: Buffer.concat(chunks).length }) + '\\n')
  process.exit(97)
})
`

before(() => {
  WORK = realpathSync(mkdtempSync(join(tmpdir(), 'cp-02g-')))
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
  const c = { dir, runDir: join(dir, 'run'), stubDir: join(dir, 'stub'), cwd: join(dir, 'cwd') }
  for (const d of [c.stubDir, c.cwd]) mkdirSync(d)
  return c
}
// Rows stay under <runDir>/checkpoints (CP-02e layout, CP-05a checkpointDirOf).
const checkpointDir = c => join(c.runDir, 'checkpoints')
const resultFile = c => join(c.runDir, 'result.json')
function rowFiles(c) {
  const dir = checkpointDir(c)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => /^nr-[0-9a-f]{64}\.json$/.test(name)).sort()
    .map(name => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
}
const checkpointRows = c => rowFiles(c).map(file => JSON.parse(file.text))

// ------------------------------------------------------------- library helpers
// Answers like a passing provider, and rejects a prompt over 1 MiB the way
// codex-provider.mjs's request check does (codex-provider.mjs, leafRequest).
function recorder() {
  const calls = []
  const provider = {
    async runLeaf(req) {
      calls.push(req)
      if (bytes(req.prompt) > MIB) throw Object.assign(new Error('Native runtime: INVALID_RUNTIME_INPUT.'), { code: 'INVALID_RUNTIME_INPUT' })
      return completion(req, req.agentType === 'checker' ? pass() : review())
    },
  }
  return { provider, calls }
}
const options = (c, provider, patch = {}) => ({ installationRoot: base(), workflowId: 'harness-repair', offeringId: 'dev',
  invocationId: 'inv-1', args: { repo: '/r' }, runDir: c.runDir, provider, timeoutMs: 30000, maxConcurrentSubagents: 1, ...patch })
async function host(opts) { const { runGraphHost } = await loadHost(); return runGraphHost(opts) }
const instructionsFor = async (root, name) => (await loadRoles()).assembleRoleInstructions({ installationRoot: root, name }).instructions
const resultBytes = (o, outcome) => JSON.stringify({ schemaVersion: 1, workflowId: o.workflowId, offeringId: o.offeringId,
  invocationId: o.invocationId, status: outcome.status, result: outcome.result }, null, 2) + '\n'

// One probe run on the base root with repo "/r" gives the checker's full leaf prompt.
// The workflow puts the repo in the checker prompt once ("Repo: <repo>."), so a repo of
// k bytes makes the combined prompt exactly probe - 2 + k bytes.
async function calibrate() {
  if (CALIBRATION) return CALIBRATION
  const c = makeCase(), { provider, calls } = recorder()
  const outcome = await host(options(c, provider))
  assert.equal(outcome.exitCode, 0, 'the probe run completes')
  const probe = calls.find(req => req.agentType === 'checker')?.prompt
  assert.equal(typeof probe, 'string', 'the probe reached the checker')
  const instructions = await instructionsFor(base(), 'checker')
  assert.ok(probe.startsWith(instructions + '\n\n'), 'the leaf prompt is the role instructions, a blank line, the workflow prompt')
  assert.equal(probe.split('Repo: /r.').length, 2, 'the checker prompt names the repo once')
  CALIBRATION = { probe, probeBytes: bytes(probe) }
  return CALIBRATION
}
// A repo path that makes the combined checker prompt exactly `total` bytes. `wide`
// characters are 2-byte U+00E9, so the string has fewer UTF-16 units than bytes.
function repoFor(cal, total, wide = 0) {
  const k = total - cal.probeBytes + 2
  const fill = k - 1 - 2 * wide - MARK.length
  assert.ok(fill > 0, 'the role text leaves room for the repo')
  return '/' + MARK + 'é'.repeat(wide) + 'a'.repeat(fill)
}
const expectedPrompt = (cal, repo) => cal.probe.replace('Repo: /r.', `Repo: ${repo}.`)

// The one failed row the host's PROMPT_TOO_LARGE settles, checked byte for byte.
function assertPromptTooLarge(c, agentType = 'checker') {
  const files = rowFiles(c), rows = files.map(file => JSON.parse(file.text))
  assert.ok(!rows.some(row => row.state === 'uncertain' || row.state === 'prepared'), 'a call was held for reconcile')
  const row = rows.find(r => r.binding?.agentType === agentType)
  assert.ok(row, `no ${agentType} row`)
  assert.deepEqual(Object.keys(row), ['version', 'callId', 'binding', 'state', 'completion'])
  assert.equal(row.state, 'failed')
  const { provider, model, effort } = row.binding.selection
  assert.deepEqual(row.completion, { outcome: 'failed', code: CODE, usage: null,
    receipt: { provider, model, effort, invocationId: 'host:' + row.callId } })
  assert.match(row.completion.code, CODE_PATTERN)
  for (const file of files) assert.ok(!file.text.includes(MARK), 'a row carries prompt text')
  return row
}
function assertEscalated(outcome) {
  assert.equal(outcome.exitCode, 0, `outcome ${JSON.stringify(outcome)}`)
  assert.equal(outcome.status, 'escalate')
  assert.deepEqual(outcome.result.history, [{ node: 'check', label: outcome.result.history[0]?.label,
    error: 'Native runtime: LEAF_FAILED.' }])
  assert.ok(!JSON.stringify(outcome).includes(MARK), 'the outcome carries prompt text')
  assert.ok(!JSON.stringify(outcome).includes(CODE), 'the outcome names the leaf code (the graph sees only LEAF_FAILED)')
}

// ------------------------------------------------------------------ CLI helpers
function cliFile(c, root) {
  return { schemaVersion: 1, installationRoot: root, workflowId: 'harness-repair', offeringId: 'dev', invocationId: 'inv-cli',
    args: { repo: '/r' }, runDir: c.runDir, codexBin: STUB, cwd: c.cwd, env: { STUB_DIR: c.stubDir },
    timeoutMs: 30000, maxConcurrentSubagents: 1, graceMs: 200 }
}
function cli(argv) {
  return new Promise(done => {
    const child = spawn(process.execPath, [HOST_PATH, ...argv], { env: { HOST_ONLY: 'cp-02g' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', (code, signal) => done({ code, signal, stdout, stderr }))
  })
}
const stubCalls = c => {
  const file = join(c.stubDir, 'calls.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}

// ---------------------------------------------------------------------- cases
describe('CP-02g: an oversize leaf prompt is a failed PROMPT_TOO_LARGE leaf', () => {
  test('role + prompt one byte over 1 MiB settles a failed row with zero provider calls; harness-repair escalates (exit 0)', async () => {
    const cal = await calibrate()
    const c = makeCase(), { provider, calls } = recorder()
    const repo = repoFor(cal, MIB + 1)
    assert.equal(bytes(expectedPrompt(cal, repo)), MIB + 1)
    assert.ok(bytes(expectedPrompt(cal, repo).slice((await instructionsFor(base(), 'checker')).length + 2)) < MIB,
      'the workflow prompt alone is under the runtime limit')
    const o = options(c, provider, { args: { repo } })
    const outcome = await host(o)
    assertEscalated(outcome)
    assert.equal(calls.length, 0, 'the provider was called')
    assert.equal(checkpointRows(c).length, 1)
    assertPromptTooLarge(c)
    assert.deepEqual(readdirSync(c.runDir).sort(), ['checkpoints', 'result.json'])
    assert.deepEqual(readdirSync(checkpointDir(c)).filter(name => name === '.lock'), [], 'the run lock is released')
    const written = readFileSync(resultFile(c), 'utf8')
    assert.equal(written, resultBytes(o, outcome))
    assert.ok(!written.includes(MARK) && !written.includes(CODE), 'result.json carries prompt text or the leaf code')
  })

  test('exactly 1 MiB combined passes through to the provider unchanged', async () => {
    const cal = await calibrate()
    const c = makeCase(), { provider, calls } = recorder()
    const repo = repoFor(cal, MIB, 1000)
    const outcome = await host(options(c, provider, { args: { repo } }))
    assert.equal(calls[0]?.agentType, 'checker')
    assert.equal(bytes(calls[0].prompt), MIB)
    assert.equal(calls[0].prompt, expectedPrompt(cal, repo))
    // The same repo makes a later leaf's combined prompt over the limit when its role text
    // is longer than the checker's: that leaf must settle, never be held (exit 3).
    assert.equal(outcome.exitCode, 0, `outcome ${JSON.stringify(outcome)}`)
    const rows = checkpointRows(c)
    assert.equal(rows.find(r => r.binding.agentType === 'checker')?.state, 'returned')
    assert.ok(!rows.some(row => row.state === 'uncertain' || row.state === 'prepared'))
    // Every leaf that reached the provider was within the limit; any other settled as PROMPT_TOO_LARGE.
    for (const req of calls) assert.ok(bytes(req.prompt) <= MIB)
    for (const row of rows.filter(r => r.state === 'failed')) assert.equal(row.completion.code, CODE)
  })

  test('multibyte text is counted in UTF-8 bytes, not UTF-16 units', async () => {
    const cal = await calibrate()
    const c = makeCase(), { provider, calls } = recorder()
    const repo = repoFor(cal, MIB + 1, 1000)
    const combined = expectedPrompt(cal, repo)
    assert.equal(bytes(combined), MIB + 1)
    assert.ok(combined.length <= MIB - 999, 'the prompt has fewer UTF-16 units than the limit')
    const outcome = await host(options(c, provider, { args: { repo } }))
    assertEscalated(outcome)
    assert.equal(calls.length, 0, 'the provider was called')
    assertPromptTooLarge(c)
  })

  test('the role text counts: an oversize role file with a small workflow prompt settles the same way', async () => {
    const c = makeCase(), { provider, calls } = recorder()
    const instructions = await instructionsFor(bigRoleRoot(), 'checker')
    assert.ok(bytes(instructions) > MIB, 'the padded role survives assembly')
    const o = options(c, provider, { installationRoot: bigRoleRoot() })
    const outcome = await host(o)
    assertEscalated(outcome)
    assert.equal(calls.length, 0, 'the provider was called')
    assert.equal(checkpointRows(c).length, 1)
    assertPromptTooLarge(c)
    assert.equal(readFileSync(resultFile(c), 'utf8'), resultBytes(o, outcome))
  })

  test('a rerun with the same invocation id replays the failed leaf with zero provider calls', async () => {
    const cal = await calibrate()
    const c = makeCase()
    const repo = repoFor(cal, MIB + 1)
    const first = recorder()
    const o = options(c, first.provider, { args: { repo } })
    const outcome = await host(o)
    assertEscalated(outcome)
    assertPromptTooLarge(c)
    const rowsBefore = rowFiles(c), resultBefore = readFileSync(resultFile(c), 'utf8')

    const again = recorder()
    const replay = await host({ ...o, provider: again.provider })
    assert.deepEqual(replay, outcome)
    assert.equal(again.calls.length, 0, 'the replay called the provider')
    assert.deepEqual(rowFiles(c), rowsBefore, 'the replay changed a row')
    assert.equal(readFileSync(resultFile(c), 'utf8'), resultBefore)

    // A new invocation id in the same run directory is a new call: settled the same way, still no call.
    const fresh = recorder()
    const next = await host({ ...o, provider: fresh.provider, invocationId: 'inv-2' })
    assertEscalated(next)
    assert.equal(fresh.calls.length, 0)
    assert.equal(checkpointRows(c).length, 2)
    assert.ok(checkpointRows(c).every(row => row.state === 'failed' && row.completion.code === CODE))
  })

  test('the CLI settles it too: exit 0 escalate, no codex spawn, no provider files, nothing leaked', async () => {
    const c = makeCase()
    const argsFile = join(c.dir, 'args.json')
    writeFileSync(argsFile, JSON.stringify(cliFile(c, bigRoleRoot())))
    const r = await cli(['--args-file', argsFile])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, JSON.stringify({ status: 'escalate' }) + '\n')
    assert.equal(r.stderr, '')
    assert.deepEqual(stubCalls(c), [], 'codex was spawned')
    // The CP-02b provider never ran, so it made no provider/ directory.
    assert.deepEqual(readdirSync(c.runDir).sort(), ['checkpoints', 'result.json'])
    assertPromptTooLarge(c)
    const result = readFileSync(resultFile(c), 'utf8')
    assert.equal(JSON.parse(result).status, 'escalate')
    assert.ok(!result.includes(MARK) && !result.includes(CODE))
  })

  test('the host imports checkpointDirOf (CP-05a) and failedCompletion (CP-05b) and never copies them', () => {
    const text = readFileSync(HOST_PATH, 'utf8')
    const imported = new Map()
    for (const [, names, spec] of text.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm)) {
      imported.set(spec, [...(imported.get(spec) ?? []), ...names.split(',').map(n => n.trim()).filter(Boolean)])
    }
    assert.ok((imported.get('./checkpoint-store.mjs') ?? []).includes('checkpointDirOf'), 'checkpointDirOf is not imported')
    assert.ok((imported.get('./completion.mjs') ?? []).includes('failedCompletion'), 'failedCompletion is not imported')
    assert.ok(!(imported.get('./checkpoint-store.mjs') ?? []).includes('failHeldCheckpoint'),
      'the host must not use failHeldCheckpoint: it refuses OWNER_BUSY while the run holds the lock')
    assert.ok(!/(['"`])checkpoints\1/.test(text), 'the host still joins its own checkpoints directory')
    assert.ok(!/outcome:\s*['"]failed['"]/.test(text), 'the host builds a failed envelope itself')
  })
})
