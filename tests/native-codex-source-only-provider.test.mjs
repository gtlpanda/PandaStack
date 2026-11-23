// createCodexProvider's source-only launcher seam and wire mode. The child is a stub node script: wiring proof, not runtime certification.
// Without a launcher the audit profile stays PROFILE_UNSUPPORTED with zero spawns (the frozen CP-02b behavior); with one, the leaf runs the
// launcher's argv/env/cwd, is handed the NR-01 wire schema, answers {"json": text}, and its resources are released whatever happened.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'

const api = () => import('../core/skills/native-runtime/codex-provider.mjs')
const schemaApi = () => import('../core/skills/native-runtime/schema.mjs')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'native-source-only-provider-')))
const STUB = join(WORK, 'codex-stub')
writeFileSync(STUB, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const dir = process.env.STUB_DIR, argv = process.argv.slice(2)
const flag = name => argv[argv.indexOf(name) + 1]
process.stdin.resume()
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), marker: process.env.LEAF_MARKER ?? null, schema: fs.readFileSync(flag('--output-schema'), 'utf8') }) + '\\n')
  const step = JSON.parse(fs.readFileSync(path.join(dir, 'step.json'), 'utf8'))
  if (step.output !== undefined) fs.writeFileSync(flag('--output-last-message'), step.output)
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }) + '\\n')
  process.exit(step.exit ?? 0)
})
`)
chmodSync(STUB, 0o755)
const LEAF_SCHEMA = { type: 'object', properties: { ok: { type: 'integer' }, note: { type: 'string' } }, required: ['ok'] }   // an optional property: the strict subset cannot take it

function makeCase(output, extra = {}) {
  const dir = mkdtempSync(join(WORK, 'case-')), c = { dir, stubDir: join(dir, 'stub'), runDir: join(dir, 'run'), cwd: join(dir, 'cwd'), leafCwd: join(dir, 'leaf-cwd') }
  for (const d of [c.stubDir, c.cwd, c.leafCwd]) mkdirSync(d)
  writeFileSync(join(c.stubDir, 'step.json'), JSON.stringify({ output, ...extra }))
  return c
}
const spawns = c => (existsSync(join(c.stubDir, 'calls.jsonl')) ? readFileSync(join(c.stubDir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
async function request(patch = {}) {
  const { encodeOutputContract } = await schemaApi()
  return { callId: 'nr-' + createHash('sha256').update('source-only-provider').digest('hex'), workflowId: 'security-audit-flow', workflowPath: ['security-audit-flow'],
    agentType: 'audit-researcher', label: 'c1', phase: 'Critic', requestedModel: 'sonnet', requestedEffort: 'high', invocationId: 'inv', prompt: 'PROMPT',
    selection: { provider: 'codex', model: 'gpt-test', effort: 'high' }, profile: 'audit-source-only', schema: structuredClone(LEAF_SCHEMA),
    wireSchema: structuredClone(encodeOutputContract({ type: 'object' }).wireSchema), deadlineMs: Date.now() + 30000, signal: new AbortController().signal, ...patch }
}
async function make(c, launcher) {
  const { createCodexProvider } = await api()
  return createCodexProvider({ codexBin: STUB, cwd: c.cwd, env: { STUB_DIR: c.stubDir }, runDir: c.runDir, graceMs: 100 }, launcher === undefined ? undefined : { 'audit-source-only': launcher })
}
const launcherFor = (c, released) => async ({ files }) => ({ args: ['exec', '--output-last-message', files.outputFile, '--output-schema', files.schemaFile, '-'],
  env: { STUB_DIR: c.stubDir, LEAF_MARKER: 'from-launcher' }, cwd: c.leafCwd, release: () => { released.push(1) } })

await test('without a launcher the audit profile is PROFILE_UNSUPPORTED with zero spawns, as before', async () => {
  const c = makeCase('{}')
  const envelope = await (await make(c)).runLeaf(await request())
  assert.deepEqual([envelope.outcome, envelope.code], ['failed', 'PROFILE_UNSUPPORTED'])
  assert.equal(spawns(c).length, 0)
  assert.ok(!existsSync(c.runDir))
})

await test('with a launcher the leaf runs its argv, env and cwd, gets the wire schema, and answers {json}; the optional-property schema is no obstacle', async () => {
  const c = makeCase(JSON.stringify({ json: JSON.stringify({ ok: 1 }) })), released = []
  const { encodeOutputContract } = await schemaApi()
  const envelope = await (await make(c, launcherFor(c, released))).runLeaf(await request())
  assert.equal(envelope.outcome, 'returned')
  assert.deepEqual(envelope.wire, { json: '{"ok":1}' })
  const [call] = spawns(c)
  assert.equal(call.cwd, c.leafCwd); assert.equal(call.marker, 'from-launcher')
  assert.equal(call.schema, JSON.stringify(encodeOutputContract({ type: 'object' }).wireSchema))
  assert.equal(released.length, 1)
})

await test('a wire answer that is not exactly {json: string} is INVALID_WIRE, and the resource is still released', async () => {
  for (const output of ['{"json": 3}', '{"json": "x", "extra": 1}', '{}', '[]', 'not json', '"x"', '{"ok":1}']) {
    const c = makeCase(output), released = []
    const envelope = await (await make(c, launcherFor(c, released))).runLeaf(await request())
    assert.deepEqual([envelope.outcome, envelope.code], ['failed', 'INVALID_WIRE'], output)
    assert.equal(released.length, 1, output)
  }
})

await test('a launcher that refuses fails the leaf with its code and no spawn; one that throws is IO_ERROR; a release that throws changes nothing', async () => {
  const c = makeCase('{}')
  const refused = await (await make(c, async () => ({ code: 'PROFILE_UNSUPPORTED' }))).runLeaf(await request())
  assert.deepEqual([refused.outcome, refused.code], ['failed', 'PROFILE_UNSUPPORTED'])
  const threw = await (await make(c, async () => { throw new Error('boom') })).runLeaf(await request())
  assert.deepEqual([threw.outcome, threw.code], ['failed', 'IO_ERROR'])
  const unknown = await (await make(c, async () => ({ code: 'NOT_A_CODE' }))).runLeaf(await request())
  assert.equal(unknown.code, 'IO_ERROR')
  assert.equal(spawns(c).length, 0)
  const ok = makeCase(JSON.stringify({ json: '{"ok":1}' }))
  const launch = launcherFor(ok, [])
  const survived = await (await make(ok, async a => ({ ...(await launch(a)), release() { throw new Error('release failed') } }))).runLeaf(await request())
  assert.equal(survived.outcome, 'returned')
})

await test('the launcher serves only the audit profile: a source-review leaf never uses it, and bad launcher tables are refused at creation', async () => {
  const c = makeCase(JSON.stringify({ ok: 1 }))
  let used = 0
  const provider = await make(c, async () => { used++; return { code: 'PROFILE_UNSUPPORTED' } })
  const envelope = await provider.runLeaf(await request({ profile: 'source-review', agentType: 'reviewer', workflowId: 'harness-repair', workflowPath: ['harness-repair'], schema: { type: 'object', properties: { ok: { type: 'integer' } }, required: ['ok'] } }))
  assert.equal(used, 0)
  assert.equal(envelope.outcome, 'returned')
  assert.ok(spawns(c)[0].argv.includes('read-only') && !spawns(c)[0].argv.includes('--ephemeral'), 'the ordinary argv')
  const { createCodexProvider } = await api()
  const base = { codexBin: STUB, cwd: c.cwd, env: {}, runDir: c.runDir }
  for (const bad of [{ 'source-review': async () => ({}) }, { 'audit-source-only': 'x' }, [], 'x', { 'audit-source-only': async () => ({}), extra: 1 }]) assert.throws(() => createCodexProvider(base, bad), e => e.code === 'INVALID_RUNTIME_INPUT')
})
