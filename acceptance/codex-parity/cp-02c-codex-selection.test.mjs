// CP-02c frozen acceptance: role-to-profile table and Codex leaf selection
// (spec/contracts/codex-parity-cp-02c.md). Wiring proof, not runtime
// certification: no real codex, no network, no HOME, no child process. The
// expected table is derived from the role files on disk (CP-03c loader) and the
// catalog's workflow rows. Runtime cases drive the real runtime.mjs and real graph
// templates with the NR-02 recording checkpoint port and a recording provider, so
// "before any reserve or spawn" is observed, not assumed.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, PATHS, fixture, completion, devAnswer, plan, pass, review, reconArgs } from '../native-runtime/nr-02-runtime-support.mjs'

const url = path => pathToFileURL(resolve(ROOT, path)).href
const loadSelection = () => import(url('core/skills/native-runtime/codex-selection.mjs'))
const loadDoctor = () => import(url('core/skills/run-records/doctor.mjs'))
const loadRuntime = () => import(url('core/skills/native-runtime/runtime.mjs'))
const loadRoles = () => import(url('core/skills/native-runtime/role-files.mjs'))
const loadCatalog = () => import(url('core/skills/native-runtime/catalog.mjs'))
const loadConfig = () => import(url('graphs/autobuild/tool/lib/config.mjs'))

const FIXED_MESSAGE = 'Native runtime: INVALID_SELECTION.'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none']
// CP-08 amendment: release-flow left the refused set.
const REFUSED_WORKFLOWS = ['security-audit-flow']
const WORKFLOW_ID = Object.fromEntries(Object.entries(PATHS).map(([id, path]) => [path, id]))

// A refusal: the fixed code and message, never an echo of any context value.
function refused(fn, ...echo) {
  let thrown
  try { fn() } catch (e) { thrown = e }
  assert.ok(thrown instanceof Error, 'expected a refusal')
  assert.equal(thrown.code, 'INVALID_SELECTION')
  assert.equal(thrown.message, FIXED_MESSAGE)
  for (const value of echo) if (value) assert.ok(!thrown.message.includes(value), 'message echoes input')
}
const runtimeCode = expected => error => { assert.equal(error?.code, expected); return true }

function context(agentType, { workflowId = 'harness-repair', workflowPath, requestedModel = 'sonnet', requestedEffort = 'high' } = {}) {
  return { workflowId, workflowPath: workflowPath ?? [workflowId], agentType, label: `${agentType}: one`, phase: 'Phase',
    requestedModel, requestedEffort }
}

async function catalogRoles() {
  const { loadOfferingCatalog } = await loadCatalog()
  const catalog = loadOfferingCatalog({ installationRoot: ROOT })
  return catalog.workflows.map(row => ({ workflowId: WORKFLOW_ID[row.source], roles: [...new Set(row.roles)] }))
}

// Rules 1-6 of the contract, applied to one role file.
function expectedProfile(role) {
  const tools = role.frontmatter.tools
  if (role.name === 'runner') return null
  if (tools.includes('Edit') || tools.includes('Write')) return 'build-workspace'
  if (role.name === 'checker') return 'build-workspace'
  if (role.root === 'graphs/security-audit') return 'audit-source-only'
  if (role.root === 'graphs/release') return 'release-controlled'
  return 'source-review'
}

async function roleFiles() {
  const { loadRoleFile } = await loadRoles()
  const names = [...new Set((await catalogRoles()).flatMap(w => w.roles))].sort()
  return names.map(name => loadRoleFile({ installationRoot: ROOT, name }))
}

