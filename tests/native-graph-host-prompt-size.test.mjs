// CP-02g implementation edges the frozen acceptance does not pin. A fixture
// harness-repair template (re-pinned in a fixture catalog) runs checker leaves
// whose workflow prompt sizes come from args, so the combined prompt size is set
// exactly from the assembled checker instructions. Covers: a provider with no size
// check of its own is still never called over the limit; a workflow goes on to a
// later leaf after a PROMPT_TOO_LARGE leaf; the runtime's own workflow-prompt limit
// still refuses before any row; and a later invocation in the same run directory
// dispatches normally. Wiring proof with a recording provider: no codex, network or HOME.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { REPO, test } from '../scripts/workflow-harness.mjs'
import { completion, pass } from '../acceptance/native-runtime/nr-02-runtime-support.mjs'
import { assembleRoleInstructions } from '../core/skills/native-runtime/role-files.mjs'

const api = () => import('../core/skills/native-runtime/graph-host.mjs')
const CATALOG = 'spec/offering-capabilities.json'
const WORKFLOW = 'graphs/qa/workflows/harness-repair.js'
const LIMIT = 1048576
const LEAF_FAILED = 'error:Native runtime: LEAF_FAILED.'
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'native-graph-host-prompt-size-')))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// One checker leaf per entry of args.sizes, in order; each prompt is that many ASCII
// bytes. A leaf that throws is recorded and the workflow goes on to the next one.
const BODY = `
const STR = { type: 'string' }
const CHECK = { type: 'object', properties: { verdict: { type: 'string', enum: ['PASS', 'FAIL'] }, verify_block: STR,
  failures: { type: 'array', items: { type: 'object', properties: { step: STR, exit: { type: 'integer' }, error_key: STR,
  excerpt: STR }, required: ['step', 'exit', 'error_key', 'excerpt'] } } }, required: ['verdict', 'verify_block', 'failures'] }
const results = []
for (const size of args.sizes) {
  try {
    const r = await agent('x'.repeat(size), { label: 'check-' + results.length, phase: 'Check', agentType: 'checker',
      model: 'haiku', effort: 'high', schema: CHECK })
    results.push(r ? r.verdict : null)
  } catch (e) { results.push('error:' + e.message) }
}
return { status: 'done', results }
`

// Only what the host reads: the catalog, workflow templates, role files and skill files.
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
    for (const e of entries(`${c}/skills`)) {
      if (!e.isDirectory()) continue
      for (const f of entries(`${c}/skills/${e.name}`)) if (f.isFile()) copy(`${c}/skills/${e.name}/${f.name}`)
    }
  }
}

// A fixture root with dev's codex row partial and the sized-leaf template pinned.
function makeRoot() {
  const root = realpathSync(mkdtempSync(join(WORK, 'root-')))
  copyFixture(root)
  const catalog = JSON.parse(readFileSync(join(root, CATALOG), 'utf8'))
  catalog.offerings.find(o => o.id === 'dev').providers.codex = { implementation: 'partial', transportId: 'codex-autobuild',
    limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] }
  const bytes = `export const meta = {\n  name: 'harness-repair',\n}\n${BODY}\n`
  writeFileSync(join(root, WORKFLOW), bytes)
  catalog.workflows.find(w => w.source === WORKFLOW).sha256 = sha(bytes)
  writeFileSync(join(root, CATALOG), JSON.stringify(catalog, null, 2) + '\n')
  return root
}
const ROOT = makeRoot()
// Bytes the host puts in front of the checker's workflow prompt: instructions + "\n\n".
const OVERHEAD = Buffer.byteLength(assembleRoleInstructions({ installationRoot: ROOT, name: 'checker' }).instructions, 'utf8') + 2
const AT_LIMIT = LIMIT - OVERHEAD
const OVER_LIMIT = AT_LIMIT + 1

const freshCase = () => ({ runDir: join(realpathSync(mkdtempSync(join(WORK, 'case-'))), 'run') })
// No size check of its own: whatever the host forwards, it answers PASS.
function recorder() {
  const calls = []
  const provider = { async runLeaf(req) { calls.push(req); return completion(req, pass()) } }
  return { provider, calls }
}
const options = (c, provider, sizes, patch = {}) => ({ installationRoot: ROOT, workflowId: 'harness-repair', offeringId: 'dev',
  invocationId: 'inv-1', args: { sizes }, runDir: c.runDir, provider, timeoutMs: 30000, maxConcurrentSubagents: 1, ...patch })
