// CP-02b frozen acceptance: Codex leaf provider on the NR-01 wire
// (spec/contracts/codex-parity-cp-02b.md). Wiring proof, not runtime
// certification: no real codex, no network, no HOME dependence. The `codex`
// child is a stub executable (a small node script) created in an owned temp
// directory, and every run passes a minimal explicit environment. Runtime cases
// drive the real runtime.mjs and real graph templates, the only owners of
// `completionFor` and NR-01 decode.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, fixture, pass, review, reconArgs } from '../native-runtime/nr-02-runtime-support.mjs'

const url = path => pathToFileURL(resolve(ROOT, path)).href
const loadProvider = () => import(url('core/skills/native-runtime/codex-provider.mjs'))
const loadExec = () => import(url('core/skills/native-runtime/codex-exec.mjs'))
const loadRuntime = () => import(url('core/skills/native-runtime/runtime.mjs'))
const loadSchema = () => import(url('core/skills/native-runtime/schema.mjs'))

const MIB = 1048576
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const PROVIDER_CODES = ['PROVIDER_REFUSAL', 'USAGE_LIMIT', 'AUTH', 'BILLING', 'TURN_FAILED', 'EXIT_NONZERO', 'TIMEOUT',
  'NO_OUTPUT', 'INVALID_WIRE', 'PROFILE_UNSUPPORTED', 'IO_ERROR']
const DOLLAR_KEY = /usd|cost|dollar|price|spend|amount/i
const REFUSAL = 'This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing.'
const sha = value => createHash('sha256').update(value).digest('hex')
const code = expected => error => error?.code === expected
// The runtime's own fixed message: never a path, prompt or request value.
const FIXED_MESSAGE = 'Native runtime: INVALID_RUNTIME_INPUT.'