// ------------------------------------------------------------------ the table
describe('CP-02c role-to-profile table', () => {
  test('every role in every catalog workflow row has exactly one profile row, and no other role does', async () => {
    const { ROLE_PROFILES } = await loadSelection()
    const { PROFILES } = await loadRuntime()
    const rows = await catalogRoles()
    assert.deepEqual(rows.map(r => r.workflowId).sort(), Object.keys(PATHS).sort())
    const names = [...new Set(rows.flatMap(w => w.roles))].sort()
    assert.equal(names.length, 27)
    assert.ok(Object.isFrozen(ROLE_PROFILES))
    assert.equal(Object.getPrototypeOf(ROLE_PROFILES), Object.prototype)
    assert.deepEqual(Object.keys(ROLE_PROFILES), names, 'keys are the catalog roles, sorted')
    for (const value of Object.values(ROLE_PROFILES)) assert.ok(value === null || PROFILES.has(value))
  })

  test('the table equals the rules applied to the role files on disk; kit roles have no row', async () => {
    const { ROLE_PROFILES } = await loadSelection()
    const { listRoleFiles } = await loadRoles()
    const files = await roleFiles()
    for (const role of files) assert.notEqual(role.root, 'kit')
    assert.deepEqual({ ...ROLE_PROFILES }, Object.fromEntries(files.map(role => [role.name, expectedProfile(role)])))
    const kit = listRoleFiles({ installationRoot: ROOT }).filter(r => r.root === 'kit').map(r => r.name)
    assert.ok(kit.length > 0)
    for (const name of kit) assert.ok(!Object.hasOwn(ROLE_PROFILES, name))
  })

  test('Edit or Write in tools gives build-workspace; checker is the only build-workspace role without them', async () => {
    const { ROLE_PROFILES } = await loadSelection()
    const files = await roleFiles()
    const writes = role => role.frontmatter.tools.includes('Edit') || role.frontmatter.tools.includes('Write')
    for (const role of files.filter(writes)) assert.equal(ROLE_PROFILES[role.name], 'build-workspace', role.name)
    assert.equal(ROLE_PROFILES.checker, 'build-workspace')
    const without = files.filter(role => ROLE_PROFILES[role.name] === 'build-workspace' && !writes(role)).map(r => r.name)
    assert.deepEqual(without, ['checker'])
    // Bash alone never makes a role build-workspace.
    for (const name of ['advisor', 'reviewer', 'qa-auditor']) {
      assert.ok(files.find(r => r.name === name).frontmatter.tools.includes('Bash'))
      assert.equal(ROLE_PROFILES[name], 'source-review')
    }
  })

  test('the pinned table, row by row', async () => {
    const { ROLE_PROFILES } = await loadSelection()
    const groups = {
      'build-workspace': ['checker', 'fix-verifier', 'fixer', 'implementer', 'repairer', 'reproducer', 'scribe'],
      'source-review': ['acceptance-auditor', 'advisor', 'architect', 'extractor', 'hunter', 'impact-mapper', 'planner',
        'qa-auditor', 'questioner', 'reviewer', 'scout', 'skeptic', 'slicer'],
      'audit-source-only': ['audit-analyst', 'audit-researcher', 'audit-synthesizer'],
      'release-controlled': ['deploy-watcher', 'merger', 'release-checker'],
    }
    for (const [profile, roles] of Object.entries(groups)) for (const role of roles) assert.equal(ROLE_PROFILES[role], profile, role)
    assert.equal(ROLE_PROFILES.runner, null)
  })

  test('CODEX_REFUSED_WORKFLOWS is exactly security-audit-flow', async () => {
    const { CODEX_REFUSED_WORKFLOWS } = await loadSelection()
    assert.ok(Object.isFrozen(CODEX_REFUSED_WORKFLOWS))
    assert.deepEqual([...CODEX_REFUSED_WORKFLOWS], REFUSED_WORKFLOWS)
  })
})

