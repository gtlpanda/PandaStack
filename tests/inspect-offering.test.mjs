// CP-01d implementation tests (spec/contracts/codex-parity-cp-01d.md) for behavior the
// frozen acceptance leaves open: the probe gate's edges, the drift partition, input
// bounds, and the preflight CLI's provider-row lookup. Every `ready` comes from a fake
// probe: wiring proof, not runtime certification. No provider, HOME or network.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { inspectOffering } from '../core/skills/native-runtime/inspect-offering.mjs'
import { preflightMain } from '../core/skills/native-runtime/preflight-cli.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const fixtureRows = () => JSON.parse(readFileSync(join(REPO, 'acceptance/native-runtime/oc-01-catalog.fixture.json'), 'utf8'))
const CONFIG = Object.freeze({ model: 'fixture-model', effort: 'medium', maxConcurrentSubagents: 2 })
const ALL_TRUE = Object.freeze({ model: true, effort: true, concurrency: true })
const IDS = ['autobuild', 'bughunt', 'decisions', 'security-audit']
const TRANSPORTS = [{ id: 'claude-code', provider: 'claude', entry: 'transport/install.sh' },
  { id: 'codex-autobuild', provider: 'codex', entry: 'transport/codex-autobuild.mjs' },
  { id: 'codex-bughunt', provider: 'codex', entry: 'transport/codex-bughunt.mjs' }]
const CODEX_TRANSPORT = { autobuild: 'codex-autobuild', bughunt: 'codex-bughunt' }

function providers(row) {
  const library = row.entrySkill ? [] : ['LIBRARY_ONLY']
  const transport = CODEX_TRANSPORT[row.id]
  return {
    claude: { implementation: 'partial', transportId: 'claude-code', limitations: [...library, 'REQUIREMENTS_INCOMPLETE'] },
    codex: transport
      ? { implementation: 'partial', transportId: transport, limitations: ['NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] }
      : { implementation: 'unavailable', transportId: null, limitations: [...library, 'NO_PROVIDER_TRANSPORT'] },
  }
}

// A v2 (or v1) installation in an owned temp directory. The executable is a stub that
// records a run; no case may start it.
async function install(fn, { version = 2, skills = {}, dependencies = { autobuild: ['bughunt'], bughunt: ['decisions'] }, mutate } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'inspect offering-'))
  try {
    const installationRoot = join(root, 'install'), skillsRoot = join(root, 'skills'), bin = join(root, 'bin')
    const marker = join(root, 'ran.log')
    for (const dir of [join(installationRoot, 'spec'), skillsRoot, bin]) mkdirSync(dir, { recursive: true })
    const catalog = fixtureRows()
    catalog.offerings = IDS.map(id => {
      const row = catalog.offerings.find(candidate => candidate.id === id), text = skills[id] ?? `# inert ${id}\n`
      mkdirSync(join(installationRoot, 'source', id), { recursive: true })
      if (row.entrySkill) writeFileSync(join(installationRoot, 'source', id, 'SKILL.md'), text)
      const base = { ...row, source: `source/${id}`, entrySha256: row.entrySkill ? sha(text) : null, dependencies: dependencies[id] ?? [] }
      if (version === 1) return base
      const { codexInstallEligible, nativeImplementation, ...shared } = base
      return { ...shared, providers: providers(row), permissionProfile: null, proofRefs: [] }
    })
    for (const key of ['assets', 'workflows', 'installerTargets', 'fixedTargets', 'aliases']) catalog[key] = []
    if (version === 2) {
      catalog.schemaVersion = 2
      catalog.transports = TRANSPORTS.map(row => ({ ...row }))
      for (const row of TRANSPORTS) {
        mkdirSync(dirname(join(installationRoot, row.entry)), { recursive: true })
        writeFileSync(join(installationRoot, row.entry), '// inert\n')
      }
    }
    mutate?.(catalog, installationRoot)
    writeFileSync(join(installationRoot, 'spec/offering-capabilities.json'), JSON.stringify(catalog))
    writeFileSync(join(installationRoot, 'agent-config.json'), readFileSync(join(REPO, 'agent-config.json')))
    const executable = join(bin, 'codex')
    writeFileSync(executable, `#!/bin/sh\necho ran >> '${marker}'\n`); chmodSync(executable, 0o755)
    const source = id => join(installationRoot, 'source', id)
    await fn({ root, installationRoot, skillsRoot, bin, executable, source })
    assert.equal(existsSync(marker), false, 'the executable never runs')
  } finally { rmSync(root, { recursive: true, force: true }) }
}