// ------------------------------------------------------------------- the stub
// Each spawn takes the next step from <STUB_DIR>/steps.json (by call count) and
// appends one record to <STUB_DIR>/calls.jsonl. STUB_DIR is never the runDir.
// Step fields:
//   events      protocol lines to print (default: one turn.completed with usage)
//   output      text written to the --output-last-message path; when the
//               --output-schema file is not the NR-01 wire schema (CP-02h) and
//               the text is exactly {"json": <string>}, the inner string is
//               written instead (the bare object that schema asks for)
//   outputFrom  file whose bytes are copied there (large or binary outputs)
//   outputKind  'dir' | 'symlink' | 'fifo' instead of a file
//   exit        exit code (default 0)
//   hang        never exit; `trap` also ignores SIGTERM
const NR01_WIRE = JSON.stringify({ type: 'object', properties: { json: { type: 'string' } }, required: ['json'], additionalProperties: false })
const STUB_SOURCE = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process')
const dir = process.env.STUB_DIR
const argv = process.argv.slice(2)
const flag = name => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1] }
const chunks = []
process.stdin.on('data', c => chunks.push(c))
process.stdin.on('end', () => {
  const callsFile = path.join(dir, 'calls.jsonl')
  const index = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\\n').filter(Boolean).length : 0
  const step = JSON.parse(fs.readFileSync(path.join(dir, 'steps.json'), 'utf8'))[index]
  const schemaFile = flag('--output-schema')
  const schema = schemaFile && fs.existsSync(schemaFile) ? fs.readFileSync(schemaFile, 'utf8') : null
  fs.appendFileSync(callsFile, JSON.stringify({ argv, cwd: process.cwd(), env: { ...process.env }, pid: process.pid,
    stdin: Buffer.concat(chunks).toString('utf8'), schema }) + '\\n')
  if (!step) process.exit(97)
  if (step.trap) process.on('SIGTERM', () => {})
  if (step.hang) { fs.writeFileSync(path.join(dir, 'ready'), String(process.pid)); setInterval(() => {}, 1000); return }
  const out = flag('--output-last-message')
  if (step.output !== undefined) fs.writeFileSync(out, followSchema(step.output, schema))
  if (step.outputFrom !== undefined) fs.copyFileSync(step.outputFrom, out)
  if (step.outputKind === 'dir') fs.mkdirSync(out)
  if (step.outputKind === 'symlink') fs.symlinkSync(step.target, out)
  if (step.outputKind === 'fifo') cp.execFileSync('/usr/bin/mkfifo', [out])
  for (const event of step.events ?? [{ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }]) {
    process.stdout.write(JSON.stringify(event) + '\\n')
  }
  process.exit(step.exit ?? 0)
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

let WORK, STUB
before(() => {
  WORK = realpathSync(mkdtempSync(join(tmpdir(), 'cp-02b-')))
  STUB = join(WORK, 'codex-stub')
  writeFileSync(STUB, STUB_SOURCE)
  chmodSync(STUB, 0o755)
})
after(() => rmSync(WORK, { recursive: true, force: true }))

const sleep = ms => new Promise(done => setTimeout(done, ms))
async function until(check, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (check()) return true
  return check()
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }

// One owned directory per case: stub records, the provider's runDir (not created
// up front), and the leaf cwd.
function makeCase() {
  const dir = mkdtempSync(join(WORK, 'case-'))
  const c = { dir, stubDir: join(dir, 'stub'), runDir: join(dir, 'run'), cwd: join(dir, 'cwd') }
  mkdirSync(c.stubDir)
  mkdirSync(c.cwd)
  return c
}
const calls = c => {
  const file = join(c.stubDir, 'calls.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
const argValue = (argv, name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1] }
function filesUnder(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(full) : entry.isFile() ? [full] : []
  })
}

async function makeProvider(c, steps, { env = {}, options = {} } = {}) {
  writeFileSync(join(c.stubDir, 'steps.json'), JSON.stringify(steps))
  const { createCodexProvider } = await loadProvider()
  return createCodexProvider({ codexBin: STUB, cwd: c.cwd, env: { STUB_DIR: c.stubDir, ...env }, runDir: c.runDir,
    graceMs: 200, ...options })
}

// ---------------------------------------------------------------- the request
const PROMPT = 'CP02B-PROMPT-SENTINEL line one\nline two: é ✓ "quoted" \\ end'
const SELECTION = Object.freeze({ provider: 'codex', model: 'gpt-test.1', effort: 'high' })
const LEAF_SCHEMA = { type: 'object', properties: { verdict: { type: 'string', enum: ['PASS', 'FAIL'] } }, required: ['verdict'] }
let WIRE
const wireSchema = async () => {
  WIRE ??= JSON.parse(JSON.stringify((await loadSchema()).encodeOutputContract(LEAF_SCHEMA).wireSchema))
  return structuredClone(WIRE)
}
const callIdOf = name => 'nr-' + sha(`cp-02b-${name}`)
async function request(patch = {}) {
  return {
    callId: callIdOf('leaf'), workflowId: 'harness-repair', workflowPath: ['harness-repair'], agentType: 'checker',
    label: 'check', phase: 'Check', requestedModel: 'haiku', requestedEffort: 'high', invocationId: 'inv-cp-02b',
    prompt: PROMPT, selection: { ...SELECTION }, profile: 'build-workspace', schema: structuredClone(LEAF_SCHEMA),
    wireSchema: await wireSchema(), deadlineMs: Date.now() + 30_000, signal: new AbortController().signal, ...patch,
  }
}
const wireText = value => JSON.stringify({ json: JSON.stringify(value) })

// ---------------------------------------------------------- envelope checks
function keysDeep(value, found = []) {
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { found.push(key); keysDeep(item, found) }
  return found
}
function assertCommon(envelope, req) {
  assert.deepEqual(envelope.receipt, { ...req.selection, invocationId: req.callId })
  assert.ok(envelope.usage === null || (typeof envelope.usage === 'object' && !Array.isArray(envelope.usage)))
  assert.deepEqual(keysDeep(envelope).filter(key => DOLLAR_KEY.test(key)), [], 'a dollar-like field was emitted')
  assert.ok(!JSON.stringify(envelope).includes('CP02B-PROMPT-SENTINEL'), 'the prompt reached the envelope')
}
function assertFailed(envelope, expected, req) {
  assert.equal(envelope.outcome, 'failed', JSON.stringify(envelope).slice(0, 300))
  assert.deepEqual(Object.keys(envelope).sort(), ['code', 'outcome', 'receipt', 'usage'])
  assert.equal(envelope.code, expected)
  assert.match(envelope.code, CODE_PATTERN)
  assertCommon(envelope, req)
}
function assertReturned(envelope, json, req) {
  assert.equal(envelope.outcome, 'returned', JSON.stringify(envelope).slice(0, 300))
  assert.deepEqual(Object.keys(envelope).sort(), ['outcome', 'receipt', 'usage', 'wire'])
  assert.deepEqual(Object.keys(envelope.wire), ['json'])
  assert.equal(envelope.wire.json, json)
  assertCommon(envelope, req)
}
// The prompt is never written by the provider: no file under runDir holds it.
function assertNoPromptOnDisk(c) {
  for (const file of filesUnder(c.runDir)) {
    assert.ok(!readFileSync(file).toString('utf8').includes('CP02B-PROMPT-SENTINEL'), `prompt found in ${file}`)
  }
}
async function runLeaf(provider, req) {
  const pending = provider.runLeaf(req)
  assert.ok(pending instanceof Promise, 'runLeaf is async')
  return pending
}

// ===================================================================== tests
describe('CP-02b helpers (self-checks, pass on main)', () => {
  test('stub executes with an empty environment and records its call', () => {
    const c = makeCase()
    writeFileSync(join(c.stubDir, 'steps.json'), JSON.stringify([{ output: 'x' }]))
    const out = join(c.dir, 'o')
    const ran = spawnSync(STUB, ['exec', '--output-last-message', out, '-'], { env: { STUB_DIR: c.stubDir }, input: 'hi' })
    assert.equal(ran.status, 0)
    assert.equal(readFileSync(out, 'utf8'), 'x')
    assert.equal(calls(c)[0].stdin, 'hi')
  })
})

describe('CP-02b exports (wiring proof, not runtime certification)', () => {
  test('exactly four exports with the pinned names', async () => {
    const mod = await loadProvider()
    assert.deepEqual(Object.keys(mod).sort(), ['CODEX_PROVIDER', 'CODEX_PROVIDER_CODES', 'createCodexProvider', 'sandboxForProfile'])
    assert.equal(mod.CODEX_PROVIDER, 'codex')
    assert.equal(typeof mod.createCodexProvider, 'function')
  })

  // The closed set is pinned by CP-02h's test (it adds SCHEMA_UNSUPPORTED).
  test('CODEX_PROVIDER_CODES is frozen and holds the CP-02a failure codes plus three', async () => {
    const { CODEX_PROVIDER_CODES } = await loadProvider()
    const { CODEX_EXEC_CODES } = await loadExec()
    for (const name of PROVIDER_CODES) assert.equal(CODEX_PROVIDER_CODES[name], name)
    for (const [key, value] of Object.entries(CODEX_PROVIDER_CODES)) { assert.equal(value, key); assert.match(value, CODE_PATTERN) }
    for (const execCode of Object.values(CODEX_EXEC_CODES)) assert.equal(Object.hasOwn(CODEX_PROVIDER_CODES, execCode), execCode !== 'SUCCESS')
    assert.ok(Object.isFrozen(CODEX_PROVIDER_CODES))
    assert.throws(() => { CODEX_PROVIDER_CODES.EXTRA = 'EXTRA' })
  })

  test('sandboxForProfile maps every runtime profile and refuses anything else', async () => {
    const { sandboxForProfile } = await loadProvider()
    const { PROFILES } = await loadRuntime()
    const expected = { 'source-review': 'read-only', 'build-workspace': 'workspace-write', 'audit-source-only': null, 'release-controlled': null }
    assert.deepEqual([...PROFILES].sort(), Object.keys(expected).sort())
    for (const profile of PROFILES) assert.equal(sandboxForProfile(profile), expected[profile])
    for (const bad of ['full-access', 'danger-full-access', '', undefined, null, 5, ['source-review'], 'Source-Review']) {
      assert.throws(() => sandboxForProfile(bad), code('INVALID_RUNTIME_INPUT'))
    }
  })
})

describe('CP-02b factory (wiring proof, not runtime certification)', () => {
  test('provider is a frozen plain object with only runLeaf; the factory touches no file', async () => {
    const c = makeCase()
    const provider = await makeProvider(c, [])
    assert.equal(Object.getPrototypeOf(provider), Object.prototype)
    assert.deepEqual(Object.keys(provider), ['runLeaf'])
    assert.ok(Object.isFrozen(provider))
    assert.equal(typeof Object.getOwnPropertyDescriptor(provider, 'runLeaf').value, 'function')
    assert.equal(existsSync(c.runDir), false)
    assert.deepEqual(calls(c), [])
  })

  test('runLeaf does not depend on this', async () => {
    const c = makeCase()
    const { runLeaf: detached } = await makeProvider(c, [{ output: wireText({ verdict: 'PASS' }) }])
    const req = await request()
    assertReturned(await detached.call(undefined, req), JSON.stringify({ verdict: 'PASS' }), req)
  })

  const valid = c => ({ codexBin: STUB, cwd: c.cwd, env: { STUB_DIR: c.stubDir }, runDir: c.runDir })
  const badFactory = [
    ['no argument', () => undefined],
    ['missing codexBin', c => ({ ...valid(c), codexBin: undefined })],
    ['relative codexBin', c => ({ ...valid(c), codexBin: 'codex' })],
    ['codexBin with NUL', c => ({ ...valid(c), codexBin: '/x\0y' })],
    ['relative cwd', c => ({ ...valid(c), cwd: 'cwd' })],
    ['missing env', c => ({ ...valid(c), env: undefined })],
    ['env with a non-string value', c => ({ ...valid(c), env: { STUB_DIR: c.stubDir, N: 1 } })],
    ['relative runDir', c => ({ ...valid(c), runDir: 'run' })],
    ['negative graceMs', c => ({ ...valid(c), graceMs: -1 })],
    ['fractional graceMs', c => ({ ...valid(c), graceMs: 0.5 })],
    ['non-boolean skipGitRepoCheck', c => ({ ...valid(c), skipGitRepoCheck: 'yes' })],
    ['non-function nowMs', c => ({ ...valid(c), nowMs: 5 })],
    ['unknown key', c => ({ ...valid(c), timeoutMs: 1000 })],
    ['class instance', c => Object.assign(Object.create({ inherited: 1 }), valid(c))],
  ]
  for (const [name, make] of badFactory) {
    test(`factory rejects ${name} with INVALID_RUNTIME_INPUT and touches nothing`, async () => {
      const { createCodexProvider } = await loadProvider()
      const c = makeCase()
      assert.throws(() => createCodexProvider(make(c)), error => error.code === 'INVALID_RUNTIME_INPUT' && error.message === FIXED_MESSAGE)
      assert.equal(existsSync(c.runDir), false)
    })
  }

  test('the child environment is the factory snapshot minus CODEX_THREAD_ID; nothing is added', async () => {
    const c = makeCase()
    const env = { STUB_DIR: c.stubDir, MARK: 'kept', CODEX_THREAD_ID: 'parent-thread' }
    const { createCodexProvider } = await loadProvider()
    writeFileSync(join(c.stubDir, 'steps.json'), JSON.stringify([{ output: wireText({ verdict: 'PASS' }) }]))
    const provider = createCodexProvider({ codexBin: STUB, cwd: c.cwd, env, runDir: c.runDir, graceMs: 200 })
    env.MARK = 'changed'
    env.LATE = 'added'
    await runLeaf(provider, await request())
    const seen = calls(c)[0].env
    // macOS adds __CF_USER_TEXT_ENCODING inside every new process; it is not ours.
    assert.deepEqual(Object.keys(seen).filter(key => key !== '__CF_USER_TEXT_ENCODING').sort(), ['MARK', 'STUB_DIR'])
    assert.equal(seen.MARK, 'kept')
    assert.equal(env.CODEX_THREAD_ID, 'parent-thread')
  })
})

describe('CP-02b runLeaf success (wiring proof, not runtime certification)', () => {
  test('one spawn: schema file, output file, stdin prompt, receipt and private files', async () => {
    const c = makeCase()
    const json = JSON.stringify({ verdict: 'PASS', note: 'é ✓' })
    const provider = await makeProvider(c, [{ output: JSON.stringify({ json }) }])
    const req = await request()
    const envelope = await runLeaf(provider, req)
    assertReturned(envelope, json, req)
    assert.deepEqual(envelope.usage, { input_tokens: 1, output_tokens: 1 })

    const [call, ...rest] = calls(c)
    assert.equal(rest.length, 0, 'exactly one spawn')
    const schemaFile = join(c.runDir, `${req.callId}.schema.json`)
    const outputFile = join(c.runDir, `${req.callId}.output.json`)
    const logFile = join(c.runDir, `${req.callId}.log.jsonl`)
    assert.equal(argValue(call.argv, '--output-schema'), schemaFile)
    assert.equal(argValue(call.argv, '--output-last-message'), outputFile)
    // The schema the child saw is the file the provider wrote (its bytes: CP-02h).
    assert.equal(call.schema, readFileSync(schemaFile, 'utf8'))
    assert.equal(call.stdin, PROMPT)
    assert.equal(realpathSync(call.cwd), realpathSync(c.cwd))
    assert.equal(call.argv[0], 'exec')
    assert.equal(call.argv.at(-1), '-')
    assert.equal(call.argv.filter(a => a === '--ignore-user-config').length, 1)
    assert.equal(argValue(call.argv, '--sandbox'), 'workspace-write')
    assert.equal(argValue(call.argv, '--model'), SELECTION.model)
    assert.ok(call.argv.includes('model_reasoning_effort="high"'))
    assert.ok(!call.argv.includes('--skip-git-repo-check'))
    assert.ok(!call.argv.some(a => a.includes('CP02B-PROMPT-SENTINEL')), 'prompt in argv')

    assert.deepEqual(readdirSync(c.runDir).sort(),
      [`${req.callId}.log.jsonl`, `${req.callId}.log.jsonl.stderr`, `${req.callId}.output.json`, `${req.callId}.schema.json`].sort())
    assert.equal(statSync(c.runDir).mode & 0o777, 0o700)
    for (const file of [schemaFile, outputFile, logFile]) assert.equal(statSync(file).mode & 0o077, 0, `${file} is private`)
    assertNoPromptOnDisk(c)
  })

  test('source-review runs read-only; skipGitRepoCheck is passed through', async () => {
    const c = makeCase()
    const provider = await makeProvider(c, [{ output: wireText({ verdict: 'PASS' }) }], { options: { skipGitRepoCheck: true } })
    const req = await request({ profile: 'source-review' })
    assertReturned(await runLeaf(provider, req), JSON.stringify({ verdict: 'PASS' }), req)
    const [call] = calls(c)
    assert.equal(argValue(call.argv, '--sandbox'), 'read-only')
    assert.ok(call.argv.includes('--skip-git-repo-check'))
  })

  // Unparseable inner JSON was retired by CP-02h: Codex now writes a bare object.
  test('semantically invalid JSON is still returned, unchanged', async () => {
    for (const json of [JSON.stringify({ verdict: 'MAYBE' })]) {
      const c = makeCase()
      const provider = await makeProvider(c, [{ output: JSON.stringify({ json }) }])
      const req = await request()
      assertReturned(await runLeaf(provider, req), json, req)
    }
  })

  test('usage keeps only the four token counters; dollar and other fields are dropped', async () => {
    const c = makeCase()
    const usage = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1, total_cost_usd: 1.5,
      cost_usd: 2, price: 3, estimated_dollars: 4, input_tokens_details: { cached_tokens: 1 }, other_tokens: 7 }
    const provider = await makeProvider(c, [{ output: wireText({ verdict: 'PASS' }), events: [{ type: 'turn.completed', usage }] }])
    const req = await request()
    const envelope = await runLeaf(provider, req)
    assertReturned(envelope, JSON.stringify({ verdict: 'PASS' }), req)
    assert.deepEqual(envelope.usage, { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1 })
  })

  test('usage with no valid counter is null', async () => {
    const c = makeCase()
    const usage = { input_tokens: -1, output_tokens: 1.5, cached_input_tokens: '3', reasoning_output_tokens: 2 ** 60, total_cost_usd: 0 }
    const provider = await makeProvider(c, [
      { output: wireText({ verdict: 'PASS' }), events: [{ type: 'turn.completed', usage }] },
      { output: wireText({ verdict: 'PASS' }), events: [{ type: 'turn.completed' }] },
    ])
    for (const name of ['bad', 'none']) {
      const req = await request({ callId: callIdOf(name) })
      const envelope = await runLeaf(provider, req)
      assertReturned(envelope, JSON.stringify({ verdict: 'PASS' }), req)
      assert.equal(envelope.usage, null)
    }
  })

  test('an envelope of exactly 1 MiB is returned', async () => {
    const c = makeCase()
    const req = await request()
    const usage = { input_tokens: 1, output_tokens: 1 }
    const shaped = n => JSON.stringify({ verdict: 'x'.repeat(n) })
    const overhead = Buffer.byteLength(JSON.stringify({ outcome: 'returned', wire: { json: shaped(0) }, usage, receipt: { ...req.selection, invocationId: req.callId } }))
    const json = shaped(MIB - overhead)
    const provider = await makeProvider(c, [{ output: JSON.stringify({ json }) }])
    const envelope = await runLeaf(provider, req)
    assertReturned(envelope, json, req)
    assert.equal(Buffer.byteLength(JSON.stringify(envelope)), MIB)
  })
})