// --------------------------------------------------------- resolveLeaf direct
describe('CP-02c resolveLeaf', () => {
  test('every catalog workflow and role: a Codex selection the runtime accepts, or INVALID_SELECTION', async () => {
    const { resolveLeaf, ROLE_PROFILES } = await loadSelection()
    const { codexModel } = await loadConfig()
    const files = Object.fromEntries((await roleFiles()).map(r => [r.name, r]))
    let accepted = 0
    for (const { workflowId, roles } of await catalogRoles()) {
      for (const agentType of roles) {
        const { model, effort } = files[agentType].frontmatter
        const ctx = context(agentType, { workflowId, requestedModel: model, requestedEffort: effort })
        const profile = ROLE_PROFILES[agentType]
        // CP-08 amendment: release-controlled is accepted in release-flow only.
        if (REFUSED_WORKFLOWS.includes(workflowId) || profile === null || profile === 'audit-source-only' ||
          (profile === 'release-controlled' && workflowId !== 'release-flow')) {
          refused(() => resolveLeaf(ctx), agentType, workflowId)
          continue
        }
        const chosen = resolveLeaf(ctx)
        assert.deepEqual(chosen, { selection: { provider: 'codex', model: codexModel(model), effort }, profile })
        assert.ok(['source-review', 'build-workspace', 'release-controlled'].includes(chosen.profile))
        accepted++
      }
    }
    assert.ok(accepted >= 20)
  })

  test('the result is a fresh plain JSON object with exactly selection and profile', async () => {
    const { resolveLeaf } = await loadSelection()
    const { CODEX_PROVIDER } = await import(url('core/skills/native-runtime/codex-provider.mjs'))
    const a = resolveLeaf(context('checker', { requestedModel: 'haiku' }))
    assert.ok(!(a instanceof Promise))
    assert.equal(a.selection.provider, CODEX_PROVIDER)
    assert.deepEqual(Object.keys(a), ['selection', 'profile'])
    assert.deepEqual(Object.keys(a.selection), ['provider', 'model', 'effort'])
    assert.deepEqual(JSON.parse(JSON.stringify(a)), a)
    a.selection.model = 'changed'; a.profile = 'release-controlled'
    assert.deepEqual(resolveLeaf(context('checker', { requestedModel: 'haiku' })),
      { selection: { provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, profile: 'build-workspace' })
  })

  test('sonnet, fable and haiku map through autobuild codexModel to gpt-6.1-sol, gpt-6-astra and gpt-6-luna', async () => {
    const { resolveLeaf } = await loadSelection()
    const { codexModel } = await loadConfig()
    for (const [model, codex] of [['sonnet', 'gpt-6.1-sol'], ['fable', 'gpt-6-astra'], ['haiku', 'gpt-6-luna']]) {
      assert.equal(codexModel(model), codex, 'codexModel itself')
      assert.equal(resolveLeaf(context('reviewer', { requestedModel: model })).selection.model, codex)
    }
    // The claude- prefixed forms follow codexModel too.
    for (const model of ['claude-sonnet-5-5', 'claude-haiku-5-5', 'opus']) {
      assert.equal(resolveLeaf(context('reviewer', { requestedModel: model })).selection.model, codexModel(model))
    }
  })

  test('an unmapped claude-* model is refused with no echo; an explicit OpenAI id passes unchanged', async () => {
    const { resolveLeaf } = await loadSelection()
    const { codexModel } = await loadConfig()
    for (const model of ['claude-unknown-9', 'claude-mystery', 'CLAUDE-other']) {
      assert.throws(() => codexModel(model))
      refused(() => resolveLeaf(context('reviewer', { requestedModel: model })), model)
    }
    for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'o9-mini', 'gpt-7']) {
      assert.equal(resolveLeaf(context('reviewer', { requestedModel: model })).selection.model, model)
    }
  })

  test('a model id the Codex launcher would reject is refused before reserve', async () => {
    const { resolveLeaf } = await loadSelection()
    for (const model of ['has space', '-leading', 'semi;colon', 'quote"d', 'new\nline', '.dot']) {
      refused(() => resolveLeaf(context('reviewer', { requestedModel: model })), model)
    }
  })

  test('DOCTOR_EFFORTS is the doctor set; every member passes unchanged and anything else is refused', async () => {
    const { DOCTOR_EFFORTS } = await loadDoctor()
    const { resolveLeaf } = await loadSelection()
    assert.ok(Object.isFrozen(DOCTOR_EFFORTS))
    assert.deepEqual([...DOCTOR_EFFORTS], EFFORTS)
    for (const effort of EFFORTS) {
      assert.equal(resolveLeaf(context('fixer', { requestedEffort: effort })).selection.effort, effort)
    }
    for (const effort of ['HIGH', 'High', 'extreme', 'auto', ' high', 'high ', 'high\n', 'hi', 'mediumhigh', 'xhigh2']) {
      refused(() => resolveLeaf(context('fixer', { requestedEffort: effort })), effort.trim())
    }
  })

  test('audit and release roles and the hunt runner are refused in every workflow', async () => {
    const { resolveLeaf } = await loadSelection()
    const roles = ['audit-analyst', 'audit-researcher', 'audit-synthesizer', 'release-checker', 'merger', 'deploy-watcher', 'runner']
    for (const agentType of roles) {
      for (const workflowId of ['harness-repair', 'dev-build', 'bughunt-flow', 'blueprint-design']) {
        refused(() => resolveLeaf(context(agentType, { workflowId })), agentType)
      }
    }
  })

  test('any leaf of security-audit-flow is refused, including scribe and advisor', async () => {
    const { resolveLeaf } = await loadSelection()
    for (const workflowId of REFUSED_WORKFLOWS) {
      for (const agentType of ['scribe', 'advisor', 'reviewer', 'checker']) {
        refused(() => resolveLeaf(context(agentType, { workflowId })), agentType)
      }
    }
    // A refused workflow anywhere in the path refuses the leaf.
    refused(() => resolveLeaf(context('reviewer', { workflowId: 'harness-repair', workflowPath: ['security-audit-flow', 'harness-repair'] })))
    // Outside those workflows the table decides (the templates never send this pair).
    assert.equal(resolveLeaf(context('scribe')).profile, 'build-workspace')
    // A nested leaf path is accepted.
    assert.equal(resolveLeaf(context('checker', { workflowPath: ['dev-build', 'harness-repair'], requestedModel: 'haiku' })).profile, 'build-workspace')
  })

  test('a malformed context is refused with no echo', async () => {
    const { resolveLeaf } = await loadSelection()
    const good = context('reviewer')
    const getter = { ...good }
    Object.defineProperty(getter, 'agentType', { get: () => 'reviewer', enumerable: true })
    const bad = [
      undefined, null, 0, 'reviewer', [], [good], new Proxy({ ...good }, {}), getter,
      Object.assign(Object.create({ inherited: 1 }), good),
      { ...good, extra: 'x' },
      ...Object.keys(good).map(key => { const c = { ...good }; delete c[key]; return c }),
      ...['workflowId', 'agentType', 'label', 'phase', 'requestedModel', 'requestedEffort'].flatMap(key =>
        ['', '   ', 7, null, ['x']].map(value => ({ ...good, [key]: value }))),
      { ...good, workflowPath: [] }, { ...good, workflowPath: 'harness-repair' }, { ...good, workflowPath: ['dev-build'] },
      { ...good, workflowPath: ['', 'harness-repair'] }, { ...good, workflowPath: [7, 'harness-repair'] },
      { ...good, agentType: 'constructor' }, { ...good, agentType: '__proto__' }, { ...good, agentType: 'toString' },
      { ...good, agentType: 'agentic-ux-reviewer' }, { ...good, agentType: 'no-such-role' }, { ...good, agentType: 'Reviewer' },
    ]
    for (const value of bad) refused(() => resolveLeaf(value), 'no-such-role', 'agentic-ux-reviewer')
    assert.equal(resolveLeaf(good).profile, 'source-review', 'the base context itself is valid')
  })

  test('ROLE_PROFILES cannot be changed by a caller', async () => {
    const { ROLE_PROFILES, resolveLeaf } = await loadSelection()
    assert.throws(() => { 'use strict'; ROLE_PROFILES.runner = 'build-workspace' })
    assert.throws(() => { 'use strict'; ROLE_PROFILES['new-role'] = 'source-review' })
    refused(() => resolveLeaf(context('runner')))
  })
})