const options = (x, extra = {}) => ({ installationRoot: x.installationRoot, offeringId: 'autobuild', backend: 'codex',
  executable: x.executable, configuration: { ...CONFIG }, ...extra })
const checks = result => Object.fromEntries(result.checks.map(entry => [entry.id, [entry.status, entry.code]]))
function recording(report = () => ALL_TRUE) {
  const calls = []
  return { calls, probe: request => { calls.push(request); return report(request) } }
}
const rejectsInput = pending => assert.rejects(pending, error => error.code === 'INVALID_INSPECT_INPUT')

await test('a report is read as data: a then getter or a foreign thenable is invalid and never run', async () => {
  await install(async x => {
    let hits = 0
    const withThen = { ...ALL_TRUE }
    Object.defineProperty(withThen, 'then', { enumerable: true, get() { hits++; return undefined } })
    const thenable = { then(resolve) { hits++; resolve(ALL_TRUE) } }
    for (const report of [withThen, thenable]) {
      const { probe, calls } = recording(() => report)
      const result = await inspectOffering(options(x, { probe }))
      assert.deepEqual(checks(result).probe, ['unknown', 'PROBE_INVALID'])
      assert.equal(result.status, 'unknown'); assert.equal(calls.length, 1)
    }
    assert.equal(hits, 0)
  })
})

await test('the probe gets a live signal that a settled probe never sees aborted, at both timeout bounds', async () => {
  await install(async x => {
    const { probe, calls } = recording(request => { assert.equal(request.signal.aborted, false); return Promise.resolve(ALL_TRUE) })
    const ready = await inspectOffering(options(x, { probe, probeTimeoutMs: 600000 }))
    assert.equal(ready.status, 'ready'); assert.equal(calls[0].signal.aborted, false)
    // The lower bound 1 is accepted: a synchronous report needs no wait, a slower probe times out.
    assert.equal((await inspectOffering(options(x, { probe: recording(() => ALL_TRUE).probe, probeTimeoutMs: 1 }))).status, 'ready')
    const slow = recording(() => new Promise(done => setTimeout(() => done(ALL_TRUE), 100)))
    const result = await inspectOffering(options(x, { probe: slow.probe, probeTimeoutMs: 1 }))
    assert.deepEqual(checks(result).probe, ['unknown', 'PROBE_TIMEOUT']); assert.equal(slow.calls[0].signal.aborted, true)
  })
})

await test('optional keys given as undefined take their defaults; other shapes are input errors', async () => {
  await install(async x => {
    const ready = await inspectOffering(options(x, { probe: recording().probe, probeTimeoutMs: undefined,
      configuration: { ...CONFIG, limits: undefined } }))
    assert.equal(ready.status, 'ready')
    const bare = Object.assign(Object.create(null), options(x, { probe: recording().probe }))
    bare.configuration = Object.assign(Object.create(null), CONFIG, { limits: Object.assign(Object.create(null), { maxIterations: 3 }) })
    assert.equal((await inspectOffering(bare)).status, 'ready', 'null-prototype objects are plain')
    let hits = 0
    const getter = { ...CONFIG }
    Object.defineProperty(getter, 'model', { enumerable: true, get() { hits++; return 'm' } })
    const limitsGetter = {}
    Object.defineProperty(limitsGetter, 'maxTurns', { enumerable: true, get() { hits++; return 1 } })
    for (const bad of [{ probeTimeoutMs: null }, { probeTimeoutMs: '300' }, { configuration: { ...CONFIG, limits: null } },
      { configuration: getter }, { configuration: { ...CONFIG, limits: limitsGetter } },
      { configuration: { ...CONFIG, [Symbol('k')]: 1 } }, { configuration: { ...CONFIG, model: 'x'.repeat(257) } },
      { configuration: { ...CONFIG, maxConcurrentSubagents: 2 ** 53 } }, { configuration: { ...CONFIG, maxConcurrentSubagents: '2' } },
      { offeringId: undefined }, { backend: 'Codex' }]) {
      await rejectsInput(inspectOffering(options(x, bad)))
    }
    assert.equal(hits, 0)
    assert.equal((await inspectOffering(options(x, { probe: recording().probe, configuration: { ...CONFIG, model: 'x'.repeat(256) } }))).status, 'ready')
  })
})