// Each row: one stub step and the fixed code it must give, with exactly one spawn.
// CP-02h retired three rows (a bare result, a non-string json, an extra key): the
// provider now wraps a bare object, so those outputs are no longer failures.
const FAILURES = [
  { name: 'non-zero exit with no protocol result', step: { events: [], exit: 3 }, code: 'EXIT_NONZERO' },
  { name: 'turn.completed then a non-zero exit', step: { output: wireText({ verdict: 'PASS' }), exit: 2 }, code: 'EXIT_NONZERO' },
  { name: 'turn.failed', step: { events: [{ type: 'turn.failed', error: { message: 'stub failure' } }], exit: 1 }, code: 'TURN_FAILED' },
  { name: 'turn.failed even with an output file and exit 0', step: { output: wireText({ verdict: 'PASS' }), events: [{ type: 'turn.failed', error: { message: 'x' } }] }, code: 'TURN_FAILED' },
  { name: 'provider refusal', step: { events: [{ type: 'error', message: REFUSAL }, { type: 'turn.failed', error: { message: REFUSAL } }], exit: 1 }, code: 'PROVIDER_REFUSAL' },
  { name: 'usage limit', step: { events: [{ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } }], exit: 1 }, code: 'USAGE_LIMIT' },
  { name: 'no protocol result at exit 0', step: { events: [] }, code: 'NO_OUTPUT' },
  { name: 'turn.completed but no output file', step: {}, code: 'NO_OUTPUT' },
  { name: 'empty output file', step: { output: '' }, code: 'NO_OUTPUT' },
  { name: 'output that is not JSON', step: { output: 'hello' }, code: 'INVALID_WIRE' },
  { name: 'an array', step: { output: JSON.stringify(['json']) }, code: 'INVALID_WIRE' },
  { name: 'null', step: { output: 'null' }, code: 'INVALID_WIRE' },
  { name: 'output that is a directory', step: { outputKind: 'dir' }, code: 'INVALID_WIRE' },
]