async function host(opts) { const { runGraphHost } = await api(); return runGraphHost(opts) }
function rows(c) {
  const dir = join(c.runDir, 'checkpoints')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => /^nr-[0-9a-f]{64}\.json$/.test(name))
    .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')))
}
const rowFor = (c, label) => rows(c).find(row => row.binding.label === label)
function assertPromptTooLarge(row) {
  assert.ok(row, 'no row for the oversize leaf')
  assert.equal(row.state, 'failed')
  const { provider, model, effort } = row.binding.selection
  assert.deepEqual(row.completion, { outcome: 'failed', code: 'PROMPT_TOO_LARGE', usage: null,
    receipt: { provider, model, effort, invocationId: 'host:' + row.callId } })
}

try {
  console.log('== native graph host: oversize combined leaf prompts (CP-02g)')

  await test('the fixture measures exactly: AT_LIMIT reaches the provider as a 1048576-byte combined prompt', async () => {
    const c = freshCase(), { provider, calls } = recorder()
    const outcome = await host(options(c, provider, [AT_LIMIT]))
    assert.deepEqual(outcome, { exitCode: 0, status: 'done', result: { status: 'done', results: ['PASS'] } })
    assert.equal(calls.length, 1)
    assert.equal(Buffer.byteLength(calls[0].prompt, 'utf8'), LIMIT)
    assert.ok(calls[0].prompt.endsWith('\n\n' + 'x'.repeat(AT_LIMIT)), 'the workflow prompt is forwarded whole')
    assert.equal(rowFor(c, 'check-0').state, 'returned')
  })

  await test('a provider with no size check of its own is still never called over the limit', async () => {
    const c = freshCase(), { provider, calls } = recorder()
    const outcome = await host(options(c, provider, [OVER_LIMIT]))
    assert.deepEqual(outcome, { exitCode: 0, status: 'done', result: { status: 'done', results: [LEAF_FAILED] } })
    assert.equal(calls.length, 0)
    assert.equal(rows(c).length, 1)
    assertPromptTooLarge(rowFor(c, 'check-0'))
    assert.equal(existsSync(join(c.runDir, 'checkpoints', '.lock')), false, 'the run lock is released')
  })

  await test('the workflow goes on after a PROMPT_TOO_LARGE leaf: the next leaf dispatches and returns', async () => {
    const c = freshCase(), { provider, calls } = recorder()
    const outcome = await host(options(c, provider, [OVER_LIMIT, 10]))
    assert.deepEqual(outcome.result, { status: 'done', results: [LEAF_FAILED, 'PASS'] })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].label, 'check-1')
    assert.ok(calls[0].prompt.endsWith('\n\n' + 'x'.repeat(10)))
    assertPromptTooLarge(rowFor(c, 'check-0'))
    assert.equal(rowFor(c, 'check-1').state, 'returned')
    assert.ok(!rows(c).some(row => row.state === 'uncertain' || row.state === 'prepared'), 'a call was held')
  })

  // Unchanged runtime behavior: a workflow prompt over the runtime's own limit stops
  // the run before reserve, so the host never sees it and no row is written.
  await test("the runtime's own workflow-prompt limit still stops the run first: no row, no call, no result.json", async () => {
    const c = freshCase(), { provider, calls } = recorder()
    assert.deepEqual(await host(options(c, provider, [LIMIT + 1])), { exitCode: 3, error: 'INVALID_RUNTIME_INPUT' })
    assert.equal(calls.length, 0)
    assert.deepEqual(rows(c), [])
    assert.equal(existsSync(join(c.runDir, 'result.json')), false)
  })

  await test('a later invocation in the same run directory dispatches normally after a PROMPT_TOO_LARGE run', async () => {
    const c = freshCase(), { provider, calls } = recorder()
    assert.equal((await host(options(c, provider, [OVER_LIMIT]))).exitCode, 0)
    const outcome = await host(options(c, provider, [10], { invocationId: 'inv-2' }))
    assert.deepEqual(outcome, { exitCode: 0, status: 'done', result: { status: 'done', results: ['PASS'] } })
    assert.equal(calls.length, 1)
    assert.deepEqual(rows(c).map(row => row.state).sort(), ['failed', 'returned'])
  })
} finally {
  rmSync(WORK, { recursive: true, force: true })
}
