// CP-02f frozen acceptance: harness-repair and dev-build (nested QA) through the
// CP-02e host CLI on a fake codex, a schema sweep over the six registered graphs,
// and the catalog evidence pointer (spec/contracts/codex-parity-cp-02f.md).
// Wiring proof, not runtime certification: no real codex, no claude, no network,
// no HOME. The CLI cases spawn the real host CLI, which builds the real CP-02b
// provider around the fake codex fixture acceptance/codex-parity/cp-02f-fake-codex.cjs
// (copied into an owned temp directory). The installation root is an owned fixture
// copied from the candidate tree with only `dev`'s codex row flipped to partial.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ROOT, devAnswer, fixture, pass, plan, reconArgs, research, review } from '../native-runtime/nr-02-runtime-support.mjs'

const HOST_PATH = resolve(ROOT, 'core/skills/native-runtime/graph-host.mjs')
const FAKE_CODEX = fileURLToPath(new URL('./cp-02f-fake-codex.cjs', import.meta.url))
const CATALOG = 'spec/offering-capabilities.json'
const PROOF_REF = 'cp-02f-host-wiring'
const loadModule = rel => import(pathToFileURL(resolve(ROOT, rel)).href)
const sha = value => createHash('sha256').update(value).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const pretty = value => JSON.stringify(value, null, 2)

// ---------------------------------------------------------------- fixture root
// Copies only what the host reads: the catalog, the six workflow templates, every
// role file and every SKILL.md. Regular files only; symlinks are skipped.
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
    for (const s of dirs(`${c}/skills`)) copy(`${c}/skills/${s}/SKILL.md`)
  }
}
// The same partial row CP-02e's fixture uses. A fixture value, never a production row.
const PARTIAL = Object.freeze({ implementation: 'partial', transportId: 'codex-autobuild',
  limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] })

let WORK, FIXTURE_ROOT, PREFIXES
const QA_ROLES = ['checker', 'fixer', 'reviewer', 'advisor', 'qa-auditor']
const DEV_ROLES = ['planner', 'advisor', 'scout', 'implementer', 'checker', 'acceptance-auditor']
// Built on first use, so a candidate without the v2 catalog or role loader fails each case on its own.
async function root() {
  if (FIXTURE_ROOT) return FIXTURE_ROOT
  const dir = realpathSync(mkdtempSync(join(WORK, 'root-')))
  copyTree(dir)
  const catalog = readJson(join(dir, CATALOG))
  const row = catalog.offerings.find(o => o.id === 'dev')
  assert.ok(row?.providers?.codex, 'the candidate catalog is v2 with provider rows (CP-01b)')
  row.providers.codex = structuredClone(PARTIAL)
  writeFileSync(join(dir, CATALOG), JSON.stringify(catalog, null, 2) + '\n')
  // Each role is identified by the instructions the host prepends to its prompt.
  const { assembleRoleInstructions } = await loadModule('core/skills/native-runtime/role-files.mjs')
  PREFIXES = [...new Set([...QA_ROLES, ...DEV_ROLES])]
    .map(role => ({ role, prefix: assembleRoleInstructions({ installationRoot: dir, name: role }).instructions + '\n\n' }))
  FIXTURE_ROOT = dir
  return dir
}

before(() => { WORK = realpathSync(mkdtempSync(join(tmpdir(), 'cp-02f-'))) })
after(() => rmSync(WORK, { recursive: true, force: true }))

// --------------------------------------------------------------------- replies
// One component; every string carries bytes a re-encoding would change.
const PLAN = Object.freeze({
  goal: 'Fixture goal: "quoted", back\\slash, ${not-a-template}, é ü 中文 — and a tab\there',
  acceptance: [{ id: 'AC1', criterion: 'Returns "ok" for a\\b ${x} – ünïcode ✓', protects: 'the CP-02f plan-bytes rule',
    fails_when: 'any byte of the plan is re-encoded\nor dropped', no_claim: 'runtime certification' }],
  components: [{ id: 'C1', title: 'Component "C1" with \\ and ${y}', files: ['src/a.js'], depends_on: [],
    tests: ['tests/a.test.js'], owners_used: [], owners_created: [] }],
  behavior_changes: ['adds "x" \\ ${z} ⚠'],
  out_of_scope: ['ñ everything else'],
  risks: [{ risk: 'r "1"', mitigation: 'm \\1' }],
  questions: [],
})
const wire = value => ({ json: JSON.stringify(value) })
const GATE_APPROVE = { verdict: 'approve', issues: [], questions: [] }
const HAPPY = Object.freeze({
  checker: wire(pass()), reviewer: wire(review()), 'qa-auditor': wire(review()),
  scout: wire(devAnswer({ agentType: 'scout' })), implementer: wire(devAnswer({ agentType: 'implementer' })),
  'acceptance-auditor': wire(devAnswer({ agentType: 'acceptance-auditor' })),
  planner: wire(plan()), advisor: wire(GATE_APPROVE),
})