describe('CP-02b runLeaf failures resolve failed envelopes (wiring proof, not runtime certification)', () => {
  for (const row of FAILURES) {
    test(`${row.code}: ${row.name}`, async () => {
      const c = makeCase()
      const provider = await makeProvider(c, [row.step])
      const req = await request()
      const envelope = await runLeaf(provider, req)
      assertFailed(envelope, row.code, req)
      assert.equal(calls(c).length, 1, 'exactly one spawn, no retry')
      assertNoPromptOnDisk(c)
    })
  }

  test('INVALID_WIRE: output that is not valid UTF-8', async () => {
    const c = makeCase()
    const source = join(c.stubDir, 'bad-utf8')
    writeFileSync(source, Buffer.concat([Buffer.from('{"json":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]))
    const provider = await makeProvider(c, [{ outputFrom: source }])
    const req = await request()
    assertFailed(await runLeaf(provider, req), 'INVALID_WIRE', req)
  })

  test('INVALID_WIRE: an output symlink is not followed, even to a valid wire file', async () => {
    const c = makeCase()
    const target = join(c.stubDir, 'elsewhere.json')
    writeFileSync(target, wireText({ verdict: 'PASS' }))
    const provider = await makeProvider(c, [{ outputKind: 'symlink', target }])
    const req = await request()
    assertFailed(await runLeaf(provider, req), 'INVALID_WIRE', req)
  })

  test('INVALID_WIRE: an output FIFO is refused without blocking', { skip: !existsSync('/usr/bin/mkfifo') && 'no /usr/bin/mkfifo', timeout: 10_000 }, async () => {
    const c = makeCase()
    const provider = await makeProvider(c, [{ outputKind: 'fifo' }])
    const req = await request()
    assertFailed(await runLeaf(provider, req), 'INVALID_WIRE', req)
  })

  test('INVALID_WIRE: an output file over 1 MiB, even when its wire is small', async () => {
    const c = makeCase()
    const source = join(c.stubDir, 'padded.json')
    writeFileSync(source, wireText({ verdict: 'PASS' }) + ' '.repeat(MIB))
    const provider = await makeProvider(c, [{ outputFrom: source }])
    const req = await request()
    assertFailed(await runLeaf(provider, req), 'INVALID_WIRE', req)
  })

  test('INVALID_WIRE: a file under 1 MiB whose envelope would be over 1 MiB', async () => {
    const c = makeCase()
    const req = await request()
    const usage = { input_tokens: 1, output_tokens: 1 }
    const shaped = n => JSON.stringify({ verdict: 'x'.repeat(n) })
    const overhead = Buffer.byteLength(JSON.stringify({ outcome: 'returned', wire: { json: shaped(0) }, usage, receipt: { ...req.selection, invocationId: req.callId } }))
    const json = shaped(MIB - overhead + 1)
    assert.ok(Buffer.byteLength(JSON.stringify({ json })) <= MIB)
    const provider = await makeProvider(c, [{ output: JSON.stringify({ json }) }])
    assertFailed(await runLeaf(provider, req), 'INVALID_WIRE', req)
  })

  test('NO_OUTPUT: a stale output file from an earlier attempt is never read', async () => {
    const c = makeCase()
    const req = await request()
    mkdirSync(c.runDir, { recursive: true })
    writeFileSync(join(c.runDir, `${req.callId}.output.json`), wireText({ verdict: 'PASS' }))
    writeFileSync(join(c.runDir, `${req.callId}.schema.json`), 'stale')
    const provider = await makeProvider(c, [{}])
    assertFailed(await runLeaf(provider, req), 'NO_OUTPUT', req)
    assert.notEqual(calls(c)[0].schema, 'stale')
    assert.equal(calls(c)[0].schema, readFileSync(join(c.runDir, `${req.callId}.schema.json`), 'utf8'))
  })

  test('failed runs keep reported token counters', async () => {
    const c = makeCase()
    const provider = await makeProvider(c, [{ events: [{ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2, total_cost_usd: 9 } }], exit: 2 }])
    const req = await request()
    const envelope = await runLeaf(provider, req)
    assertFailed(envelope, 'EXIT_NONZERO', req)
    assert.deepEqual(envelope.usage, { input_tokens: 4, output_tokens: 2 })
  })

  test('EXIT_NONZERO: a missing codex binary', async () => {
    const c = makeCase()
    const { createCodexProvider } = await loadProvider()
    const provider = createCodexProvider({ codexBin: join(c.dir, 'no-such-codex'), cwd: c.cwd, env: {}, runDir: c.runDir })
    const req = await request()
    assertFailed(await runLeaf(provider, req), 'EXIT_NONZERO', req)
  })

  test('IO_ERROR: an unusable runDir, with no spawn', async () => {
    const c = makeCase()
    writeFileSync(join(c.dir, 'a-file'), 'x')
    const { createCodexProvider } = await loadProvider()
    writeFileSync(join(c.stubDir, 'steps.json'), JSON.stringify([{ output: wireText({ verdict: 'PASS' }) }]))
    const provider = createCodexProvider({ codexBin: STUB, cwd: c.cwd, env: { STUB_DIR: c.stubDir }, runDir: join(c.dir, 'a-file', 'run') })
    const req = await request()
    assertFailed(await runLeaf(provider, req), 'IO_ERROR', req)
    assert.equal(calls(c).length, 0)
  })

  for (const profile of ['audit-source-only', 'release-controlled']) {
    test(`PROFILE_UNSUPPORTED: ${profile} with zero spawns and no file`, async () => {
      const c = makeCase()
      const provider = await makeProvider(c, [{ output: wireText({ verdict: 'PASS' }) }])
      const req = await request({ profile })
      const envelope = await runLeaf(provider, req)
      assertFailed(envelope, 'PROFILE_UNSUPPORTED', req)
      assert.equal(envelope.usage, null)
      assert.equal(calls(c).length, 0)
      assert.equal(existsSync(c.runDir), false)
    })
  }

  // SETTLE_MARGIN_MS is the contract's fixed 500 ms: SIGTERM at deadline - grace - 500.
  test('TIMEOUT: SIGTERM comes graceMs plus the 500 ms settle margin before the deadline', async () => {
    const c = makeCase()
    const provider = await makeProvider(c, [{ hang: true }], { options: { graceMs: 1000 } })
    const began = Date.now()
    const req = await request({ deadlineMs: began + 3000 })
    const envelope = await runLeaf(provider, req)
    const elapsed = Date.now() - began
    assertFailed(envelope, 'TIMEOUT', req)
    assert.ok(elapsed >= 1400, `returned before the leaf timeout: ${elapsed}ms`)
    assert.ok(elapsed < 2000, `SIGTERM was not sent grace + margin before the deadline: ${elapsed}ms`)
    const pid = calls(c)[0].pid
    assert.equal(await until(() => !alive(pid) && !alive(-pid)), true, 'stub process group still alive')
  })

  test('TIMEOUT: a child that ignores SIGTERM gets SIGKILL at least the margin before the deadline', async () => {
    const c = makeCase()
    const provider = await makeProvider(c, [{ hang: true, trap: true }], { options: { graceMs: 500 } })
    const began = Date.now()
    const req = await request({ deadlineMs: began + 3000 })
    const envelope = await runLeaf(provider, req)
    const elapsed = Date.now() - began
    assertFailed(envelope, 'TIMEOUT', req)
    assert.ok(elapsed >= 2400, `SIGKILL came before the grace ended: ${elapsed}ms`)
    assert.ok(elapsed < 3000, `the leaf outlived the runtime deadline: ${elapsed}ms`)
    const pid = calls(c)[0].pid
    assert.equal(await until(() => !alive(pid) && !alive(-pid)), true, 'stub process group still alive')
  })

  test('TIMEOUT: no time left after the grace and the margin means no spawn and no file', async () => {
    const c = makeCase()
    const provider = await makeProvider(c, [{ output: wireText({ verdict: 'PASS' }) }], { options: { graceMs: 500 } })
    const req = await request({ deadlineMs: Date.now() + 900 })
    assertFailed(await runLeaf(provider, req), 'TIMEOUT', req)
    assert.equal(calls(c).length, 0)
    assert.equal(existsSync(c.runDir), false)
  })

  test('TIMEOUT: the default graceMs is 500', async () => {
    const short = makeCase()
    const none = await makeProvider(short, [{ output: wireText({ verdict: 'PASS' }) }], { options: { graceMs: undefined } })
    const tight = await request({ deadlineMs: Date.now() + 950 })
    assertFailed(await runLeaf(none, tight), 'TIMEOUT', tight)
    assert.equal(calls(short).length, 0, 'spawned with less than the default grace left')

    const c = makeCase()
    const provider = await makeProvider(c, [{ hang: true }], { options: { graceMs: undefined } })
    const began = Date.now()
    const req = await request({ deadlineMs: began + 2000 })
    assertFailed(await runLeaf(provider, req), 'TIMEOUT', req)
    const elapsed = Date.now() - began
    assert.ok(elapsed >= 900 && elapsed < 1500, `leaf timeout was not deadline minus grace 500 and margin 500: ${elapsed}ms`)
  })

  test('TIMEOUT: the deadline is read through the injected nowMs', async () => {
    const c = makeCase()
    const req = await request({ deadlineMs: 1_000_000 })
    const provider = await makeProvider(c, [{ output: wireText({ verdict: 'PASS' }) }], { options: { nowMs: () => 999_900 } })
    assertFailed(await runLeaf(provider, req), 'TIMEOUT', req)
    assert.equal(calls(c).length, 0)
  })

  test('abort resolves a failed envelope (EXIT_NONZERO) and kills the group', async () => {
    const c = makeCase()
    const provider = await makeProvider(c, [{ hang: true, trap: true }])
    const controller = new AbortController()
    const req = await request({ signal: controller.signal })
    const running = runLeaf(provider, req)
    assert.equal(await until(() => existsSync(join(c.stubDir, 'ready')), 5000), true, 'stub never started')
    const began = Date.now()
    controller.abort()
    const envelope = await running
    assertFailed(envelope, 'EXIT_NONZERO', req)
    assert.ok(Date.now() - began < 200 + 3000)
    const pid = calls(c)[0].pid
    assert.equal(await until(() => !alive(pid) && !alive(-pid)), true)
  })
})

describe('CP-02b request validation rejects before any file or spawn (wiring proof, not runtime certification)', () => {
  const BAD = [
    ['an extra key', async () => ({ ...await request(), extra: 1 })],
    ['a missing signal key', async () => { const r = await request(); delete r.signal; return r }],
    ['a missing schema key', async () => { const r = await request(); delete r.schema; return r }],
    ['a callId that is a path', () => request({ callId: '../escape-SECRETVALUE' })],
    ['an uppercase callId', () => request({ callId: 'nr-' + 'A'.repeat(64) })],
    ['a non-codex selection', () => request({ selection: { ...SELECTION, provider: 'claude' } })],
    ['an extra selection key', () => request({ selection: { ...SELECTION, extra: 'x' } })],
    ['a model with a space', () => request({ selection: { ...SELECTION, model: 'gpt SECRETVALUE' } })],
    ['an uppercase effort', () => request({ selection: { ...SELECTION, effort: 'HIGH' } })],
    ['an unknown profile', () => request({ profile: 'full-access-SECRETVALUE' })],
    ['the original schema as wireSchema', () => request({ wireSchema: structuredClone(LEAF_SCHEMA) })],
    ['a loosened wireSchema', async () => request({ wireSchema: { ...await wireSchema(), additionalProperties: true } })],
    ['a prompt over 1 MiB', () => request({ prompt: 'CP02B-PROMPT-SENTINEL' + 'x'.repeat(MIB) })],
    ['a non-string prompt', () => request({ prompt: ['CP02B-PROMPT-SENTINEL'] })],
    ['a NaN deadline', () => request({ deadlineMs: NaN })],
    ['a string deadline', () => request({ deadlineMs: String(Date.now() + 30_000) })],
    ['a fake signal', () => request({ signal: { aborted: false } })],
    ['a class instance', async () => Object.assign(Object.create({ inherited: 1 }), await request())],
    ['a Proxy', async () => new Proxy(await request(), {})],
    ['null', async () => null],
  ]
  for (const [name, make] of BAD) {
    test(`rejects ${name} with INVALID_RUNTIME_INPUT`, async () => {
      const c = makeCase()
      const provider = await makeProvider(c, [{ output: wireText({ verdict: 'PASS' }) }])
      const req = await make()
      await assert.rejects(runLeaf(provider, req), error => error.code === 'INVALID_RUNTIME_INPUT' && error.message === FIXED_MESSAGE)
      assert.equal(calls(c).length, 0)
      assert.equal(existsSync(c.runDir), false)
    })
  }

  test('a throwing nowMs rejects with INVALID_RUNTIME_INPUT before any spawn', async () => {
    const c = makeCase()
    const provider = await makeProvider(c, [{ output: wireText({ verdict: 'PASS' }) }], { options: { nowMs: () => { throw new Error('CP02B-PROMPT-SENTINEL') } } })
    await assert.rejects(runLeaf(provider, await request()), error => error.code === 'INVALID_RUNTIME_INPUT' && error.message === FIXED_MESSAGE)
    assert.equal(calls(c).length, 0)
  })
})

// ------------------------------------------------------------ through runtime
// The real runtime, real templates and the NR-02 in-memory checkpoint port. The
// fixture's resolveLeaf selects {codex, fake-model, high} with build-workspace
// (audit-source-only for security-audit-flow). A run that completes proves the
// runtime's completionFor accepted every envelope; a rejected one would be
// DISPATCH_UNCERTAIN.
async function runtimeCase(t, steps, { options = {}, workflow = 'harness-repair', args = { repo: '/inert/project' }, deadlineMs } = {}) {
  const c = makeCase()
  const provider = await makeProvider(c, steps, { options })
  const f = await fixture(t, { cap: 1, provider, ...(deadlineMs ? { deadlineMs } : {}) })
  const result = await f.runtime.run(workflow, args, { invocationId: `cp-02b-${workflow}` })
  const rows = [...f.checkpoints.rows.values()]
  for (const row of rows) {
    assert.equal(row.state, 'completed')
    assert.deepEqual(row.completion.receipt, { provider: 'codex', model: 'fake-model', effort: 'high', invocationId: row.binding.callId })
    assert.deepEqual(keysDeep(row.completion).filter(key => DOLLAR_KEY.test(key)), [])
  }
  return { c, result, rows, spawned: calls(c) }
}

describe('CP-02b through the real runtime (wiring proof, not runtime certification)', () => {
  test('harness-repair completes on three Codex leaves; decode accepts every returned envelope', async t => {
    const steps = [pass(), review(), review()].map(value => ({ output: wireText(value) }))
    const { result, rows, spawned } = await runtimeCase(t, steps)
    assert.equal(result.status, 'done')
    assert.equal(spawned.length, 3)
    assert.equal(rows.length, 3)
    rows.forEach((row, i) => {
      assert.equal(row.completion.outcome, 'returned')
      assert.equal(spawned[i].schema, readFileSync(argValue(spawned[i].argv, '--output-schema'), 'utf8'))
      assert.equal(argValue(spawned[i].argv, '--output-schema'), join(dirnameOf(spawned[i]), `${row.binding.callId}.schema.json`))
      assert.equal(argValue(spawned[i].argv, '--sandbox'), 'workspace-write')
      assert.ok(spawned[i].argv.includes('--ignore-user-config'))
      // The prompt reached stdin byte for byte: its hash is the runtime binding's.
      assert.equal(sha(spawned[i].stdin), row.binding.promptHash)
    })
    assert.deepEqual(rows.map(r => r.binding.agentType), ['checker', 'reviewer', 'qa-auditor'])
  })

  const RUNTIME_FAILURES = [
    ['EXIT_NONZERO', { events: [], exit: 3 }],
    ['TURN_FAILED', { events: [{ type: 'turn.failed', error: { message: 'stub failure' } }], exit: 1 }],
    ['PROVIDER_REFUSAL', { events: [{ type: 'error', message: REFUSAL }], exit: 1 }],
    ['NO_OUTPUT', {}],
    ['INVALID_WIRE', { output: JSON.stringify([pass()]) }],
  ]
  for (const [expected, step] of RUNTIME_FAILURES) {
    test(`${expected} settles as a durable failed leaf and the graph escalates without a retry`, async t => {
      const { result, rows, spawned } = await runtimeCase(t, [step, step])
      assert.equal(result.status, 'escalate')
      assert.equal(spawned.length, 1)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].completion.outcome, 'failed')
      assert.equal(rows[0].completion.code, expected)
    })
  }

  test('TIMEOUT settles before the runtime deadline and the graph escalates', async t => {
    const began = Date.now()
    const { result, rows, spawned } = await runtimeCase(t, [{ hang: true }], { options: { graceMs: 1000 }, deadlineMs: began + 4000 })
    assert.equal(result.status, 'escalate')
    assert.equal(spawned.length, 1)
    assert.equal(rows[0].completion.code, 'TIMEOUT')
  })

  test('a child that ignores SIGTERM still settles as a failed TIMEOUT leaf, not RUNTIME_ABORTED', async t => {
    const began = Date.now()
    const { result, rows, spawned } = await runtimeCase(t, [{ hang: true, trap: true }], { options: { graceMs: 1000 }, deadlineMs: began + 4000 })
    assert.equal(result.status, 'escalate')
    assert.equal(spawned.length, 1)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].completion.outcome, 'failed')
    assert.equal(rows[0].completion.code, 'TIMEOUT')
    const pid = spawned[0].pid
    assert.equal(await until(() => !alive(pid) && !alive(-pid)), true, 'stub process group still alive')
  })

  // The unparseable 'not json' variant was retired by CP-02h.
  for (const json of [JSON.stringify({ verdict: 'PASS' })]) {
    test(`semantically invalid output (${json}) is durable returned evidence; decode fails as an ordinary leaf error`, async t => {
      const { result, rows, spawned } = await runtimeCase(t, [{ output: JSON.stringify({ json }) }])
      assert.equal(result.status, 'escalate')
      assert.equal(spawned.length, 1)
      assert.equal(rows[0].completion.outcome, 'returned')
      assert.equal(rows[0].completion.wire.json, json)
    })
  }

  test('security-audit-flow (audit-source-only) gives PROFILE_UNSUPPORTED with zero spawns', async t => {
    const { rows, spawned } = await runtimeCase(t, [], { workflow: 'security-audit-flow', args: reconArgs() })
    assert.equal(spawned.length, 0)
    assert.ok(rows.length > 0)
    for (const row of rows) {
      assert.equal(row.completion.outcome, 'failed')
      assert.equal(row.completion.code, 'PROFILE_UNSUPPORTED')
      assert.equal(row.binding.profile, 'audit-source-only')
    }
  })
})

// The runDir is the directory of the recorded --output-last-message path.
function dirnameOf(call) {
  const out = argValue(call.argv, '--output-last-message')
  return out.slice(0, out.lastIndexOf('/'))
}
