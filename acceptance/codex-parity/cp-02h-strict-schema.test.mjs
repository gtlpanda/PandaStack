// CP-02h frozen acceptance: Codex gets the strict leaf schema
// (spec/contracts/codex-parity-cp-02h.md). Wiring proof, not runtime certification:
// no real codex, no network, no HOME. The `codex` child is a stub executable (a
// small node script) in an owned temp directory, run with a minimal explicit
// environment. Runtime cases drive the real runtime.mjs and real graph templates
// through acceptance/native-runtime/nr-02-runtime-support.mjs. Nothing here proves
// that a real Codex enforces the strict schema.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, devAnswer, fixture, pass, plan, review } from '../native-runtime/nr-02-runtime-support.mjs'

const url = path => pathToFileURL(resolve(ROOT, path)).href
const loadProvider = () => import(url('core/skills/native-runtime/codex-provider.mjs'))
const loadSchema = () => import(url('core/skills/native-runtime/schema.mjs'))
const strictOf = async schema => (await loadSchema()).strictOutputSchema(schema)

const MIB = 1048576
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const DOLLAR_KEY = /usd|cost|dollar|price|spend|amount/i
const CONTRACT_MESSAGE = 'Native output contract rejected.'
const RUNTIME_MESSAGE = 'Native runtime: INVALID_RUNTIME_INPUT.'
const PROMPT_SENTINEL = 'CP02H-PROMPT-SENTINEL'
const SCHEMA_SENTINEL = 'CP02H-SCHEMA-SENTINEL'
const DROPPED = ['minimum', 'maximum', 'minItems', 'maxItems', 'title', '$comment']
const KEPT_KEYS = new Set(['type', 'description', 'enum', 'properties', 'required', 'additionalProperties', 'items'])
const sha = value => createHash('sha256').update(value).digest('hex')
const coded = expected => error => error?.code === expected && error.message === CONTRACT_MESSAGE
const deepClone = value => JSON.parse(JSON.stringify(value))

