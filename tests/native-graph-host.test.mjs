// CP-02e implementation edges the frozen acceptance does not pin: graph results
// that are undefined, status-less, not JSON or a code-less throw (fixture
// templates re-pinned in a fixture catalog); an existing run directory's mode; a
// run directory that is a file; a signal aborted before the run; an earlier
// result.json left alone by a failed invocation; an unowned graph run for another
// offering; the provider's `this` and request keys; path and signal option rules;
// and CLI args files that are a FIFO, carry __proto__ or rely on default graceMs.
// Wiring proof with a recording provider: no codex, network or HOME.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { REPO, test } from '../scripts/workflow-harness.mjs'
import { completion, pass, review } from '../acceptance/native-runtime/nr-02-runtime-support.mjs'

const HOST = join(REPO, 'core/skills/native-runtime/graph-host.mjs')
const api = () => import('../core/skills/native-runtime/graph-host.mjs')
const CATALOG = 'spec/offering-capabilities.json'
const WORKFLOW = 'graphs/qa/workflows/harness-repair.js'
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'native-graph-host-')))
const mode = path => statSync(path).mode & 0o777
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// Only what the host reads: the catalog, workflow templates, role files and SKILL.md files.
function copyFixture(target) {
  const copy = rel => {
    const from = join(REPO, rel)
    if (!existsSync(from) || !lstatSync(from).isFile()) return
    mkdirSync(dirname(join(target, rel)), { recursive: true })
    cpSync(from, join(target, rel))
  }
  const entries = rel => existsSync(join(REPO, rel)) ? readdirSync(join(REPO, rel), { withFileTypes: true }) : []
  copy(CATALOG)
  const containers = ['core', 'kit', ...entries('graphs').filter(e => e.isDirectory()).map(e => `graphs/${e.name}`)]
  for (const c of containers) {
    for (const e of entries(`${c}/agents`)) if (e.isFile() && e.name.endsWith('.md')) copy(`${c}/agents/${e.name}`)
    for (const e of entries(`${c}/workflows`)) if (e.isFile() && e.name.endsWith('.js')) copy(`${c}/workflows/${e.name}`)
    // Every regular file of each skill directory, so role skill-path tokens resolve
    // (CP-03d: the checker's verify token needs core/skills/verify/verify.sh).
    for (const e of entries(`${c}/skills`)) {
      if (!e.isDirectory()) continue
      for (const f of entries(`${c}/skills/${e.name}`)) if (f.isFile()) copy(`${c}/skills/${e.name}/${f.name}`)
    }
  }
}
const PRISTINE = join(WORK, 'pristine')
copyFixture(PRISTINE)

// A fixture root with dev's codex row partial. `body`, when given, replaces the
// harness-repair template's code and its catalog pin follows the new bytes.
function makeRoot(body) {
  const root = realpathSync(mkdtempSync(join(WORK, 'root-')))
  cpSync(PRISTINE, root, { recursive: true })
  const catalog = JSON.parse(readFileSync(join(root, CATALOG), 'utf8'))
  catalog.offerings.find(o => o.id === 'dev').providers.codex = { implementation: 'partial', transportId: 'codex-autobuild',
    limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] }
  // The refusal cases use blueprint as a codex-unavailable offering; CP-04e flips the
  // candidate's row, so the fixture sets it (amended at the tier-4 freeze, W2-10).
  catalog.offerings.find(o => o.id === 'blueprint').providers.codex = { implementation: 'unavailable', transportId: null,
    limitations: ['NATIVE_UNVERIFIED', 'NO_PROVIDER_TRANSPORT', 'REQUIREMENTS_INCOMPLETE'] }
  if (body !== undefined) {
    const bytes = `export const meta = {\n  name: 'harness-repair',\n}\n${body}\n`
    writeFileSync(join(root, WORKFLOW), bytes)
    catalog.workflows.find(w => w.source === WORKFLOW).sha256 = sha(bytes)
  }
  writeFileSync(join(root, CATALOG), JSON.stringify(catalog, null, 2) + '\n')
  return root
}
const BASE = makeRoot()

const freshCase = () => {
  const dir = realpathSync(mkdtempSync(join(WORK, 'case-')))
  return { dir, runDir: join(dir, 'run'), repo: join(dir, 'repo') }
}
const answerFor = req => req.agentType === 'checker' ? pass() : review()
function recorder(onCall) {
  const calls = []
  const provider = { async runLeaf(req) { calls.push(req); return onCall ? onCall(req) : completion(req, answerFor(req)) } }
  return { provider, calls }
}
const options = (c, provider, patch = {}) => ({ installationRoot: BASE, workflowId: 'harness-repair', offeringId: 'dev',
  invocationId: 'inv-1', args: { repo: c.repo }, runDir: c.runDir, provider, timeoutMs: 30000, maxConcurrentSubagents: 1, ...patch })
async function host(opts) { const { runGraphHost } = await api(); return runGraphHost(opts) }
const readResult = c => JSON.parse(readFileSync(join(c.runDir, 'result.json'), 'utf8'))
const lockGone = c => !existsSync(join(c.runDir, 'checkpoints', '.lock'))