// --------------------------------------------------------- through the runtime
// The real runtime and templates; the NR-02 port records every reserve, and the
// provider records every request (the only path to a spawn).
function recordingProvider(answer) {
  const calls = []
  return { calls, port: { async runLeaf(req) { calls.push(req); return completion(req, await answer(req)) } } }
}
async function viaRuntime(t, workflow, args, { answer = devAnswer, resolveLeaf } = {}) {
  const selection = resolveLeaf ?? (await loadSelection()).resolveLeaf
  const provider = recordingProvider(answer)
  const f = await fixture(t, { cap: 1, provider: provider.port, resolveLeaf: selection })
  const run = f.runtime.run(workflow, args, { invocationId: `cp-02c-${workflow}` })
  const bindings = () => [...f.checkpoints.rows.values()].map(row => row.binding)
  return { run, calls: provider.calls, events: f.checkpoints.events, bindings }
}

// bughunt-flow fixture data, in the shapes graphs/hunt/tests/bughunt-flow.test.mjs
// uses, enough to reach the runner: one finding, confirmed, a test written.
function lensTokens() {
  const src = readFileSync(resolve(ROOT, PATHS['bughunt-flow']), 'utf8')
  const block = src.match(/const LENS_TOKENS = \{([^}]*)\}/)[1]
  return Object.fromEntries([...block.matchAll(/(\w+): '([^']+)'/g)].map(m => [m[1], m[2]]))
}
const HUNT_ARGS = () => ({
  repo: '/inert/repo', tree: '/inert/repo/.git/bughunt/pr-7/tree', configDir: '/inert/config', stateDir: '/inert/repo/.git/bughunt/pr-7',
  mode: 'discover', prior: [],
  intake: {
    key: 'pr-7',
    target: { label: 'PR #7: cart', title: 'cart', head: 'c'.repeat(40), mergeBase: 'd'.repeat(40), base: 'origin/main' },
    files: [{ path: 'src/cart.js', status: 'M', added: 3, deleted: 1, isTest: false, isCode: true, hunks: [[10, 14]] }],
    lenses: { routed: ['logic'], reasons: { logic: 'signal' } },
    signals: {}, untrusted: { description: 'inert' },
  },
})
function huntAnswer() {
  const tokens = lensTokens()
  return req => {
    if (req.agentType === 'impact-mapper') {
      return { summary: 'total() changed', changes: [], callers: [], contracts: [], tests: [], protections: [],
        lenses: Object.keys(tokens).map(lens => ({ lens, relevant: lens === 'logic', why: 'why', focus: ['src/cart.js:10'] })) }
    }
    if (req.agentType === 'hunter') {
      const lens = req.label.replace(/^hunt: /, '')
      return { lens_token: tokens[lens], coverage: [{ area: 'total()', status: 'finding', note: '' }], findings: [{
        file_path: 'src/cart.js', line_range: [10, 12], bug_category: 'logic', severity: 'HIGH', confidence: 85,
        title: 'Discount applied twice', description: 'd',
        failure_scenario: { trigger: 'one item', path: 'src/cart.js:10', observable: 'negative total' },
        expected_behavior: 'e', actual_behavior: 'a', evidence: [{ file: 'src/cart.js', line: 11, quote: 'total -= discount' }] }] }
    }
    if (req.agentType === 'skeptic') {
      return { verdict: 'confirmed', refute_confidence: 0, reason: 'confirmed', execution_path: 'src/api.js:4 -> src/cart.js:11',
        introduced_by_change: 'yes', severity: 'HIGH', duplicate_of: '' }
    }
    if (req.agentType === 'reproducer') return { written: true, test_file: 'tests/bughunt-f1.test.js', how_it_fails: 'asserts one discount', reason: '' }
    throw Error('unexpected fixture role')
  }
}