// ------------------------------------------------------------------- the stub
// Each spawn takes the next step from <STUB_DIR>/steps.json (by call count) and
// appends one record (argv, env, stdin and the bytes of the --output-schema file it
// was handed) to <STUB_DIR>/calls.jsonl. Step fields: events (protocol lines, default
// one turn.completed with usage), output (text written to --output-last-message
// unchanged), outputFrom (a file copied there), outputKind ('symlink' | 'fifo'),
// target (the symlink target).
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
  fs.appendFileSync(callsFile, JSON.stringify({ argv, env: { ...process.env }, stdin: Buffer.concat(chunks).toString('utf8'),
    schema: schemaFile && fs.existsSync(schemaFile) ? fs.readFileSync(schemaFile, 'utf8') : null }) + '\\n')
  if (!step) process.exit(97)
  const out = flag('--output-last-message')
  if (step.output !== undefined) fs.writeFileSync(out, step.output)
  if (step.outputFrom !== undefined) fs.copyFileSync(step.outputFrom, out)
  if (step.outputKind === 'symlink') fs.symlinkSync(step.target, out)
  if (step.outputKind === 'fifo') cp.execFileSync('/usr/bin/mkfifo', [out])
  for (const event of step.events ?? [{ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }]) {
    process.stdout.write(JSON.stringify(event) + '\\n')
  }
  process.exit(step.exit ?? 0)
})
`

let WORK, STUB
before(() => {
  WORK = realpathSync(mkdtempSync(join(tmpdir(), 'cp-02h-')))
  STUB = join(WORK, 'codex-stub')
  writeFileSync(STUB, STUB_SOURCE)
  chmodSync(STUB, 0o755)
})
after(() => rmSync(WORK, { recursive: true, force: true }))

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
async function makeProvider(c, steps, options = {}) {
  writeFileSync(join(c.stubDir, 'steps.json'), JSON.stringify(steps))
  const { createCodexProvider } = await loadProvider()
  return createCodexProvider({ codexBin: STUB, cwd: c.cwd, env: { STUB_DIR: c.stubDir }, runDir: c.runDir, graceMs: 200, ...options })
}

// ---------------------------------------------------------------- the request
// Every dropped keyword, a nullable type, a nested array of objects with no
// additionalProperties, and `required` listed out of property order.
const LEAF_SCHEMA = Object.freeze({
  type: 'object', title: 'Leaf', $comment: 'dropped',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'], description: `${SCHEMA_SENTINEL} verdict` },
    count: { type: 'integer', minimum: 0, maximum: 9 },
    notes: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, minItems: 0, maxItems: 3 },
    extra: { type: ['string', 'null'] },
  },
  required: ['notes', 'verdict', 'extra', 'count'],
})
// LEAF_SCHEMA in the strict subset, written out by hand.
const LEAF_STRICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'], description: `${SCHEMA_SENTINEL} verdict` },
    count: { type: 'integer' },
    notes: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
    extra: { type: ['string', 'null'] },
  },
  required: ['verdict', 'count', 'notes', 'extra'],
  additionalProperties: false,
}
const REPLY = Object.freeze({ verdict: 'PASS', count: 3, notes: [{ text: 'é ✓ "quoted" \\ end' }], extra: null })
const PROMPT = `${PROMPT_SENTINEL} line one\nline two`
const SELECTION = Object.freeze({ provider: 'codex', model: 'gpt-test.1', effort: 'high' })
const callIdOf = name => 'nr-' + sha(`cp-02h-${name}`)
async function request(patch = {}) {
  const schema = patch.schema ?? deepClone(LEAF_SCHEMA)
  const { encodeOutputContract } = await loadSchema()
  return {
    callId: callIdOf('leaf'), workflowId: 'harness-repair', workflowPath: ['harness-repair'], agentType: 'checker',
    label: 'check', phase: 'Check', requestedModel: 'haiku', requestedEffort: 'high', invocationId: 'inv-cp-02h',
    prompt: PROMPT, selection: { ...SELECTION }, profile: 'build-workspace', schema,
    wireSchema: deepClone(encodeOutputContract({ type: 'object' }).wireSchema),
    deadlineMs: Date.now() + 30_000, signal: new AbortController().signal, ...patch,
  }
}

// ---------------------------------------------------------- envelope checks
function keysDeep(value, found = []) {
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { found.push(key); keysDeep(item, found) }
  return found
}
function assertCommon(envelope, req) {
  assert.deepEqual(envelope.receipt, { ...req.selection, invocationId: req.callId })
  assert.deepEqual(keysDeep(envelope).filter(key => DOLLAR_KEY.test(key)), [], 'a dollar-like field was emitted')
  const text = JSON.stringify(envelope)
  assert.ok(!text.includes(PROMPT_SENTINEL), 'prompt text reached the envelope')
  assert.ok(!text.includes(SCHEMA_SENTINEL), 'schema text reached the envelope')
}
function assertFailed(envelope, expected, req) {
  assert.equal(envelope.outcome, 'failed', JSON.stringify(envelope).slice(0, 300))
  assert.deepEqual(Object.keys(envelope).sort(), ['code', 'outcome', 'receipt', 'usage'])
  assert.equal(envelope.code, expected)
  assertCommon(envelope, req)
}
function assertReturned(envelope, json, req) {
  assert.equal(envelope.outcome, 'returned', JSON.stringify(envelope).slice(0, 300))
  assert.deepEqual(Object.keys(envelope).sort(), ['outcome', 'receipt', 'usage', 'wire'])
  assert.deepEqual(Object.keys(envelope.wire), ['json'])
  assert.equal(envelope.wire.json, json)
  assertCommon(envelope, req)
}

// ------------------------------------------------------------ strict checks
// The independent oracle: walks a strict result beside its input and checks every
// node against the contract's rules.
function assertStrictOf(out, input, path = '$') {
  for (const key of Object.keys(out)) assert.ok(KEPT_KEYS.has(key), `${path}: unexpected key ${key}`)
  assert.deepEqual(out.type, input.type, `${path}.type`)
  for (const key of ['description', 'enum']) {
    if (Object.hasOwn(input, key)) assert.deepEqual(out[key], input[key], `${path}.${key}`)
    else assert.equal(Object.hasOwn(out, key), false, `${path}.${key} appeared`)
  }
  const kind = Array.isArray(input.type) ? input.type[0] : input.type
  if (kind === 'object') {
    const keys = Object.keys(input.properties)
    assert.deepEqual(Object.keys(out.properties), keys, `${path}.properties order`)
    assert.deepEqual(out.required, keys, `${path}.required is every property key in order`)
    assert.equal(out.additionalProperties, false, `${path}.additionalProperties`)
    for (const key of keys) assertStrictOf(out.properties[key], input.properties[key], `${path}.${key}`)
  } else {
    for (const key of ['properties', 'required', 'additionalProperties']) assert.equal(Object.hasOwn(out, key), false, `${path}.${key}`)
  }
  if (kind === 'array') assertStrictOf(out.items, input.items, `${path}[]`)
  else assert.equal(Object.hasOwn(out, 'items'), false, `${path}.items`)
}
function assertDeepFrozen(value, path = '$') {
  assert.ok(Object.isFrozen(value), `${path} is not frozen`)
  assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype, `${path} prototype`)
  for (const [key, item] of Object.entries(value)) if (item && typeof item === 'object') assertDeepFrozen(item, `${path}.${key}`)
}
function keywordsDeep(schema, found = new Set()) {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    for (const key of Object.keys(schema)) found.add(key)
    for (const child of Object.values(schema.properties ?? {})) keywordsDeep(child, found)
    if (schema.items) keywordsDeep(schema.items, found)
  }
  return found
}

// ===================================================== strictOutputSchema (unit)
const obj = (properties, required = Object.keys(properties), extra = {}) => ({ type: 'object', properties, required, ...extra })
const STR = { type: 'string' }

describe('CP-02h strictOutputSchema (schema.mjs)', () => {
  test('LEAF_SCHEMA becomes the hand-written strict schema; dropped keywords are gone', async () => {
    const out = await strictOf(deepClone(LEAF_SCHEMA))
    assert.deepEqual(out, LEAF_STRICT)
    assert.deepEqual(JSON.parse(JSON.stringify(out)), LEAF_STRICT)
    for (const key of DROPPED) assert.equal(keywordsDeep(out).has(key), false, key)
  })

  test('the input is not mutated, the result is fresh and deep-frozen with ordinary prototypes', async () => {
    const input = deepClone(LEAF_SCHEMA)
    const before = JSON.stringify(input)
    const out = await strictOf(input)
    assert.equal(JSON.stringify(input), before)
    assert.notEqual(out, input)
    assert.notEqual(out.properties, input.properties)
    assert.notEqual(out.properties.verdict.enum, input.properties.verdict.enum)
    assert.notEqual(out.properties.extra.type, input.properties.extra.type)
    assertDeepFrozen(out)
    // A deep-frozen input works too, so the transform never writes to it.
    const frozen = deepClone(LEAF_SCHEMA)
    const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } return v }
    assert.deepEqual(await strictOf(freeze(frozen)), LEAF_STRICT)
  })

  test('no getter on the input runs', async () => {
    let read = false
    const input = obj({ a: STR })
    Object.defineProperty(input.properties, 'b', { enumerable: true, get() { read = true; return STR } })
    await assert.rejects(async () => strictOf(input), error => typeof error?.code === 'string')
    assert.equal(read, false)
  })

  test('each keyword is classified: structure, kept or dropped', async () => {
    const out = await strictOf({
      type: 'object', title: 't', $comment: 'c', description: 'root',
      properties: {
        n: { type: 'number', minimum: 1, maximum: 2, description: 'n', title: 'tn', $comment: 'cn' },
        e: { type: 'string', enum: ['a', 'b'] },
        l: { type: ['array', 'null'], items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: 2 },
        o: { type: ['object', 'null'], properties: { x: { type: 'boolean' } }, required: ['x'], additionalProperties: false },
      },
      required: ['n', 'e', 'l', 'o'], additionalProperties: false,
    })
    assert.deepEqual(out, {
      type: 'object', description: 'root',
      properties: {
        n: { type: 'number', description: 'n' },
        e: { type: 'string', enum: ['a', 'b'] },
        l: { type: ['array', 'null'], items: { type: 'integer' } },
        o: { type: ['object', 'null'], properties: { x: { type: 'boolean' } }, required: ['x'], additionalProperties: false },
      },
      required: ['n', 'e', 'l', 'o'], additionalProperties: false,
    })
  })

  test('a property named __proto__ stays an own property', async () => {
    const input = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"a":{"type":"string"}},"required":["a","__proto__"]}')
    const out = await strictOf(input)
    assert.deepEqual(Object.keys(out.properties), ['__proto__', 'a'])
    assert.ok(Object.hasOwn(out.properties, '__proto__'))
    assert.equal(Object.getPrototypeOf(out.properties), Object.prototype)
    assert.deepEqual(out.required, ['__proto__', 'a'])
    assert.deepEqual(JSON.parse(JSON.stringify(out.properties)), JSON.parse('{"__proto__":{"type":"string"},"a":{"type":"string"}}'))
  })

  // Each row: a schema the strict subset cannot express. The sentinel names prove
  // the error never echoes the schema.
  const S = SCHEMA_SENTINEL
  const UNSUPPORTED = [
    ['an optional property (required is a strict subset)', obj({ a: STR, [S]: STR }, ['a'])],
    ['no required at all', { type: 'object', properties: { [S]: STR } }],
    ['an empty required', obj({ [S]: STR }, [])],
    ['a required key that is not a property', obj({ a: STR }, ['a', S])],
    ['a required key that is not a property, same count', obj({ a: STR, b: STR }, ['a', S])],
    ['a nested optional property', obj({ a: obj({ x: STR, [S]: STR }, ['x']) })],
    ['an optional property inside array items', obj({ a: { type: 'array', items: obj({ x: STR, [S]: STR }, [S]) } })],
    ['an object with no properties', obj({ a: { type: 'object', description: S } })],
    ['an object with empty properties', obj({ a: { type: 'object', properties: {}, required: [] } })],
    ['a root with no properties', { type: 'object', description: S }],
    ['explicit additionalProperties: true', obj({ [S]: STR }, [S], { additionalProperties: true })],
    ['nested additionalProperties: true', obj({ a: obj({ x: STR }, ['x'], { additionalProperties: true }) })],
    ['an array with no items', obj({ [S]: { type: 'array' } })],
    ['a nullable array with no items', obj({ [S]: { type: ['array', 'null'] } })],
    ["a type array ['null', x]", obj({ [S]: { type: ['null', 'string'] } })],
    ['a one-entry type array', obj({ [S]: { type: ['string'] } })],
    ['a type array of two non-null types', obj({ [S]: { type: ['string', 'number'] } })],
    ['a type array of three types', obj({ [S]: { type: ['string', 'number', 'null'] } })],
    ['a string root', { type: 'string', description: S }],
    ['an array root', { type: 'array', items: STR }],
    ['a nullable object root', { type: ['object', 'null'], properties: { [S]: STR }, required: [S] }],
  ]
  for (const [name, schema] of UNSUPPORTED) {
    test(`UNSUPPORTED_SCHEMA: ${name}`, async () => {
      const { strictOutputSchema, encodeOutputContract } = await loadSchema()
      assert.doesNotThrow(() => encodeOutputContract(schema), 'the runtime accepts this schema')
      const before = JSON.stringify(schema)
      assert.throws(() => strictOutputSchema(schema), error => coded('UNSUPPORTED_SCHEMA')(error) && !error.message.includes(S))
      assert.equal(JSON.stringify(schema), before)
    })
  }

  // Keyword drift tripwire: keywords outside schema.mjs KEYWORDS are refused. A
  // feature that adds one to KEYWORDS amends this list and the contract with it.
  const FOREIGN = ['pattern', 'format', 'const', 'anyOf', 'oneOf', 'allOf', 'not', '$ref', '$defs', 'definitions', '$schema',
    'default', 'examples', 'minLength', 'maxLength', 'uniqueItems', 'nullable', 'patternProperties', 'propertyNames',
    'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minProperties', 'maxProperties', 'if', 'then', 'else', 'prefixItems', 'contains']
  test('every keyword outside schema.mjs KEYWORDS is UNSUPPORTED_SCHEMA, at the root and nested', async () => {
    const { strictOutputSchema } = await loadSchema()
    for (const key of FOREIGN) {
      assert.throws(() => strictOutputSchema({ ...obj({ a: STR }), [key]: 1 }), coded('UNSUPPORTED_SCHEMA'), `root ${key}`)
      assert.throws(() => strictOutputSchema(obj({ a: { type: 'string', [key]: 1 } })), coded('UNSUPPORTED_SCHEMA'), `nested ${key}`)
    }
  })

  test('an invalid schema is INVALID_SCHEMA, as encodeOutputContract says', async () => {
    const { strictOutputSchema } = await loadSchema()
    for (const bad of [null, 5, 'object', [], { type: 'bogus' }, { type: 'string', properties: {} }, obj({ a: STR }, ['a', 'a']),
      { type: 'object', properties: { a: { type: 'number', minimum: 2, maximum: 1 } }, required: ['a'] }]) {
      assert.throws(() => strictOutputSchema(bad), coded('INVALID_SCHEMA'))
    }
  })
})

// ======================================================= graph schema sweep
// Every agent() schema the runtime dispatches in harness-repair, dev-build,
// blueprint-design and release-flow (and bughunt-flow for its min/max keywords),
// reached through the real runtime with an in-memory provider: the scenarios of
// CP-02f's sweep for these graphs. A role without a scripted reply gets the minimal
// value its schema allows.
const synth = schema => {
  if (Array.isArray(schema.enum)) return schema.enum[0]
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
  if (type === 'object') {
    const out = {}
    for (const key of schema.required || []) out[key] = synth(schema.properties?.[key] ?? { type: 'string' })
    return out
  }
  if (type === 'array') return Array.from({ length: schema.minItems ?? 0 }, () => synth(schema.items ?? { type: 'string' }))
  if (type === 'string') return 'inert'
  if (type === 'integer' || type === 'number') return schema.minimum ?? 0
  if (type === 'boolean') return false
  return null
}
const GATE_APPROVE = { verdict: 'approve', issues: [], questions: [] }
const HIGH = { severity: 'HIGH', title: 'fixture finding', file: 'src/a.js', line: 1, why: 'inert', fix: 'inert' }
const FIX = { fixed: ['fixture finding'], unfixed: [], touched: ['src/a.js'], verify_verdict: 'PASS', summary: 'inert' }
const DEV = (n, req) => devAnswer(req)
const QA_BASE = { checker: () => pass(), reviewer: () => review(), 'qa-auditor': () => review() }
const STAGE_ARGS = { repo: '/inert/project', statePath: '/inert/state.json', mode: 'app', requirements: ['R1'], decisions: [], assumptions: [] }
const SNAPSHOT = { pr: { number: 1, state: 'OPEN', headRefOid: 'abc1234', headRefName: 'feature', baseRefName: 'main',
  mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', isDraft: false, mergeCommit: '' },
default_branch: 'main', merge_methods: ['squash'], checks: [], deploy: { source: 'config', merge_method: 'squash', targets: [], missing_credentials: [] } }
const CANDIDATE = { file_path: 'src/feature.js', line_range: [1, 1], bug_category: 'logic', severity: 'HIGH', confidence: 90,
  title: 'Negative result violates total contract', description: 'inert', failure_scenario: { trigger: 'inert', path: 'src/feature.js:1', observable: 'inert' },
  expected_behavior: 'inert', actual_behavior: 'inert', evidence: [{ file: 'src/feature.js', line: 1, quote: 'inert' }] }
const EVIDENCE_LINES = { run: 'EVIDENCE: REPRODUCED F1', fix: 'FIX: PASS F1', adversarial: 'ADVERSARIAL: PASS F1',
  commit: `COMMIT: DONE F1 ${'a'.repeat(40)}`, revert: 'REVERT: DONE F1' }
const SCENARIOS = [
  ['harness-repair', { repo: '/inert/project' }, QA_BASE],
  ['harness-repair', { repo: '/inert/project' }, { ...QA_BASE,
    reviewer: n => (n === 1 ? { files_reviewed: 1, findings: [HIGH] } : review()),
    advisor: () => ({ verdicts: [{ index: 0, real: true, reason: 'inert' }] }), fixer: () => FIX }],
  ['dev-build', { repo: '/inert/project', plan: plan(), planApproved: true }, { ...QA_BASE, scout: DEV, implementer: DEV, 'acceptance-auditor': DEV }],
  ['dev-build', { repo: '/inert/project', task: 'inert task' }, { planner: () => plan(), advisor: () => GATE_APPROVE }],
  ['dev-build', { repo: '/inert/project', plan: plan(), planApproved: true }, { ...QA_BASE, scout: DEV, implementer: DEV,
    'acceptance-auditor': (n, req) => (n === 1 ? { ...devAnswer(req), behavior_changes_missing: [{ change: 'inert', file: 'src/a.js', line: 1 }] } : devAnswer(req)),
    advisor: () => ({ decisions: [{ n: 1, decision: 'keep', serves: 'goal', reason: 'inert' }] }) }],
  ['blueprint-design', { repo: '/inert/project', request: 'inert request' }, {
    extractor: () => ({ goal: 'inert', mode: 'app', users: [], requirements: [{ id: 'R1', text: 'inert', source: 'request' }],
      decided: [], gaps: [], contradictions: [], constraints: [], existing_stack: 'inert' }) }],
  ['blueprint-design', { ...STAGE_ARGS, stage: 'design' }, {
    architect: () => ({ summary: 'inert', modules: [{ id: 'M1', name: 'inert', responsibility: 'inert', requirements: ['R1'], boundary: false,
      shapes: [], pick: '', depth_reason: '' }], failure_modes: [], adrs: [], departures: [], honors: [], conflicts: [], knowledge: [], premises: [] }),
    advisor: () => GATE_APPROVE }],
  ['blueprint-design', { ...STAGE_ARGS, stage: 'backlog', designPath: '/inert/run2.json', knowledge: [] }, {}],
  ['release-flow', { repo: '/inert/project', pr: 1, stage: 'docs' }, {}],
  ['release-flow', { repo: '/inert/project', pr: 1, stage: 'land', approval: { pr: 1, head: 'abc1234', base: 'main' } }, {
    'release-checker': () => SNAPSHOT, merger: () => ({ outcome: 'MERGED', merge_sha: 'abc1234', by_this_attempt: true, detail: 'inert' }) }],
  ['release-flow', { repo: '/inert/project', pr: 1, stage: 'verify', mergeSha: 'abc1234',
    targets: [{ name: 'web', workflow: '', status_command: '', health: '' }] }, {
    'deploy-watcher': () => ({ targets: [{ name: 'web', evidence: 'FAILED', health: 'FAIL', detail: 'inert' }] }),
    advisor: () => ({ action: 'investigate', diagnosis: 'inert', evidence: 'inert' }) }],
  ['bughunt-flow', { repo: '/inert/project', tree: '/inert/tree', configDir: '/inert/config', stateDir: '/inert/state', mode: 'fix', fixBranch: 'bughunt/inert',
    intake: { target: { head: 'h', mergeBase: 'm', label: 'inert' }, files: [], lenses: { routed: ['logic'], reasons: {} } } }, {
    hunter: () => ({ lens_token: 'logic-q4m7', coverage: [{ area: 'src/feature.js', status: 'finding', note: 'inert' }], findings: [CANDIDATE] }),
    skeptic: () => ({ verdict: 'refuted', refute_confidence: 90, reason: 'inert', execution_path: '', introduced_by_change: 'yes', severity: 'HIGH', duplicate_of: '' }),
    reproducer: () => ({ written: true, test_file: 'tests/inert.test.mjs', how_it_fails: 'inert', reason: '' }),
    runner: (n, req) => ({ exit_code: 0, output: EVIDENCE_LINES[req.label.split(':')[0]] }),
    repairer: () => ({ root_cause: 'inert', why_it_exists: 'inert', files_changed: ['src/feature.js'], interfaces_changed: false, summary: 'inert' }),
    'fix-verifier': () => ({ verdict: 'accept', root_cause_addressed: true, callers_preserved: true, unrelated_changes: [], problems: [],
      adversarial_tests: [], remaining_risks: [] }) }],
]
const STRICT_GRAPHS = ['blueprint-design', 'dev-build', 'harness-repair', 'release-flow']

async function sweep(t) {
  const seen = []
  for (const [index, [workflowId, args, replies]] of SCENARIOS.entries()) {
    const counts = new Map()
    const answer = req => {
      seen.push({ workflowId: req.workflowId, agentType: req.agentType, schema: req.schema })
      const n = (counts.get(req.agentType) ?? 0) + 1
      counts.set(req.agentType, n)
      const reply = replies[req.agentType]
      return reply ? reply(n, req) : synth(req.schema)
    }
    const f = await fixture(t, { cap: 1, answer })
    const outcome = await f.runtime.run(workflowId, args, { invocationId: `cp-02h-sweep-${index}` })
    assert.equal(typeof outcome?.status, 'string', `${workflowId} scenario ${index} returned a status`)
  }
  return seen
}

describe('CP-02h strictOutputSchema over the registered graphs (runtime-level, not a Codex run)', () => {
  test('harness-repair, dev-build, blueprint-design and release-flow: every reached schema is strict-expressible', async t => {
    const { strictOutputSchema } = await loadSchema()
    const seen = await sweep(t)
    const catalog = JSON.parse(readFileSync(resolve(ROOT, 'spec/offering-capabilities.json'), 'utf8'))
    for (const workflow of catalog.workflows) {
      const id = workflow.source.replace(/^.*\/([^/]+)\.js$/, '$1')
      if (!STRICT_GRAPHS.includes(id)) continue
      const reached = new Set(seen.filter(s => s.workflowId === id).map(s => s.agentType))
      assert.deepEqual([...new Set(workflow.roles)].filter(role => !reached.has(role)), [], `${id}: every catalog role is reached`)
    }
    const strictSeen = seen.filter(s => STRICT_GRAPHS.includes(s.workflowId))
    assert.ok(strictSeen.length >= 20, `only ${strictSeen.length} leaves reached`)
    for (const { workflowId, agentType, schema } of strictSeen) {
      const before = JSON.stringify(schema)
      let out
      assert.doesNotThrow(() => { out = strictOutputSchema(schema) }, `${workflowId} ${agentType}`)
      assert.equal(JSON.stringify(schema), before, `${workflowId} ${agentType}: input mutated`)
      assertStrictOf(out, schema, `${workflowId} ${agentType}`)
      for (const key of DROPPED) assert.equal(keywordsDeep(out).has(key), false, `${workflowId} ${agentType}: ${key} kept`)
      assertDeepFrozen(out)
    }
  })

  test("bughunt-flow's minItems, maxItems, minimum and maximum are dropped without error", async t => {
    const { strictOutputSchema } = await loadSchema()
    const hunt = (await sweep(t)).filter(s => s.workflowId === 'bughunt-flow')
    const ranged = hunt.filter(s => ['minItems', 'maxItems', 'minimum', 'maximum'].some(key => keywordsDeep(s.schema).has(key)))
    assert.deepEqual([...new Set(ranged.map(s => s.agentType))].sort(), ['hunter', 'skeptic'])
    for (const { agentType, schema } of hunt) {
      let out
      assert.doesNotThrow(() => { out = strictOutputSchema(schema) }, agentType)
      assertStrictOf(out, schema, agentType)
      for (const key of DROPPED) assert.equal(keywordsDeep(out).has(key), false, `${agentType}: ${key} kept`)
    }
  })
})

// ================================================================ provider
describe('CP-02h provider: codes', () => {
  test('CODEX_PROVIDER_CODES is exactly the twelve codes, frozen; the four exports are unchanged', async () => {
    const mod = await loadProvider()
    assert.deepEqual(Object.keys(mod).sort(), ['CODEX_PROVIDER', 'CODEX_PROVIDER_CODES', 'createCodexProvider', 'sandboxForProfile'])
    assert.deepEqual(Object.keys(mod.CODEX_PROVIDER_CODES).sort(), ['AUTH', 'BILLING', 'EXIT_NONZERO', 'INVALID_WIRE', 'IO_ERROR',
      'NO_OUTPUT', 'PROFILE_UNSUPPORTED', 'PROVIDER_REFUSAL', 'SCHEMA_UNSUPPORTED', 'TIMEOUT', 'TURN_FAILED', 'USAGE_LIMIT'])
    for (const [key, value] of Object.entries(mod.CODEX_PROVIDER_CODES)) { assert.equal(value, key); assert.match(value, CODE_PATTERN) }
    assert.ok(Object.isFrozen(mod.CODEX_PROVIDER_CODES))
  })
})

describe('CP-02h provider: Codex gets the strict schema and the provider wraps a bare object', () => {
  test('the .schema.json bytes are JSON.stringify(strictOutputSchema(request.schema)), 0600, never the wire schema', async () => {
    const c = makeCase()
    const provider = await makeProvider(c, [{ output: JSON.stringify(REPLY) }])
    const req = await request()
    const schemaBefore = JSON.stringify(req.schema)
    const envelope = await provider.runLeaf(req)
    assertReturned(envelope, JSON.stringify(REPLY), req)
    assert.equal(JSON.stringify(req.schema), schemaBefore, 'request.schema was mutated')

    const schemaFile = join(c.runDir, `${req.callId}.schema.json`)
    const [call, ...rest] = calls(c)
    assert.equal(rest.length, 0, 'exactly one spawn')
    assert.equal(argValue(call.argv, '--output-schema'), schemaFile)
    const bytes = readFileSync(schemaFile, 'utf8')
    assert.equal(bytes, JSON.stringify(await strictOf(req.schema)))
    assert.equal(call.schema, bytes, 'the child was handed these bytes')
    assert.deepEqual(JSON.parse(bytes), LEAF_STRICT)
    assert.notEqual(bytes, JSON.stringify(req.wireSchema))
    assert.equal(statSync(schemaFile).mode & 0o777, 0o600)
    assert.equal(statSync(c.runDir).mode & 0o777, 0o700)
    assert.equal(call.stdin, PROMPT)
    for (const file of readdirSync(c.runDir)) {
      assert.ok(!readFileSync(join(c.runDir, file), 'utf8').includes(PROMPT_SENTINEL), `prompt written to ${file}`)
    }
  })

  test('wire.json is the re-serialized object, not the file bytes', async () => {
    const c = makeCase()
    const pretty = JSON.stringify(REPLY, null, 2) + '\n'
    const escaped = '{"verdict":"\\u0050ASS","count":3.0,"notes":[{"text":"\\u00e9"}],"extra":null}'
    const provider = await makeProvider(c, [{ output: pretty }, { output: escaped }])
    let req = await request({ callId: callIdOf('pretty') })
    assertReturned(await provider.runLeaf(req), JSON.stringify(REPLY), req)
    req = await request({ callId: callIdOf('escaped') })
    assertReturned(await provider.runLeaf(req), '{"verdict":"PASS","count":3,"notes":[{"text":"é"}],"extra":null}', req)
  })

  test('the provider never unwraps: an output shaped {"json": "..."} is a bare object like any other', async () => {
    const c = makeCase()
    const old = JSON.stringify({ json: JSON.stringify(REPLY) })
    const provider = await makeProvider(c, [{ output: old }])
    const req = await request()
    assertReturned(await provider.runLeaf(req), old, req)
  })

  test('an envelope of exactly 1 MiB from a bare object is returned', async () => {
    const c = makeCase()
    const req = await request()
    const usage = { input_tokens: 1, output_tokens: 1 }
    const shaped = n => JSON.stringify({ ...REPLY, notes: [{ text: 'x'.repeat(n) }] })
    const overhead = Buffer.byteLength(JSON.stringify({ outcome: 'returned', wire: { json: shaped(0) }, usage, receipt: { ...req.selection, invocationId: req.callId } }))
    const json = shaped(MIB - overhead)
    const provider = await makeProvider(c, [{ output: json }])
    const envelope = await provider.runLeaf(req)
    assertReturned(envelope, json, req)
    assert.equal(Buffer.byteLength(JSON.stringify(envelope)), MIB)
  })

  test('usage keeps the four counters; cache_write_input_tokens and dollar fields stay dropped', async () => {
    const c = makeCase()
    const usage = { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 1, total_cost_usd: 1.5 }
    const provider = await makeProvider(c, [{ output: JSON.stringify(REPLY), events: [{ type: 'turn.completed', usage }] }])
    const req = await request()
    const envelope = await provider.runLeaf(req)
    assertReturned(envelope, JSON.stringify(REPLY), req)
    assert.deepEqual(envelope.usage, { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1 })
  })
})

// Kept behavior: each of these already gives this code on main and must still give
// it with a bare-object reader.
const KEPT_FAILURES = [
  ['an array', { output: JSON.stringify([REPLY]) }, 'INVALID_WIRE'],
  ['null', { output: 'null' }, 'INVALID_WIRE'],
  ['a string', { output: JSON.stringify(JSON.stringify(REPLY)) }, 'INVALID_WIRE'],
  ['a number', { output: '42' }, 'INVALID_WIRE'],
  ['a boolean', { output: 'true' }, 'INVALID_WIRE'],
  ['text that is not JSON', { output: 'PASS' }, 'INVALID_WIRE'],
  ['a truncated object', { output: JSON.stringify(REPLY).slice(0, -1) }, 'INVALID_WIRE'],
  ['a non-finite number (1e999 would become null)', { output: '{"verdict":"PASS","count":1e999,"notes":[],"extra":null}' }, 'INVALID_WIRE'],
  ['nesting past 64 levels', { output: '{"a":' + '['.repeat(70) + ']'.repeat(70) + '}' }, 'INVALID_WIRE'],
  ['an empty file', { output: '' }, 'NO_OUTPUT'],
  ['no output file', {}, 'NO_OUTPUT'],
]

describe('CP-02h provider: what is not one bare object fails as before', () => {
  for (const [name, step, expected] of KEPT_FAILURES) {
    test(`${expected}: ${name}`, async () => {
      const c = makeCase()
      const provider = await makeProvider(c, [step])
      const req = await request()
      assertFailed(await provider.runLeaf(req), expected, req)
      assert.equal(calls(c).length, 1, 'exactly one spawn, no retry')
    })
  }

  test('INVALID_WIRE: invalid UTF-8 inside an object', async () => {
    const c = makeCase()
    const source = join(c.stubDir, 'bad-utf8')
    writeFileSync(source, Buffer.concat([Buffer.from('{"verdict":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]))
    const provider = await makeProvider(c, [{ outputFrom: source }])
    const req = await request()
    assertFailed(await provider.runLeaf(req), 'INVALID_WIRE', req)
  })

  test('INVALID_WIRE: a symlink to a valid bare object is not followed', async () => {
    const c = makeCase()
    const target = join(c.stubDir, 'elsewhere.json')
    writeFileSync(target, JSON.stringify(REPLY))
    const provider = await makeProvider(c, [{ outputKind: 'symlink', target }])
    const req = await request()
    assertFailed(await provider.runLeaf(req), 'INVALID_WIRE', req)
  })

  test('INVALID_WIRE: a FIFO is refused without blocking', { skip: !existsSync('/usr/bin/mkfifo') && 'no /usr/bin/mkfifo', timeout: 10_000 }, async () => {
    const c = makeCase()
    const provider = await makeProvider(c, [{ outputKind: 'fifo' }])
    const req = await request()
    assertFailed(await provider.runLeaf(req), 'INVALID_WIRE', req)
  })

  test('INVALID_WIRE: an output file over 1 MiB, even when its object is small', async () => {
    const c = makeCase()
    const source = join(c.stubDir, 'padded.json')
    writeFileSync(source, JSON.stringify(REPLY) + ' '.repeat(MIB))
    const provider = await makeProvider(c, [{ outputFrom: source }])
    const req = await request()
    assertFailed(await provider.runLeaf(req), 'INVALID_WIRE', req)
  })

  test('INVALID_WIRE: a file under 1 MiB whose envelope would be over 1 MiB', async () => {
    const c = makeCase()
    const req = await request()
    const usage = { input_tokens: 1, output_tokens: 1 }
    const shaped = n => JSON.stringify({ ...REPLY, notes: [{ text: 'x'.repeat(n) }] })
    const overhead = Buffer.byteLength(JSON.stringify({ outcome: 'returned', wire: { json: shaped(0) }, usage, receipt: { ...req.selection, invocationId: req.callId } }))
    const json = shaped(MIB - overhead + 1)
    assert.ok(Buffer.byteLength(json) <= MIB)
    const provider = await makeProvider(c, [{ output: json }])
    assertFailed(await provider.runLeaf(req), 'INVALID_WIRE', req)
  })

  test('NO_OUTPUT: a stale bare object from an earlier attempt is never read; the stale schema is replaced', async () => {
    const c = makeCase()
    const req = await request()
    mkdirSync(c.runDir, { recursive: true })
    writeFileSync(join(c.runDir, `${req.callId}.output.json`), JSON.stringify(REPLY))
    writeFileSync(join(c.runDir, `${req.callId}.schema.json`), 'stale')
    const provider = await makeProvider(c, [{}])
    assertFailed(await provider.runLeaf(req), 'NO_OUTPUT', req)
    assert.equal(calls(c)[0].schema, JSON.stringify(await strictOf(req.schema)))
  })
})

describe('CP-02h provider: SCHEMA_UNSUPPORTED and request checks', () => {
  const S = SCHEMA_SENTINEL
  const UNRUNNABLE = [
    ['an optional property', obj({ a: STR, [S]: STR }, ['a'])],
    ['additionalProperties: true', obj({ [S]: STR }, [S], { additionalProperties: true })],
    ['an array with no items', obj({ [S]: { type: 'array' } })],
    ["a type array ['null', x]", obj({ [S]: { type: ['null', 'string'] } })],
    ['a nullable object root', { type: ['object', 'null'], properties: { [S]: STR }, required: [S] }],
    ['a string root', { type: 'string', description: S }],
  ]
  for (const [name, schema] of UNRUNNABLE) {
    test(`SCHEMA_UNSUPPORTED: ${name}, with zero spawns and no file`, async () => {
      const c = makeCase()
      const provider = await makeProvider(c, [{ output: JSON.stringify(REPLY) }])
      const req = await request({ schema: deepClone(schema) })
      const envelope = await provider.runLeaf(req)
      assertFailed(envelope, 'SCHEMA_UNSUPPORTED', req)
      assert.equal(envelope.usage, null)
      assert.equal(calls(c).length, 0)
      assert.equal(existsSync(c.runDir), false, 'no schema, output or log file')
      assert.deepEqual(req.schema, schema, 'request.schema was mutated')
    })
  }

  test('PROFILE_UNSUPPORTED comes before SCHEMA_UNSUPPORTED', async () => {
    // CP-08 amendment: release-controlled is no longer refused.
    for (const profile of ['audit-source-only']) {
      const c = makeCase()
      const provider = await makeProvider(c, [{ output: JSON.stringify(REPLY) }])
      const req = await request({ profile, schema: obj({ a: STR, b: STR }, ['a']) })
      assertFailed(await provider.runLeaf(req), 'PROFILE_UNSUPPORTED', req)
      assert.equal(calls(c).length, 0)
      assert.equal(existsSync(c.runDir), false)
    }
  })

  test('SCHEMA_UNSUPPORTED comes before TIMEOUT', async () => {
    const c = makeCase()
    const provider = await makeProvider(c, [{ output: JSON.stringify(REPLY) }])
    const req = await request({ deadlineMs: Date.now() + 100, schema: obj({ a: STR, b: STR }, ['a']) })
    assertFailed(await provider.runLeaf(req), 'SCHEMA_UNSUPPORTED', req)
    assert.equal(calls(c).length, 0)
    assert.equal(existsSync(c.runDir), false)
  })

  const BAD = [
    ['an invalid schema type', () => request({ schema: { type: `bogus-${S}` } })],
    ['a non-object schema', () => request({ schema: S })],
    ['a null schema', () => request({ schema: null })],
    ['a schema whose minimum exceeds its maximum', () => request({ schema: obj({ a: { type: 'number', minimum: 2, maximum: 1 } }) })],
    ['the strict schema as wireSchema', async () => request({ wireSchema: deepClone(LEAF_STRICT) })],
    ['the leaf schema as wireSchema', async () => request({ wireSchema: deepClone(LEAF_SCHEMA) })],
  ]
  for (const [name, make] of BAD) {
    test(`rejects ${name} with INVALID_RUNTIME_INPUT before any file or spawn`, async () => {
      const c = makeCase()
      const provider = await makeProvider(c, [{ output: JSON.stringify(REPLY) }])
      await assert.rejects(provider.runLeaf(await make()), error => error?.code === 'INVALID_RUNTIME_INPUT' && error.message === RUNTIME_MESSAGE)
      assert.equal(calls(c).length, 0)
      assert.equal(existsSync(c.runDir), false)
    })
  }
})

// ------------------------------------------------------------ through runtime
// The real runtime and harness-repair template with the NR-02 in-memory store.
// The provider is wrapped only to record the schema each request carried.
async function harnessRun(t, steps) {
  const c = makeCase()
  const real = await makeProvider(c, steps)
  const carried = []
  const provider = Object.freeze({ async runLeaf(req) { carried.push(req.schema); return real.runLeaf(req) } })
  const f = await fixture(t, { cap: 1, provider })
  const result = await f.runtime.run('harness-repair', { repo: '/inert/project' }, { invocationId: 'cp-02h-harness' })
  return { c, result, carried, rows: [...f.checkpoints.rows.values()], spawned: calls(c) }
}

describe('CP-02h through the real runtime (wiring proof, not runtime certification)', () => {
  test('harness-repair completes on three bare-object leaves; completionFor and decode accept each', async t => {
    const replies = [pass(), review(), review()]
    const { c, result, carried, rows, spawned } = await harnessRun(t, replies.map(value => ({ output: JSON.stringify(value) })))
    assert.equal(result.status, 'done')
    assert.equal(spawned.length, 3)
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.map(r => r.binding.agentType), ['checker', 'reviewer', 'qa-auditor'])
    for (const [i, row] of rows.entries()) {
      assert.equal(row.state, 'completed')
      assert.equal(row.completion.outcome, 'returned')
      assert.equal(row.completion.wire.json, JSON.stringify(replies[i]))
      assert.deepEqual(row.completion.receipt, { provider: 'codex', model: 'fake-model', effort: 'high', invocationId: row.binding.callId })
      const schemaFile = join(c.runDir, `${row.binding.callId}.schema.json`)
      assert.equal(argValue(spawned[i].argv, '--output-schema'), schemaFile)
      assert.equal(readFileSync(schemaFile, 'utf8'), JSON.stringify(await strictOf(carried[i])))
      assert.equal(spawned[i].schema, readFileSync(schemaFile, 'utf8'))
      assert.equal(statSync(schemaFile).mode & 0o777, 0o600)
      assert.equal(sha(spawned[i].stdin), row.binding.promptHash)
    }
  })

  // The 2026-11-20 live smoke: the checker returned failures[].excerpt as an array.
  test('live-smoke regression: the checker schema declares excerpt a string; an array excerpt is returned, decode rejects it, one escalate', async t => {
    const smoke = { verify_block: 'bash: /inert/home/.claude/skills/verify/verify.sh: No such file or directory', verdict: 'FAIL',
      failures: [{ step: 'bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/verify/verify.sh"', exit: 127,
        excerpt: ['bash: /inert/home/.claude/skills/verify/verify.sh: No such file or directory'], error_key: 'verify.sh:not_found' }] }
    const { c, result, carried, rows, spawned } = await harnessRun(t, [{ output: JSON.stringify(smoke) }, { output: JSON.stringify(review()) }])
    assert.equal(result.status, 'escalate')
    assert.equal(spawned.length, 1, 'the graph escalated after one spawn')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].binding.agentType, 'checker')

    // What the request carried: the strict checker schema, not the {json} wrapper.
    const declared = JSON.parse(readFileSync(join(c.runDir, `${rows[0].binding.callId}.schema.json`), 'utf8'))
    assert.equal(declared.additionalProperties, false)
    assert.equal(declared.properties.failures.type, 'array')
    assert.equal(declared.properties.failures.items.additionalProperties, false)
    assert.deepEqual(declared.properties.failures.items.properties.excerpt, { type: 'string' })
    assert.ok(declared.properties.failures.items.required.includes('excerpt'))
    assert.equal(Object.hasOwn(declared.properties, 'json'), false)

    // The reply is durable returned evidence; decode fails it as an ordinary leaf error.
    assert.equal(rows[0].state, 'completed')
    assert.equal(rows[0].completion.outcome, 'returned')
    assert.equal(rows[0].completion.wire.json, JSON.stringify(smoke))
    const { encodeOutputContract } = await loadSchema()
    assert.throws(() => encodeOutputContract(carried[0]).decode(rows[0].completion.wire), error => error?.code === 'INVALID_RESULT')
  })
})