// ------------------------------------------------------------------ CLI helpers
// One owned directory per case. bin/ holds `node` (for the fixture's
// `#!/usr/bin/env node`) and a recording `claude` stub; it is the only PATH of
// both the host CLI and every leaf. The fake codex lives outside PATH.
function makeCase(replies = HAPPY) {
  const dir = realpathSync(mkdtempSync(join(WORK, 'case-')))
  const c = { dir, runDir: join(dir, 'run'), repo: join(dir, 'repo'), cwd: join(dir, 'cwd'), fake: join(dir, 'fake'),
    bin: join(dir, 'bin'), codex: join(dir, 'codex-bin', 'codex'), claudeCalls: join(dir, 'claude-calls.jsonl') }
  for (const d of [c.repo, c.cwd, c.fake, c.bin, dirname(c.codex)]) mkdirSync(d)
  symlinkSync(process.execPath, join(c.bin, 'node'))
  writeFileSync(join(c.bin, 'claude'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(c.claudeCalls)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`)
  chmodSync(join(c.bin, 'claude'), 0o755)
  cpSync(FAKE_CODEX, c.codex)
  chmodSync(c.codex, 0o755)
  writeFileSync(join(c.fake, 'script.json'), JSON.stringify({ roles: PREFIXES, replies }))
  return c
}
// The leaf env is the args file's env, exactly. The host CLI's own env has a marker
// that must never reach a leaf (the host adds or merges nothing).
const leafEnv = c => ({ PATH: c.bin, FAKE_CODEX_DIR: c.fake })
const hostEnv = c => ({ PATH: c.bin, CP02F_HOST_ONLY: 'host-marker' })
function argsFile(c, patch = {}, name = 'args.json') {
  const value = { schemaVersion: 1, installationRoot: FIXTURE_ROOT, workflowId: 'harness-repair', offeringId: 'dev',
    invocationId: 'inv-02f', args: { repo: c.repo }, runDir: c.runDir, codexBin: c.codex, cwd: c.cwd, env: leafEnv(c),
    timeoutMs: 60000, maxConcurrentSubagents: 1, graceMs: 200, ...patch }
  const path = join(c.dir, name)
  writeFileSync(path, JSON.stringify(value))
  return path
}
function cli(c, file) {
  return new Promise(done => {
    const child = spawn(process.execPath, [HOST_PATH, '--args-file', file], { env: hostEnv(c), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => done({ code, stdout, stderr }))
  })
}
const calls = c => lines(join(c.fake, 'calls.jsonl'))
function checkpointRows(c) {
  const dir = join(c.runDir, 'checkpoints')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => /^nr-[0-9a-f]{64}\.json$/.test(name)).map(name => readJson(join(dir, name)))
}
const resultOf = c => readJson(join(c.runDir, 'result.json'))
const MODEL = { checker: 'gpt-6-luna' }
const SANDBOX = { checker: 'workspace-write', implementer: 'workspace-write' }
function assertStatus(r, status) {
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, JSON.stringify({ status }) + '\n')
  assert.equal(r.stderr, '')
}
// Every spawn ran the fake codex as given, here, with exactly the args file's env,
// the CP-02c model, the CP-02b sandbox and --ignore-user-config; none was unknown.
function assertLeaves(c, roles) {
  const seen = calls(c)
  assert.deepEqual(seen.map(call => call.role), roles, 'spawn order')
  for (const call of seen) {
    assert.equal(call.cwd, c.cwd)
    assert.deepEqual(Object.keys(call.env).filter(k => k !== '__CF_USER_TEXT_ENCODING').sort(), ['FAKE_CODEX_DIR', 'PATH'])
    assert.equal(call.env.PATH, c.bin)
    assert.equal(call.sandbox, SANDBOX[call.role] ?? 'read-only', `${call.role} sandbox`)
    assert.equal(call.model, MODEL[call.role] ?? 'gpt-6.1-sol', `${call.role} model`)
    assert.ok(call.argv.includes('--ignore-user-config'))
    assert.equal(dirname(call.argv[call.argv.indexOf('--output-last-message') + 1]), join(c.runDir, 'provider'))
  }
  // Every spawn is one dispatched checkpoint row, and no claude binary ever ran.
  assert.equal(checkpointRows(c).filter(row => row.state === 'returned' || row.state === 'failed').length, seen.length)
  assert.equal(existsSync(c.claudeCalls), false, 'a claude binary was invoked')
  return seen
}
const devArgs = c => ({ repo: c.repo, plan: structuredClone(PLAN), planApproved: true })
const DEV_ORDER = ['scout', 'implementer', 'checker', 'acceptance-auditor', 'checker', 'reviewer', 'qa-auditor']

// ===================================================== harness-repair (CLI, real spawns)
describe('CP-02f harness-repair through the host CLI on a fake codex (wiring proof)', () => {
  test('exactly 3 spawns in graph order; checker workspace-write, reviewer and qa-auditor read-only', async () => {
    await root()
    const c = makeCase()
    assertStatus(await cli(c, argsFile(c)), 'done')
    const seen = assertLeaves(c, ['checker', 'reviewer', 'qa-auditor'])
    assert.deepEqual(seen.map(call => call.sandbox), ['workspace-write', 'read-only', 'read-only'])
    const rows = checkpointRows(c)
    assert.equal(rows.length, 3)
    for (const row of rows) {
      assert.equal(row.state, 'returned')
      assert.deepEqual(row.binding.workflowPath, ['harness-repair'])
      const call = seen.find(s => s.role === row.binding.agentType)
      const own = call.stdin.slice(PREFIXES.find(p => p.role === call.role).prefix.length)
      assert.equal(sha(own), row.binding.promptHash, `${call.role}: the stdin after the role instructions is the workflow prompt`)
      assert.ok(own.includes(`Repo: ${c.repo}.`))
    }
    const result = resultOf(c)
    assert.deepEqual([result.workflowId, result.offeringId, result.status, result.result.status], ['harness-repair', 'dev', 'done', 'done'])
  })
})

// ========================================================== dev-build (CLI, nested QA)
describe('CP-02f dev-build with an approved plan through the host CLI (nested QA, wiring proof)', () => {
  test('no planner call; nested QA leaves carry workflowPath [dev-build, harness-repair]; the plan bytes reach the leaves', async () => {
    await root()
    const c = makeCase()
    assertStatus(await cli(c, argsFile(c, { workflowId: 'dev-build', args: devArgs(c) })), 'done')
    const seen = assertLeaves(c, DEV_ORDER)
    assert.ok(!seen.some(call => call.role === 'planner' || call.role === 'advisor'), 'an approved plan is never planned or gated')

    const rows = checkpointRows(c)
    assert.equal(rows.length, DEV_ORDER.length)
    for (const row of rows) {
      assert.equal(row.state, 'returned')
      const nested = row.binding.workflowId === 'harness-repair'
      assert.deepEqual(row.binding.workflowPath, nested ? ['dev-build', 'harness-repair'] : ['dev-build'], row.binding.label)
    }
    assert.deepEqual(rows.filter(row => row.binding.workflowId === 'harness-repair').map(row => row.binding.agentType).sort(),
      ['checker', 'qa-auditor', 'reviewer'])

    // The plan from the args file reaches each leaf byte for byte, as the workflow prints it.
    const stdin = role => seen.find(call => call.role === role).stdin
    const component = pretty(PLAN.components[0]), acceptance = pretty(PLAN.acceptance)
    for (const role of ['scout', 'implementer', 'acceptance-auditor']) assert.ok(stdin(role).includes(acceptance), `${role} acceptance`)
    for (const role of ['scout', 'implementer']) assert.ok(stdin(role).includes(component), `${role} component`)
    assert.ok(stdin('scout').includes(`Goal: ${PLAN.goal}\n`))
    assert.ok(stdin('implementer').includes(`Planned behavior changes: ${pretty(PLAN.behavior_changes)}`))
    assert.ok(stdin('implementer').includes(`Out of scope: ${pretty(PLAN.out_of_scope)}`))
    assert.ok(stdin('acceptance-auditor').includes(pretty(PLAN.behavior_changes)))

    const result = resultOf(c)
    assert.deepEqual([result.workflowId, result.offeringId, result.status], ['dev-build', 'dev', 'done'])
    assert.deepEqual(result.result.plan, { ...structuredClone(PLAN), kept_changes: [] })
    assert.equal(result.result.planRounds, 0)
    assert.equal(result.result.qa.status, 'done')
  })
})

// ================================================================ refusal (CLI)
describe('CP-02f a provider refusal escalates and is never retried or rerouted to Claude', () => {
  const refusedRow = (c, workflowPath) => {
    const rows = checkpointRows(c).filter(row => row.binding.agentType === 'reviewer')
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0].binding.workflowPath, workflowPath)
    assert.equal(rows[0].state, 'failed')
    assert.equal(rows[0].completion.outcome, 'failed')
    assert.equal(rows[0].completion.code, 'PROVIDER_REFUSAL')
  }

  test('harness-repair: the refused reviewer runs once, the graph escalates, and a rerun replays it with zero spawns', async () => {
    await root()
    const c = makeCase({ ...HAPPY, reviewer: { refuse: true } })
    const file = argsFile(c)
    assertStatus(await cli(c, file), 'escalate')
    assertLeaves(c, ['checker', 'reviewer'])
    refusedRow(c, ['harness-repair'])
    const bytes = readFileSync(join(c.runDir, 'result.json'))
    assert.equal(resultOf(c).result.status, 'escalate')

    assertStatus(await cli(c, file), 'escalate')
    assertLeaves(c, ['checker', 'reviewer'])
    assert.deepEqual(readFileSync(join(c.runDir, 'result.json')), bytes)
  })

  test('dev-build: a refusal in the nested QA escalates both graphs, once, with no claude call', async () => {
    await root()
    const c = makeCase({ ...HAPPY, reviewer: { refuse: true } })
    const file = argsFile(c, { workflowId: 'dev-build', args: devArgs(c) })
    assertStatus(await cli(c, file), 'escalate')
    const order = DEV_ORDER.slice(0, 6)
    assertLeaves(c, order)
    refusedRow(c, ['dev-build', 'harness-repair'])
    const result = resultOf(c).result
    assert.equal(result.status, 'escalate')
    assert.equal(result.qa.status, 'escalate')

    assertStatus(await cli(c, file), 'escalate')
    assertLeaves(c, order)
  })
})

// ============================================================ schema sweep (runtime)
// Every agent() call encodes its schema with schema.mjs before anything is reserved
// or dispatched, and the runtime stops the run on INVALID_SCHEMA. So a scripted run
// that returns proves the schema of every node it reached. Nodes are the catalog's
// `roles` per workflow (one entry per graph node); a node is reached when some run
// dispatched its role in that workflow under a distinct phase. Runtime-level proof
// with an in-memory provider (nr-02 support), not a Codex run.
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
const HIGH = { severity: 'HIGH', title: 'fixture finding', file: 'src/a.js', line: 1, why: 'inert', fix: 'inert' }
const FIX = { fixed: ['fixture finding'], unfixed: [], touched: ['src/a.js'], verify_verdict: 'PASS', summary: 'inert' }
const DEV = (n, req) => devAnswer(req)
const QA_BASE = { checker: () => pass(), reviewer: () => review(), 'qa-auditor': () => review() }
// blueprint-design: one scenario per stage.
const STAGE_ARGS = { repo: '/inert/project', statePath: '/inert/state.json', mode: 'app', requirements: ['R1'], decisions: [], assumptions: [] }
const BLUEPRINT = [
  ['blueprint-design', { repo: '/inert/project', request: 'inert request' }, {
    extractor: () => ({ goal: 'inert', mode: 'app', users: [], requirements: [{ id: 'R1', text: 'inert', source: 'request' }],
      decided: [], gaps: [], contradictions: [], constraints: [], existing_stack: 'inert' }) }],
  ['blueprint-design', { ...STAGE_ARGS, stage: 'design' }, {
    architect: () => ({ summary: 'inert', modules: [{ id: 'M1', name: 'inert', responsibility: 'inert', requirements: ['R1'], boundary: false,
      shapes: [], pick: '', depth_reason: '' }], failure_modes: [], adrs: [], departures: [], honors: [], conflicts: [], knowledge: [], premises: [] }),
    advisor: () => GATE_APPROVE }],
  ['blueprint-design', { ...STAGE_ARGS, stage: 'backlog', designPath: '/inert/run2.json', knowledge: [] }, {}],
]
// release-flow: docs, then land on a mergeable snapshot, then verify with a failed target.
const SNAPSHOT = { pr: { number: 1, state: 'OPEN', headRefOid: 'abc1234', headRefName: 'feature', baseRefName: 'main',
  mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', isDraft: false, mergeCommit: '' },
default_branch: 'main', merge_methods: ['squash'], checks: [], deploy: { source: 'config', merge_method: 'squash', targets: [], missing_credentials: [] } }
const RELEASE = [
  ['release-flow', { repo: '/inert/project', pr: 1, stage: 'docs' }, {}],
  ['release-flow', { repo: '/inert/project', pr: 1, stage: 'land', approval: { pr: 1, head: 'abc1234', base: 'main' } }, {
    'release-checker': () => SNAPSHOT, merger: () => ({ outcome: 'MERGED', merge_sha: 'abc1234', by_this_attempt: true, detail: 'inert' }) }],
  ['release-flow', { repo: '/inert/project', pr: 1, stage: 'verify', mergeSha: 'abc1234',
    targets: [{ name: 'web', workflow: '', status_command: '', health: '' }] }, {
    'deploy-watcher': () => ({ targets: [{ name: 'web', evidence: 'FAILED', health: 'FAIL', detail: 'inert' }] }),
    advisor: () => ({ action: 'investigate', diagnosis: 'inert', evidence: 'inert' }) }],
]
// bughunt-flow (fix): one logic finding the skeptic contests and the referee leaves real;
// the reproduction, fix check, adversarial tests and commit are scripted runner lines
// (evidence.mjs output shapes), and the repair is accepted by the fix verifier.
const CANDIDATE = { file_path: 'src/feature.js', line_range: [1, 1], bug_category: 'logic', severity: 'HIGH', confidence: 90,
  title: 'Negative result violates total contract', description: 'inert', failure_scenario: { trigger: 'inert', path: 'src/feature.js:1', observable: 'inert' },
  expected_behavior: 'inert', actual_behavior: 'inert', evidence: [{ file: 'src/feature.js', line: 1, quote: 'inert' }] }
// security-audit-flow: the stages whose input is small enough to script. validate and
// verify need audit-verdicts.mjs / audit-verify.mjs records and stay unproven.
const text = keys => Object.fromEntries(keys.map(k => [k, 'inert']))
const audit = (stage, parts, extra = {}) => ({ ...reconArgs(), stage, parts, ...extra })
const REGISTRY = { ordinary: [], companions: [] }
const AUDIT = [
  ['security-audit-flow', reconArgs(), { 'audit-researcher': (n, req) => research(req) }],
  ['security-audit-flow', audit('recon', { ...text(['ranking', 'architectureSummary', 'ledger']), registry: REGISTRY }, { part: 'synthesize',
    facts: [{ agent: '1a', items: [{ text: 'ordinary fact', refs: ['src/app.js:1'] }], limits: [] }], profile: 'inert', scope_paths: [], prior: {} }), {}],
  ['security-audit-flow', audit('hunt', text(['hunterMethod', 'promotion', 'validationRules', 'hunterResult', 'schema_confirmed', 'schema_needs_validation']), {
    wave: 1, architecture_md: 'inert', blocks: {},
    hunters: [{ agent_id: 'h1-01', exclusions: [], peers: [], units: [{ coverage_id: 'u1', selected_companion_blocks: [], excluded_blocks: [] }] }] }), {}],
  ['security-audit-flow', audit('critic', text(['criticSection']), { kind: 'post-wave', wave: 1, architecture_md: 'inert', ledger: [], candidates: [], prior: {} }), {}],
  ['security-audit-flow', audit('mint', { ...text(['ledger']), registry: REGISTRY }, { kind: 'post-wave', wave: 1, proposals: [{}],
    architecture_md: 'inert', profile: 'inert', scope_paths: [], existing: [] }), {}],
  ['security-audit-flow', audit('consolidate', text(['consolidation']), { architecture_md: 'inert', candidates: [{ fingerprint: 'a' }, { fingerprint: 'b' }] }), {}],
]
const EVIDENCE_LINES = { run: 'EVIDENCE: REPRODUCED F1', fix: 'FIX: PASS F1', adversarial: 'ADVERSARIAL: PASS F1',
  commit: `COMMIT: DONE F1 ${'a'.repeat(40)}`, revert: 'REVERT: DONE F1' }
const BUGHUNT = [
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
// Each scenario: the workflow, its args, and replies keyed by role (n counts that
// role's calls); a role without a reply gets the minimal value its schema allows.
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
  ...BLUEPRINT, ...RELEASE, ...BUGHUNT,
  ...AUDIT,
]
// Unreached at this freeze: security-audit-flow's Validate analyst and its two Verify
// nodes (verifier audit-researcher, reverifier audit-analyst).
const EXPECTED_UNPROVEN = { 'blueprint-design': [], 'bughunt-flow': [], 'dev-build': [], 'harness-repair': [], 'release-flow': [],
  'security-audit-flow': ['audit-analyst', 'audit-analyst', 'audit-researcher'] }

describe('CP-02f schema sweep over the six registered graphs', () => {
  test('no reached node gives INVALID_SCHEMA or UNSUPPORTED_SCHEMA; unreached nodes are listed as unproven', async t => {
    const { encodeOutputContract } = await loadModule('core/skills/native-runtime/schema.mjs')
    const catalog = readJson(resolve(ROOT, CATALOG))
    const inventory = Object.fromEntries(catalog.workflows.map(w => [w.source.replace(/^.*\/([^/]+)\.js$/, '$1'), w.roles]))
    assert.deepEqual(Object.keys(inventory).sort(), ['blueprint-design', 'bughunt-flow', 'dev-build', 'harness-repair', 'release-flow', 'security-audit-flow'])
    const reached = new Map()   // workflowId -> Map(agentType -> Set(phase))
    for (const [index, [workflowId, args, replies]] of SCENARIOS.entries()) {
      const counts = new Map()
      const answer = req => {
        // The runtime already encoded this schema; encode it again to name the code if it fails.
        assert.doesNotThrow(() => encodeOutputContract(req.schema), `${req.workflowId} ${req.agentType} schema`)
        const node = reached.get(req.workflowId) ?? new Map()
        reached.set(req.workflowId, node.set(req.agentType, (node.get(req.agentType) ?? new Set()).add(req.phase)))
        const n = (counts.get(req.agentType) ?? 0) + 1
        counts.set(req.agentType, n)
        const reply = replies[req.agentType]
        return reply ? reply(n, req) : synth(req.schema)
      }
      const f = await fixture(t, { cap: 1, answer })
      let outcome
      try { outcome = await f.runtime.run(workflowId, args, { invocationId: `sweep-${index}` }) }
      catch (error) { assert.fail(`${workflowId} scenario ${index} rejected with ${error?.code}`) }
      assert.equal(typeof outcome?.status, 'string', `${workflowId} scenario ${index} returned a status`)
    }
    const unproven = {}
    for (const [workflowId, roles] of Object.entries(inventory)) {
      const left = [...roles]
      for (const [role, phases] of reached.get(workflowId) ?? new Map()) {
        for (let k = 0; k < phases.size; k++) { const i = left.indexOf(role); if (i >= 0) left.splice(i, 1) }
      }
      unproven[workflowId] = left.sort()
      t.diagnostic(`${workflowId}: ${roles.length - left.length}/${roles.length} nodes reached; unproven: ${left.length ? left.join(', ') : 'none'}`)
    }
    assert.deepEqual(unproven['harness-repair'], [], 'every harness-repair node is reached')
    assert.deepEqual(unproven['dev-build'], [], 'every dev-build node is reached')
    assert.deepEqual(unproven, EXPECTED_UNPROVEN)
  })
})

// ===================================================================== catalog
describe('CP-02f catalog', () => {
  test('the drift guard passes on the candidate root', async () => {
    const { checkCatalogDrift } = await loadModule('core/skills/native-runtime/catalog.mjs')
    assert.deepEqual(checkCatalogDrift({ installationRoot: ROOT }), { ok: true, problems: [] })
  })

  test(`dev records the wiring proof as proofRef ${PROOF_REF}; the fixture flip changes only dev's codex row`, async () => {
    const production = readJson(resolve(ROOT, CATALOG))
    const dev = production.offerings.find(o => o.id === 'dev')
    assert.ok(Array.isArray(dev?.proofRefs) && dev.proofRefs.includes(PROOF_REF), `dev proofRefs include ${PROOF_REF}`)
    assert.equal(production.offerings.filter(o => o.proofRefs?.includes(PROOF_REF)).length, 1, 'only dev carries it')
    const flipped = readJson(join(await root(), CATALOG))
    flipped.offerings.find(o => o.id === 'dev').providers.codex = dev.providers.codex
    assert.deepEqual(flipped, production)
  })
})
