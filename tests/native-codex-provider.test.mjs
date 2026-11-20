// CP-02b implementation edges the frozen acceptance does not pin: symlinked and
// stale files in the run directory, the already-aborted signal, the IO_ERROR
// catch-all, clock and request near-misses, the usage bound and the deadline
// clamp. The child is a stub node script with a minimal explicit environment:
// wiring proof, not runtime certification.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'

const api = () => import('../core/skills/native-runtime/codex-provider.mjs')
const schemaApi = () => import('../core/skills/native-runtime/schema.mjs')
const coded = error => error.code === 'INVALID_RUNTIME_INPUT' && error.message === 'Native runtime: INVALID_RUNTIME_INPUT.'
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'native-codex-provider-')))
const STUB = join(WORK, 'codex-stub')
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0
const wireText = value => JSON.stringify({ json: JSON.stringify(value) })

// Each spawn appends one line to calls.jsonl and runs the step at that index:
// `output` goes to --output-last-message, `events` to stdout, `exit` is the code.
writeFileSync(STUB, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const dir = process.env.STUB_DIR, argv = process.argv.slice(2)
const flag = name => argv[argv.indexOf(name) + 1]
process.stdin.resume()
process.stdin.on('end', () => {
  const calls = path.join(dir, 'calls.jsonl')
  const index = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\\n').filter(Boolean).length : 0
  fs.appendFileSync(calls, JSON.stringify({ argv }) + '\\n')
  const step = JSON.parse(fs.readFileSync(path.join(dir, 'steps.json'), 'utf8'))[index] ?? {}
  if (step.output !== undefined) fs.writeFileSync(flag('--output-last-message'), step.output)
  for (const event of step.events ?? [{ type: 'turn.completed', usage: { input_tokens: 1 } }]) process.stdout.write(JSON.stringify(event) + '\\n')
  process.exit(step.exit ?? 0)
})
`)
chmodSync(STUB, 0o755)

function makeCase() {
  const dir = mkdtempSync(join(WORK, 'case-'))
  const c = { dir, stubDir: join(dir, 'stub'), runDir: join(dir, 'run'), cwd: join(dir, 'cwd') }
  mkdirSync(c.stubDir)
  mkdirSync(c.cwd)
  return c
}
const spawns = c => existsSync(join(c.stubDir, 'calls.jsonl')) ? readFileSync(join(c.stubDir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0
async function provider(c, steps, options = {}) {
  writeFileSync(join(c.stubDir, 'steps.json'), JSON.stringify(steps))
  const { createCodexProvider } = await api()
  return createCodexProvider({ codexBin: STUB, cwd: c.cwd, env: { STUB_DIR: c.stubDir }, runDir: c.runDir, graceMs: 100, ...options })
}
async function request(patch = {}) {
  const { encodeOutputContract } = await schemaApi()
  return {
    callId: 'nr-' + createHash('sha256').update('native-codex-provider').digest('hex'), workflowId: 'harness-repair',
    workflowPath: ['harness-repair'], agentType: 'checker', label: 'check', phase: 'Check', requestedModel: 'haiku',
    requestedEffort: 'high', invocationId: 'inv', prompt: 'PROMPT', selection: { provider: 'codex', model: 'gpt-test', effort: 'high' },
    profile: 'build-workspace', schema: { type: 'object' }, wireSchema: structuredClone(encodeOutputContract({ type: 'object' }).wireSchema),
    deadlineMs: Date.now() + 30_000, signal: new AbortController().signal, ...patch,
  }
}
const fileOf = (c, req, suffix) => join(c.runDir, `${req.callId}.${suffix}`)
function assertFailed(envelope, code) {
  assert.equal(envelope.outcome, 'failed', JSON.stringify(envelope).slice(0, 200))
  assert.equal(envelope.code, code)
}

try {
  await test('a symlink at the schema name is removed, never followed; the new file is 0600', async () => {
    const c = makeCase()
    const req = await request()
    const target = join(c.dir, 'outside.txt')
    writeFileSync(target, 'untouched')
    mkdirSync(c.runDir)
    symlinkSync(target, fileOf(c, req, 'schema.json'))
    assert.equal((await (await provider(c, [{ output: wireText({ ok: 1 }) }])).runLeaf(req)).outcome, 'returned')
    assert.equal(readFileSync(target, 'utf8'), 'untouched')
    const schema = lstatSync(fileOf(c, req, 'schema.json'))
    assert.ok(schema.isFile() && (schema.mode & 0o777) === 0o600)
  })

  await test('a stale 0644 schema file is replaced by a fresh 0600 one', async () => {
    const c = makeCase()
    const req = await request()
    mkdirSync(c.runDir)
    writeFileSync(fileOf(c, req, 'schema.json'), 'stale', { mode: 0o644 })
    await (await provider(c, [{ output: wireText({ ok: 1 }) }])).runLeaf(req)
    assert.equal(statSync(fileOf(c, req, 'schema.json')).mode & 0o777, 0o600)
    assert.equal(readFileSync(fileOf(c, req, 'schema.json'), 'utf8'), JSON.stringify(req.wireSchema))
  })

  await test('an already-aborted signal never classifies a stale log: EXIT_NONZERO, no usage, no spawn', async () => {
    const c = makeCase()
    const controller = new AbortController()
    controller.abort()
    const req = await request({ signal: controller.signal })
    mkdirSync(c.runDir)
    const stale = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9 } }) + '\n'
    writeFileSync(fileOf(c, req, 'log.jsonl'), stale)
    const envelope = await (await provider(c, [{ output: wireText({ ok: 1 }) }])).runLeaf(req)
    assertFailed(envelope, 'EXIT_NONZERO')
    assert.equal(envelope.usage, null)
    assert.equal(spawns(c), 0)
    assert.equal(readFileSync(fileOf(c, req, 'log.jsonl'), 'utf8'), stale)
  })

  await test('IO_ERROR without a spawn: a directory at the output name or at the log name', async () => {
    for (const suffix of ['output.json', 'log.jsonl']) {
      const c = makeCase()
      const req = await request()
      mkdirSync(fileOf(c, req, suffix), { recursive: true })
      assertFailed(await (await provider(c, [{ output: wireText({ ok: 1 }) }])).runLeaf(req), 'IO_ERROR')
      assert.equal(spawns(c), 0, suffix)
    }
  })

  await test('IO_ERROR keeps reported counters: an unreadable output file', { skip: ROOT_USER && 'root reads any mode' }, async () => {
    const c = makeCase()
    const req = await request()
    // A wrapper runs the stub, then makes the output it wrote unreadable to us.
    const wrapper = join(c.dir, 'codex-wrapper')
    writeFileSync(wrapper, `#!/bin/sh\n"${STUB}" "$@"\ncode=$?\n/bin/chmod 000 "${fileOf(c, req, 'output.json')}"\nexit $code\n`)
    chmodSync(wrapper, 0o755)
    const step = { output: wireText({ ok: 1 }), events: [{ type: 'turn.completed', usage: { output_tokens: 3 } }] }
    const envelope = await (await provider(c, [step], { codexBin: wrapper })).runLeaf(req)
    assertFailed(envelope, 'IO_ERROR')
    assert.deepEqual(envelope.usage, { output_tokens: 3 })
  })

  await test('INVALID_WIRE: a UTF-8 BOM and a __proto__ key are not accepted as the wire', async () => {
    for (const output of ['﻿' + wireText({ ok: 1 }), '{"__proto__":{"json":"x"}}', '{"json":"x","__proto__":1}']) {
      const c = makeCase()
      assertFailed(await (await provider(c, [{ output }])).runLeaf(await request()), 'INVALID_WIRE')
    }
  })

  await test('usage keeps MAX_SAFE_INTEGER and zero; drops MAX_SAFE_INTEGER + 1 and non-record usage', async () => {
    const c = makeCase()
    const p = await provider(c, [
      { output: wireText({ ok: 1 }), events: [{ type: 'turn.completed', usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0, cached_input_tokens: Number.MAX_SAFE_INTEGER + 1 } }] },
      { output: wireText({ ok: 1 }), events: [{ type: 'turn.completed', usage: [1, 2] }] },
    ])
    assert.deepEqual((await p.runLeaf(await request())).usage, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 })
    assert.equal((await p.runLeaf(await request())).usage, null)
  })

  await test('a far deadline is clamped to a safe timeout and the leaf still runs', async () => {
    const c = makeCase()
    const envelope = await (await provider(c, [{ output: wireText({ ok: 1 }) }])).runLeaf(await request({ deadlineMs: 1e300 }))
    assert.equal(envelope.outcome, 'returned')
    assert.equal(spawns(c), 1)
  })

  await test('graceMs 0 is accepted; a null-prototype env is accepted and copied', async () => {
    const c = makeCase()
    const env = Object.assign(Object.create(null), { STUB_DIR: c.stubDir })
    writeFileSync(join(c.stubDir, 'steps.json'), JSON.stringify([{ output: wireText({ ok: 1 }) }]))
    const { createCodexProvider } = await api()
    const p = createCodexProvider({ codexBin: STUB, cwd: c.cwd, env, runDir: c.runDir, graceMs: 0 })
    assert.equal((await p.runLeaf(await request())).outcome, 'returned')
  })

  await test('factory rejects NUL in cwd, runDir or env, and a getter option without running it', async () => {
    const { createCodexProvider } = await api()
    const c = makeCase()
    const valid = { codexBin: STUB, cwd: c.cwd, env: {}, runDir: c.runDir }
    let ran = false
    const getter = Object.defineProperty({ ...valid }, 'cwd', { get() { ran = true; return c.cwd }, enumerable: true })
    for (const bad of [{ ...valid, cwd: '/a\0b' }, { ...valid, runDir: '/a\0b' }, { ...valid, env: { A: 'x\0y' } }, { ...valid, env: { 'A\0': 'x' } }, getter]) {
      assert.throws(() => createCodexProvider(bad), coded)
    }
    assert.equal(ran, false)
  })

  await test('clock violations reject before any file: NaN, a string, and a throw even for an unsupported profile', async () => {
    for (const [nowMs, profile] of [[() => NaN, 'build-workspace'], [() => '5', 'build-workspace'], [() => { throw new Error('x') }, 'audit-source-only']]) {
      const c = makeCase()
      await assert.rejects((await provider(c, [], { nowMs })).runLeaf(await request({ profile })), coded)
      assert.equal(existsSync(c.runDir), false)
    }
  })

  await test('request near-misses reject without running a getter or touching a file', async () => {
    let ran = false
    const selection = Object.defineProperty({ provider: 'codex', effort: 'high' }, 'model', { get() { ran = true; return 'm' }, enumerable: true })
    const bad = [
      { selection: { provider: 'codex', model: '-m', effort: 'high' } },
      { selection },
      { wireSchema: { type: 'object', properties: { json: { type: 'string' } }, required: ['json'], additionalProperties: false, extra: 10n } },
      { wireSchema: undefined },
      { signal: Object.create(AbortSignal.prototype) },
      { deadlineMs: Infinity },
      { prompt: 'é'.repeat(524289) },
    ]
    for (const patch of bad) {
      const c = makeCase()
      await assert.rejects((await provider(c, [])).runLeaf(await request(patch)), coded, Object.keys(patch)[0])
      assert.equal(existsSync(c.runDir), false)
    }
    assert.equal(ran, false)
  })

  await test('sandboxForProfile refuses inherited and prototype names', async () => {
    const { sandboxForProfile } = await api()
    for (const name of ['__proto__', 'toString', 'constructor', 'hasOwnProperty']) assert.throws(() => sandboxForProfile(name), coded)
  })

  await test('the run directory holds only the call files after a success', async () => {
    const c = makeCase()
    const req = await request()
    await (await provider(c, [{ output: wireText({ ok: 1 }) }])).runLeaf(req)
    assert.deepEqual(readdirSync(c.runDir).sort(), ['log.jsonl', 'log.jsonl.stderr', 'output.json', 'schema.json'].map(s => `${req.callId}.${s}`).sort())
    assert.equal(statSync(fileOf(c, req, 'output.json')).mode & 0o777, 0o600)
  })
} finally {
  rmSync(WORK, { recursive: true, force: true })
}