try {
  console.log('== native graph host: graph results')

  await test('a graph that returns undefined persists result null and status null (exit 0)', async () => {
    const c = freshCase(), { provider, calls } = recorder()
    const outcome = await host(options(c, provider, { installationRoot: makeRoot('return undefined') }))
    assert.deepEqual(outcome, { exitCode: 0, status: null, result: null })
    assert.equal(calls.length, 0)
    const saved = readResult(c)
    assert.deepEqual([saved.status, saved.result], [null, null])
    assert.ok(lockGone(c))
  })

  await test('status is null unless the result is an object with a non-empty string status', async () => {
    for (const [body, result] of [["return { status: '' }", { status: '' }], ['return { status: 7 }', { status: 7 }],
      ["return ['done']", ['done']], ["return 'done'", 'done']]) {
      const c = freshCase()
      const outcome = await host(options(c, recorder().provider, { installationRoot: makeRoot(body) }))
      assert.deepEqual(outcome, { exitCode: 0, status: null, result }, body)
      assert.equal(readResult(c).status, null, body)
    }
  })

  await test('a result that is not JSON is exit 3 INVALID_RESULT with no result.json and the lock released', async () => {
    const c = freshCase()
    assert.deepEqual(await host(options(c, recorder().provider, { installationRoot: makeRoot('return { status: 1n }') })),
      { exitCode: 3, error: 'INVALID_RESULT' })
    assert.deepEqual(readdirSync(c.runDir), ['checkpoints'], 'no result.json and no temp file')
    assert.ok(lockGone(c))
  })

  await test('a graph rejection with no fixed code is WORKFLOW_ERROR; a fixed code passes through', async () => {
    let c = freshCase()
    assert.deepEqual(await host(options(c, recorder().provider, { installationRoot: makeRoot("throw new Error('/secret/path broke')") })),
      { exitCode: 3, error: 'WORKFLOW_ERROR' })
    assert.ok(lockGone(c))
    c = freshCase()
    assert.deepEqual(await host(options(c, recorder().provider, { installationRoot: makeRoot("throw Object.assign(new Error('x'), { code: 'lower case' })") })),
      { exitCode: 3, error: 'WORKFLOW_ERROR' }, 'a code that is not a fixed uppercase code is not echoed')
    c = freshCase()
    assert.deepEqual(await host(options(c, recorder().provider, { installationRoot: makeRoot('return Date.now()') })),
      { exitCode: 3, error: 'NONDETERMINISTIC_WORKFLOW' })
  })

  console.log('== native graph host: run directory, signal, earlier result')

  await test('an existing run directory keeps its mode', async () => {
    const c = freshCase()
    mkdirSync(c.runDir, { mode: 0o750 })
    chmodSync(c.runDir, 0o750)
    assert.equal((await host(options(c, recorder().provider))).exitCode, 0)
    assert.equal(mode(c.runDir), 0o750)
  })

  await test('a run directory path that is a file is exit 3 IO_ERROR with no provider call', async () => {
    const c = freshCase(), { provider, calls } = recorder()
    writeFileSync(c.runDir, 'not a directory\n')
    assert.deepEqual(await host(options(c, provider)), { exitCode: 3, error: 'IO_ERROR' })
    assert.equal(calls.length, 0)
    assert.equal(readFileSync(c.runDir, 'utf8'), 'not a directory\n')
  })

  await test('a signal aborted before the run is exit 3 RUNTIME_ABORTED with no provider call and the lock released', async () => {
    const c = freshCase(), { provider, calls } = recorder()
    assert.deepEqual(await host(options(c, provider, { signal: AbortSignal.abort() })), { exitCode: 3, error: 'RUNTIME_ABORTED' })
    assert.equal(calls.length, 0)
    assert.ok(lockGone(c))
    assert.equal(existsSync(join(c.runDir, 'result.json')), false)
  })

  await test('a failed invocation leaves an earlier result.json byte for byte', async () => {
    const c = freshCase()
    assert.equal((await host(options(c, recorder().provider))).exitCode, 0)
    const before = readFileSync(join(c.runDir, 'result.json'))
    const thrower = recorder(() => { throw new Error('lost') })
    assert.deepEqual(await host(options(c, thrower.provider, { invocationId: 'inv-2' })), { exitCode: 3, error: 'DISPATCH_UNCERTAIN' })
    assert.deepEqual(readFileSync(join(c.runDir, 'result.json')), before)
    // A later successful invocation replaces it.
    assert.equal((await host(options(c, recorder().provider, { invocationId: 'inv-3' }))).exitCode, 0)
    assert.equal(readResult(c).invocationId, 'inv-3')
  })

  console.log('== native graph host: offerings and the provider port')

  await test('harness-repair (an unowned graph) runs for another codex offering, never for an unavailable one', async () => {
    let c = freshCase()
    const outcome = await host(options(c, recorder().provider, { offeringId: 'bughunt' }))
    assert.equal(outcome.exitCode, 0)
    assert.equal(readResult(c).offeringId, 'bughunt')
    c = freshCase()
    assert.deepEqual(await host(options(c, recorder().provider, { offeringId: 'blueprint' })), { exitCode: 2, error: 'OFFERING_UNSUPPORTED' })
    assert.equal(existsSync(c.runDir), false)
  })

  await test('runLeaf runs with this = the caller provider; only the prompt differs from the runtime request', async () => {
    const c = freshCase(), seen = []
    const provider = {
      answer: answerFor,
      async runLeaf(req) { seen.push({ self: this, keys: Object.keys(req) }); return completion(req, this.answer(req)) },
    }
    assert.equal((await host(options(c, provider))).exitCode, 0)
    assert.equal(seen.length, 3)
    for (const call of seen) {
      assert.equal(call.self, provider)
      assert.deepEqual(call.keys, ['callId', 'workflowId', 'workflowPath', 'agentType', 'label', 'phase', 'requestedModel',
        'requestedEffort', 'invocationId', 'prompt', 'selection', 'profile', 'schema', 'wireSchema', 'deadlineMs', 'signal'])
    }
  })

  console.log('== native graph host: option rules')

  await test('paths, provider and signal options outside their rules are INVALID_HOST_INPUT', async () => {
    const { provider } = recorder()
    const getter = Object.defineProperty({}, 'runLeaf', { enumerable: true, get: () => async () => ({}) })
    const bad = [
      ['a control character in runDir', o => ({ ...o, runDir: o.runDir + '\u0085x' })],
      ['a tab in installationRoot', o => ({ ...o, installationRoot: o.installationRoot + '\t' })],
      ['a runDir over 4096 bytes', o => ({ ...o, runDir: '/' + 'a'.repeat(4096) })],
      ['a provider whose runLeaf is a getter', o => ({ ...o, provider: getter })],
      ['a signal key set to undefined', o => ({ ...o, signal: undefined })],
      ['a fractional timeoutMs', o => ({ ...o, timeoutMs: 1.5 })],
      ['an invocation id over 128 characters', o => ({ ...o, invocationId: 'a'.repeat(129) })],
      ['an upper-case workflow id', o => ({ ...o, workflowId: 'Harness-repair' })],
    ]
    for (const [name, mutate] of bad) {
      const c = freshCase()
      assert.deepEqual(await host(mutate(options(c, provider))), { exitCode: 1, error: 'INVALID_HOST_INPUT' }, name)
      assert.equal(existsSync(c.runDir), false, name)
    }
    for (const value of [null, undefined, [], 'options', new Proxy({}, {})]) {
      assert.deepEqual(await host(value), { exitCode: 1, error: 'INVALID_HOST_INPUT' })
    }
  })

  console.log('== native graph host: CLI args file')

  const cliFile = (c, patch = {}) => ({ schemaVersion: 1, installationRoot: BASE, workflowId: 'harness-repair', offeringId: 'blueprint',
    invocationId: 'inv-cli', args: { repo: c.repo }, runDir: c.runDir, codexBin: join(c.dir, 'no-codex'), cwd: c.dir, env: {},
    timeoutMs: 30000, maxConcurrentSubagents: 1, ...patch })
  const cli = argv => spawnSync(process.execPath, [HOST, ...argv], { env: {}, encoding: 'utf8', timeout: 20000 })
  const errorLine = code => JSON.stringify({ error: code }) + '\n'

  await test('timeoutMs is checked against the default graceMs when graceMs is absent', async () => {
    const c = freshCase()
    const tight = join(c.dir, 'tight.json')
    writeFileSync(tight, JSON.stringify(cliFile(c, { timeoutMs: 1000 })))
    let r = cli(['--args-file', tight])
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, '', errorLine('INVALID_HOST_INPUT')])
    // One millisecond more passes input and reaches the offering refusal (blueprint is unavailable).
    const enough = join(c.dir, 'enough.json')
    writeFileSync(enough, JSON.stringify(cliFile(c, { timeoutMs: 1001 })))
    r = cli(['--args-file', enough])
    assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', errorLine('OFFERING_UNSUPPORTED')])
    assert.equal(existsSync(c.runDir), false)
  })

  await test('an args file with an own __proto__ key is refused', async () => {
    const c = freshCase()
    const text = JSON.stringify(cliFile(c)).replace(/^\{/, '{"__proto__":{"schemaVersion":1},')
    const path = join(c.dir, 'proto.json')
    writeFileSync(path, text)
    const r = cli(['--args-file', path])
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, '', errorLine('INVALID_HOST_INPUT')])
  })

  const hasMkfifo = spawnSync('mkfifo', ['--version'], { encoding: 'utf8' }).error?.code !== 'ENOENT'
  await test('a FIFO args file is refused without blocking', { skip: hasMkfifo ? false : 'mkfifo is not installed' }, async () => {
    const c = freshCase()
    const fifo = join(c.dir, 'args.fifo')
    execFileSync('mkfifo', [fifo])
    const started = Date.now()
    const r = cli(['--args-file', fifo])
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, '', errorLine('INVALID_HOST_INPUT')])
    assert.ok(Date.now() - started < 10000)
  })
} finally {
  rmSync(WORK, { recursive: true, force: true })
}