describe('CP-02c through the real runtime (wiring proof, not runtime certification)', () => {
  test('harness-repair: checker is build-workspace on gpt-6-luna; reviewer and qa-auditor are source-review on gpt-6.1-sol', async t => {
    const r = await viaRuntime(t, 'harness-repair', { repo: '/inert/project' }, { answer: req => req.agentType === 'checker' ? pass() : review() })
    const result = await r.run
    assert.equal(result.status, 'done')
    const seen = r.calls.map(c => [c.agentType, c.profile, c.selection.provider, c.selection.model, c.selection.effort])
    assert.deepEqual(seen, [
      ['checker', 'build-workspace', 'codex', 'gpt-6-luna', 'high'],
      ['reviewer', 'source-review', 'codex', 'gpt-6.1-sol', 'high'],
      ['qa-auditor', 'source-review', 'codex', 'gpt-6.1-sol', 'high'],
    ])
    assert.deepEqual(r.bindings().map(b => [b.agentType, b.profile, b.selection.model]), seen.map(s => [s[0], s[1], s[3]]))
  })

  test('dev-build with nested QA: writers are build-workspace, readers source-review', async t => {
    const r = await viaRuntime(t, 'dev-build', { repo: '/inert/project', plan: plan(), planApproved: true })
    const result = await r.run
    assert.equal(result.status, 'done')
    const byRole = Object.fromEntries(r.calls.map(c => [c.agentType, [c.profile, c.selection.model]]))
    assert.deepEqual(byRole, {
      scout: ['source-review', 'gpt-6.1-sol'], implementer: ['build-workspace', 'gpt-6.1-sol'],
      checker: ['build-workspace', 'gpt-6-luna'], 'acceptance-auditor': ['source-review', 'gpt-6.1-sol'],
      reviewer: ['source-review', 'gpt-6.1-sol'], 'qa-auditor': ['source-review', 'gpt-6.1-sol'],
    })
    assert.ok(r.calls.some(c => JSON.stringify(c.workflowPath) === JSON.stringify(['dev-build', 'harness-repair'])))
  })

  // CP-08 amendment: release-flow is no longer refused; its checker leaf runs as release-controlled.
  test('release-flow: the checker leaf is admitted with the release-controlled profile', async t => {
    const answer = () => ({ pr: { number: 1, state: 'OPEN', headRefOid: 'abc1234', headRefName: 'topic', baseRefName: 'main',
      mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', isDraft: false, mergeCommit: '' },
    default_branch: 'main', merge_methods: ['squash'], checks: [{ name: 'ci', bucket: 'pass' }],
    deploy: { source: 'config', merge_method: 'squash', targets: [], missing_credentials: [] } })
    const r = await viaRuntime(t, 'release-flow', { repo: '/inert/project', pr: 1, stage: 'ready' }, { answer })
    assert.equal((await r.run).status, 'ready-to-merge')
    assert.deepEqual(r.calls.map(c => [c.agentType, c.profile]), [['release-checker', 'release-controlled']])
  })

  test('security-audit-flow: INVALID_SELECTION before any reserve or provider call', async t => {
    const r = await viaRuntime(t, 'security-audit-flow', reconArgs())
    await assert.rejects(r.run, runtimeCode('INVALID_SELECTION'))
    assert.deepEqual(r.events, [])
    assert.deepEqual(r.calls, [])
  })

  test('bughunt-flow: the runner leaf gives INVALID_SELECTION before its reserve; nothing runs after it', async t => {
    const r = await viaRuntime(t, 'bughunt-flow', HUNT_ARGS(), { answer: huntAnswer() })
    await assert.rejects(r.run, runtimeCode('INVALID_SELECTION'))
    const roles = r.calls.map(c => c.agentType)
    assert.deepEqual(roles, ['impact-mapper', 'hunter', 'skeptic', 'reproducer'], 'the graph reached the runner step')
    assert.ok(!r.bindings().some(b => b.agentType === 'runner'), 'the runner was reserved')
    assert.deepEqual(r.bindings().map(b => b.agentType), roles, 'a reserve after the refusal')
    assert.equal(r.events.filter(e => e[0] === 'reserve').length, roles.length)
    const reproducer = r.bindings().find(b => b.agentType === 'reproducer')
    assert.equal(reproducer.profile, 'build-workspace')
  })
})

describe('CP-02c leaves the runtime PROFILE_REFUSED backstop intact', () => {
  test('runtime PROFILES are still the four profiles', async () => {
    const { PROFILES } = await loadRuntime()
    assert.deepEqual([...PROFILES].sort(), ['audit-source-only', 'build-workspace', 'release-controlled', 'source-review'])
  })

  const stub = profile => () => ({ selection: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, profile })
  test('a resolver giving build-workspace under security-audit-flow still gets PROFILE_REFUSED, zero reserves and calls', async t => {
    const r = await viaRuntime(t, 'security-audit-flow', reconArgs(), { resolveLeaf: stub('build-workspace') })
    await assert.rejects(r.run, runtimeCode('PROFILE_REFUSED'))
    assert.deepEqual(r.events, [])
    assert.deepEqual(r.calls, [])
  })

  for (const [workflow, args, profile] of [
    ['harness-repair', { repo: '/inert/project' }, 'audit-source-only'],
    ['harness-repair', { repo: '/inert/project' }, 'release-controlled'],
    ['dev-build', { repo: '/inert/project', plan: plan(), planApproved: true }, 'release-controlled'],
  ]) {
    test(`resolveLeaf overridden to ${profile} under ${workflow} still gets PROFILE_REFUSED, zero reserves and calls`, async t => {
      const { resolveLeaf } = await loadSelection()
      const override = ctx => ({ ...resolveLeaf(ctx), profile })
      const r = await viaRuntime(t, workflow, args, { resolveLeaf: override })
      await assert.rejects(r.run, runtimeCode('PROFILE_REFUSED'))
      assert.deepEqual(r.events, [])
      assert.deepEqual(r.calls, [])
    })
  }
})