await test('path bounds: 4097 bytes or a control character is an input error, 4096 bytes is inspected', async () => {
  await install(async x => {
    await rejectsInput(inspectOffering(options(x, { executable: '/' + 'a'.repeat(4094) + 'é' })))
    for (const bad of ['\t', '\x7f', '\u0085', '\u009f']) await rejectsInput(inspectOffering(options(x, { executable: `${x.executable}${bad}` })))
    // One 4095-byte component is too long to stat: an inspection error, not a missing binary,
    // and an unknown static check still keeps the probe from running.
    const { probe, calls } = recording()
    const result = await inspectOffering(options(x, { probe, executable: '/' + 'a'.repeat(4095) }))
    assert.deepEqual(checks(result).executable, ['unknown', 'INSPECTION_ERROR'])
    assert.deepEqual(checks(result).probe, ['skipped', null]); assert.equal(result.status, 'unknown'); assert.equal(calls.length, 0)
  })
})

await test('static failures do not short-circuit, and without a probe a failed inspection skips check 9', async () => {
  await install(async x => {
    const result = await inspectOffering(options(x, { offeringId: 'security-audit', executable: join(x.bin, 'missing'),
      configuration: { ...CONFIG, model: null, limits: { maxTurns: 0, reviewBudgetUsd: undefined } } }))
    assert.deepEqual(checks(result), { implementation: ['fail', 'PROVIDER_UNAVAILABLE'], executable: ['fail', 'EXECUTABLE_MISSING'],
      catalog: ['pass', null], entry: ['pass', null], transport: ['skipped', null], dependencies: ['pass', null],
      configuration: ['fail', 'CONFIGURATION_MISSING'], controls: ['fail', 'UNSUPPORTED_CONTROL'], probe: ['skipped', null] })
    // A cap is set when its own value is not null, so an explicit undefined counts.
    assert.deepEqual(result.unsupportedControls, ['maxTurns', 'reviewBudgetUsd'])
    assert.equal(result.status, 'unsupported')
  })
})

await test('a dependency with an undeclared edge is DEPENDENCY_DRIFT, and a missing one outranks drift', async () => {
  await install(async x => {
    let result = await inspectOffering(options(x, { probe: recording().probe }))
    assert.deepEqual([checks(result).entry, checks(result).dependencies, checks(result).catalog],
      [['pass', null], ['fail', 'DEPENDENCY_DRIFT'], ['pass', null]])
    rmSync(x.source('decisions'), { recursive: true })
    result = await inspectOffering(options(x, { probe: recording().probe }))
    assert.deepEqual(checks(result).dependencies, ['fail', 'DEPENDENCY_MISSING'])
    // The same problems seen from security-audit belong to no check of its own.
    result = await inspectOffering(options(x, { offeringId: 'security-audit', backend: 'claude', probe: recording().probe }))
    assert.deepEqual([checks(result).dependencies, checks(result).catalog], [['pass', null], ['fail', 'CATALOG_DRIFT']])
  }, { skills: { bughunt: '# inert bughunt\nSee skills/security-audit/SKILL.md.\n' } })
})

await test('a workflow hash mismatch is catalog drift only, and limitations are a fresh copy', async () => {
  await install(async x => {
    const { probe, calls } = recording()
    const first = await inspectOffering(options(x, { probe }))
    assert.deepEqual(checks(first).catalog, ['fail', 'CATALOG_DRIFT'])
    for (const id of ['entry', 'transport', 'dependencies']) assert.deepEqual(checks(first)[id], ['pass', null], id)
    assert.equal(calls.length, 0)
    first.limitations.push('MUTATED')
    assert.deepEqual((await inspectOffering(options(x, { probe }))).limitations, ['NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'])
  }, { mutate(catalog, root) {
    mkdirSync(join(root, 'flows')); writeFileSync(join(root, 'flows/flow.js'), 'export const flow = 2\n')
    catalog.workflows = [{ source: 'flows/flow.js', roles: [], nativeReadiness: 'unknown', sha256: sha('export const flow = 1\n') }]
  } })
})

// ---- preflight CLI loader ---------------------------------------------------------

async function realDependencies() {
  const [catalog, doctor, agentConfig] = await Promise.all([import('../core/skills/native-runtime/catalog.mjs'),
    import('../core/skills/run-records/doctor.mjs'), import('../scripts/agent-config.mjs')])
  return { loadOfferingCatalog: catalog.loadOfferingCatalog, discoverOfferings: catalog.discoverOfferings,
    projectOfferingPreflight: catalog.projectOfferingPreflight, providerImplementation: catalog.providerImplementation,
    resolveSettings: doctor.resolveSettings, readAgentConfig: agentConfig.readAgentConfig }
}
async function runCli(x, backend, offering, load) {
  const out = [], err = [], log = console.log, error = console.error
  console.log = value => out.push(value); console.error = value => err.push(value)
  const args = ['--installation-root', x.installationRoot, '--skills-root', x.skillsRoot, '--backend', backend, '--offering', offering]
  try { return { status: await preflightMain(args, { env: {}, load }), out, err } }
  finally { console.log = log; console.error = error }
}

await test('the CLI needs providerImplementation, reads it only for v2, and maps its failure to PREFLIGHT_FAILED', async () => {
  const { providerImplementation, ...rest } = await realDependencies()
  await install(async x => {
    const missing = await runCli(x, 'codex', 'security-audit', async () => rest)
    assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.err[0]).error, 'DEPENDENCY_UNAVAILABLE')
    const throwing = await runCli(x, 'claude', 'security-audit', async () => ({ ...rest,
      providerImplementation() { throw new Error('PRIVATE accessor detail') } }))
    assert.equal(throwing.status, 1); assert.deepEqual(throwing.out, [])
    assert.equal(JSON.parse(throwing.err[0]).error, 'PREFLIGHT_FAILED'); assert.doesNotMatch(throwing.err[0], /PRIVATE/)
    const seen = []
    const spied = await runCli(x, 'claude', 'security-audit', async () => ({ ...rest,
      providerImplementation(row, backend) { seen.push([row.id, backend]); return providerImplementation(row, backend) } }))
    assert.equal(spied.status, 2, 'unlinked, so readiness is degraded')
    assert.deepEqual(JSON.parse(spied.out[0]).refusal.reasons, ['READINESS_DEGRADED'])
    assert.deepEqual(seen, [['security-audit', 'claude']])
  }, { dependencies: {} })
  await install(async x => {
    const seen = []
    const result = await runCli(x, 'claude', 'security-audit', async () => ({ ...rest,
      providerImplementation(row, backend) { seen.push(row.id); return providerImplementation(row, backend) } }))
    assert.deepEqual(JSON.parse(result.out[0]).refusal.reasons, ['IMPLEMENTATION_NOT_CERTIFIED', 'READINESS_DEGRADED'])
    assert.deepEqual(seen, [], 'a v1 catalog keeps the projection rule')
  }, { version: 1, dependencies: {} })
})
