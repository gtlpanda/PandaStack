// CP-01d frozen acceptance: offering inspection and the provider-keyed preflight gate
// (spec/contracts/codex-parity-cp-01d.md). Every `ready` here comes from a fake probe:
// wiring proof, not runtime certification. No HOME, network or real codex/claude.
// Fixture installations are built in owned temp directories from the frozen OC-01
// fixture rows; the provider binary is a recording stub that must never run.
import test from 'node:test'
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { PARTIAL_IDS } from '../../tests/codex-expected-state.mjs'

const ROOT = process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const url = path => pathToFileURL(resolve(ROOT, path)).href
const INSPECT_FILE = resolve(ROOT, 'core/skills/native-runtime/inspect-offering.mjs')
const CLI_FILE = resolve(ROOT, 'core/skills/native-runtime/preflight-cli.mjs')
const loadInspect = async () => {
  const api = await import(url('core/skills/native-runtime/inspect-offering.mjs'))
  assert.equal(typeof api.inspectOffering, 'function', 'inspect-offering.mjs exports inspectOffering')
  return api
}
const loadCli = () => import(url('core/skills/native-runtime/preflight-cli.mjs'))
const sha = value => createHash('sha256').update(value).digest('hex')
const v1Fixture = () => JSON.parse(readFileSync(new URL('../native-runtime/oc-01-catalog.fixture.json', import.meta.url), 'utf8'))
const realConfigText = () => readFileSync(resolve(ROOT, 'agent-config.json'), 'utf8')
const coded = (code, secret = 'PRIVATE') => error => error instanceof Error && error.code === code && !String(error.message).includes(secret)

const CAPS = ['maxBudgetUsd', 'maxTurns', 'totalBudgetUsd', 'bughuntBudgetUsd', 'reviewMaxTurns', 'reviewBudgetUsd']
const CHECK_IDS = ['implementation', 'executable', 'catalog', 'entry', 'transport', 'dependencies', 'configuration', 'controls', 'probe']
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const CONFIG = Object.freeze({ model: 'fixture-model', effort: 'medium', maxConcurrentSubagents: 4 })
const ALL_TRUE = Object.freeze({ model: true, effort: true, concurrency: true })
const CLI_KEYS = ['schemaVersion', 'mode', 'backend', 'offeringId', 'implementation', 'visibility', 'installEligible',
  'readiness', 'configured', 'settings', 'runtimes', 'auth', 'account', 'payer', 'dependencies', 'blockers', 'refusal', 'semantics']

// ---- fixture installations --------------------------------------------------------

const TRANSPORTS = [
  { id: 'claude-code', provider: 'claude', entry: 'transport/install.sh' },
  { id: 'codex-autobuild', provider: 'codex', entry: 'transport/codex-autobuild.mjs' },
  { id: 'codex-bughunt', provider: 'codex', entry: 'transport/codex-bughunt.mjs' },
]
const CODEX_PARTIAL = { autobuild: 'codex-autobuild', bughunt: 'codex-bughunt' }
const skillText = id => `# inert ${id}\n`

// The CP-01b provider table, applied to fixture rows.
function providersFor(row) {
  const library = row.entrySkill ? [] : ['LIBRARY_ONLY']
  const claude = { implementation: 'partial', transportId: 'claude-code', limitations: [...library, 'REQUIREMENTS_INCOMPLETE'] }
  const transport = CODEX_PARTIAL[row.id]
  const codex = transport
    ? { implementation: 'partial', transportId: transport, limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] }
    : { implementation: 'unavailable', transportId: null,
      limitations: [...library, 'NATIVE_UNVERIFIED', 'NO_PROVIDER_TRANSPORT', 'REQUIREMENTS_INCOMPLETE'] }
  return { claude, codex }
}

// One owned temp installation. The root path holds a space on purpose.
// options: ids, version (1|2), dependencies {id: [...]}, skills {id: text}, mutate(catalog, root).
async function install(fn, { ids = ['autobuild', 'bughunt', 'decisions', 'security-audit'], version = 2,
  dependencies = { autobuild: ['bughunt'], bughunt: ['decisions'] }, skills = {}, mutate } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp 01d-'))
  try {
    const installationRoot = join(root, 'install'), skillsRoot = join(root, 'skills'), bin = join(root, 'bin')
    const marker = join(root, 'executable-ran.log')
    for (const dir of [installationRoot, skillsRoot, bin, join(installationRoot, 'spec')]) mkdirSync(dir, { recursive: true })
    const catalog = v1Fixture()
    catalog.offerings = ids.map(id => {
      const row = catalog.offerings.find(candidate => candidate.id === id)
      assert.ok(row, `fixture row ${id}`)
      const text = skills[id] ?? skillText(id)
      mkdirSync(join(installationRoot, 'source', id), { recursive: true })
      if (row.entrySkill) writeFileSync(join(installationRoot, 'source', id, 'SKILL.md'), text)
      const base = { ...row, source: `source/${id}`, entrySha256: row.entrySkill ? sha(text) : null,
        dependencies: (dependencies[id] ?? []).filter(dep => ids.includes(dep)) }
      if (version === 1) return base
      const { codexInstallEligible, nativeImplementation, ...shared } = base
      return { ...shared, providers: providersFor(row), permissionProfile: null, proofRefs: [] }
    })
    for (const key of ['assets', 'workflows', 'installerTargets', 'fixedTargets', 'aliases']) catalog[key] = []
    if (version === 2) {
      catalog.schemaVersion = 2
      catalog.transports = TRANSPORTS.map(row => ({ ...row }))
      for (const row of TRANSPORTS) {
        mkdirSync(dirname(join(installationRoot, row.entry)), { recursive: true })
        writeFileSync(join(installationRoot, row.entry), '// inert transport entry\n')
      }
    }
    mutate?.(catalog, installationRoot)
    writeFileSync(join(installationRoot, 'spec/offering-capabilities.json'), JSON.stringify(catalog))
    writeFileSync(join(installationRoot, 'agent-config.json'), realConfigText())
    const executable = join(bin, 'codex')
    writeFileSync(executable, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`)
    chmodSync(executable, 0o755)
    const source = id => join(installationRoot, 'source', id)
    const link = id => symlinkSync(source(id), join(skillsRoot, id), 'dir')
    return await fn({ root, installationRoot, skillsRoot, bin, executable, marker, source, link, catalog })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

function recordingProbe(report = ALL_TRUE) {
  const calls = []
  const probe = request => { calls.push(request); return typeof report === 'function' ? report(request) : Promise.resolve(report) }
  return { probe, calls }
}
const options = (x, extra = {}) => ({ installationRoot: x.installationRoot, offeringId: 'autobuild', backend: 'codex',
  executable: x.executable, configuration: { ...CONFIG }, ...extra })
const checks = result => Object.fromEntries(result.checks.map(check => [check.id, [check.status, check.code]]))

// The result shape and the status rule, asserted on every inspection.
function shaped(result, x) {
  assert.deepEqual(Object.keys(result).sort(),
    ['backend', 'checks', 'limitations', 'offeringId', 'schemaVersion', 'status', 'unsupportedControls'])
  assert.equal(result.schemaVersion, 1)
  assert.deepEqual(result.checks.map(check => check.id), CHECK_IDS)
  for (const check of result.checks) {
    assert.deepEqual(Object.keys(check).sort(), ['code', 'id', 'status'])
    assert.ok(['pass', 'fail', 'unknown', 'skipped'].includes(check.status), check.id)
    if (['pass', 'skipped'].includes(check.status)) assert.equal(check.code, null, check.id)
    else assert.match(check.code, CODE, check.id)
  }
  const statuses = result.checks.map(check => check.status)
  const expected = statuses.includes('fail') ? 'unsupported' : statuses.every(s => s === 'pass') ? 'ready' : 'unknown'
  assert.equal(result.status, expected)
  assert.ok(Array.isArray(result.unsupportedControls) && Array.isArray(result.limitations))
  if (x) assert.equal(existsSync(x.marker), false, 'the executable never runs')
  return result
}

// Every node:child_process spawn function replaced by a recorder for the duration.
async function withSpawnSpy(fn) {
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
  const saved = Object.fromEntries(names.map(name => [name, cp[name]])), calls = []
  for (const name of names) cp[name] = () => { calls.push(name); throw new Error('spawn blocked by the CP-01d spy') }
  syncBuiltinESMExports()
  try { await fn() } finally {
    for (const name of names) cp[name] = saved[name]
    syncBuiltinESMExports()
  }
  return calls
}

// In-process CLI run with console capture (the existing CLI test pattern).
async function runCli(args, opts = { env: {} }) {
  const { preflightMain } = await loadCli()
  const out = [], err = [], log = console.log, error = console.error
  console.log = value => out.push(value); console.error = value => err.push(value)
  try { return { status: await preflightMain(args, opts), out, err } }
  finally { console.log = log; console.error = error }
}
const cliArgs = (x, backend, offering) =>
  ['--installation-root', x.installationRoot, '--skills-root', x.skillsRoot, '--backend', backend, '--offering', offering]
function cliReport(result) {
  assert.equal(result.out.length, 1); assert.deepEqual(result.err, [])
  const out = JSON.parse(result.out[0])
  assert.deepEqual(Object.keys(out), CLI_KEYS)
  assert.doesNotMatch(result.out[0], /"(?:ready|supported|certified)"/)
  return out
}

// ---- inspectOffering: inputs --------------------------------------------------------

test('invalid options reject with INVALID_INSPECT_INPUT before any probe call, with no echo', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    const { probe, calls } = recordingProbe()
    const good = () => options(x, { probe })
    let getterHits = 0
    const withGetter = good()
    Object.defineProperty(withGetter, 'backend', { enumerable: true, get() { getterHits++; return 'codex' } })
    const cases = [null, 'PRIVATE', [], { ...good(), extra: 'PRIVATE' }, { ...good(), installationRoot: 'PRIVATE/relative' },
      { ...good(), backend: 'PRIVATE-backend' }, { ...good(), executable: 'codex' }, { ...good(), offeringId: 7 },
      { ...good(), configuration: null }, { ...good(), configuration: { ...CONFIG, extra: 1 } },
      { ...good(), configuration: { ...CONFIG, maxTurns: 5 } }, { ...good(), configuration: { model: 'm', effort: 'e' } },
      { ...good(), configuration: { ...CONFIG, maxConcurrentSubagents: 0 } },
      { ...good(), configuration: { ...CONFIG, model: '' } }, { ...good(), configuration: { ...CONFIG, effort: 'PRIVATE\n' } },
      { ...good(), configuration: { ...CONFIG, limits: [] } }, { ...good(), probe: 'PRIVATE' }, { ...good(), probe: null },
      { ...good(), probeTimeoutMs: 0 }, { ...good(), probeTimeoutMs: 1.5 }, { ...good(), probeTimeoutMs: 600001 },
      withGetter, Object.assign(Object.create({ inherited: 1 }), good()), new Proxy(good(), {})]
    for (const input of cases) {
      const pending = inspectOffering(input)
      assert.ok(pending instanceof Promise, 'inspectOffering returns a promise even for bad input')
      await assert.rejects(pending, coded('INVALID_INSPECT_INPUT'))
    }
    assert.equal(getterHits, 0, 'an option getter is never run')
    assert.equal(calls.length, 0)
  })
})

test('catalog load errors pass through and an unknown offering is UNKNOWN_OFFERING with no echo', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    const { probe, calls } = recordingProbe()
    await assert.rejects(inspectOffering(options(x, { probe, offeringId: 'PRIVATE-nope' })), coded('UNKNOWN_OFFERING'))
    await assert.rejects(inspectOffering(options(x, { probe, installationRoot: join(x.root, 'no-such-root') })), coded('NOT_FOUND'))
    writeFileSync(join(x.installationRoot, 'spec/offering-capabilities.json'), 'PRIVATE')
    await assert.rejects(inspectOffering(options(x, { probe })), coded('INVALID_CATALOG'))
    assert.equal(calls.length, 0)
  })
})

// ---- inspectOffering: static unsupported, zero probe calls ---------------------------

test('a codex-unavailable offering is unsupported with zero probe calls', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    const { probe, calls } = recordingProbe()
    const result = shaped(await inspectOffering(options(x, { probe, offeringId: 'security-audit' })), x)
    assert.equal(result.status, 'unsupported')
    assert.deepEqual(checks(result).implementation, ['fail', 'PROVIDER_UNAVAILABLE'])
    assert.deepEqual(checks(result).transport, ['skipped', null])
    assert.deepEqual(checks(result).probe, ['skipped', null])
    assert.deepEqual(result.limitations, providersFor(v1Fixture().offerings.find(r => r.id === 'security-audit')).codex.limitations)
    assert.equal(calls.length, 0)
  })
})

test('a missing or unrunnable binary is unsupported with zero probe calls', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    const { probe, calls } = recordingProbe()
    const plain = join(x.bin, 'not-executable'), broken = join(x.bin, 'broken-link')
    writeFileSync(plain, '#!/bin/sh\nexit 0\n'); chmodSync(plain, 0o644)
    symlinkSync(join(x.bin, 'nowhere'), broken)
    const cases = [[join(x.bin, 'missing'), 'EXECUTABLE_MISSING'], [join(x.executable, 'child'), 'EXECUTABLE_MISSING'],
      [broken, 'EXECUTABLE_MISSING'], [x.bin, 'EXECUTABLE_NOT_RUNNABLE'], [plain, 'EXECUTABLE_NOT_RUNNABLE']]
    for (const [executable, code] of cases) {
      const result = shaped(await inspectOffering(options(x, { probe, executable })), x)
      assert.equal(result.status, 'unsupported', code)
      assert.deepEqual(checks(result).executable, ['fail', code])
      assert.deepEqual(checks(result).probe, ['skipped', null])
    }
    assert.equal(calls.length, 0)
  })
})

test('entry drift is unsupported through checkCatalogDrift, with zero probe calls', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    const { probe, calls } = recordingProbe()
    writeFileSync(join(x.source('autobuild'), 'SKILL.md'), 'one changed byte\n')
    const result = shaped(await inspectOffering(options(x, { probe })), x)
    assert.equal(result.status, 'unsupported')
    assert.deepEqual(checks(result).entry, ['fail', 'ENTRY_DRIFT'])
    assert.deepEqual(checks(result).catalog, ['pass', null])
    assert.deepEqual(checks(result).dependencies, ['pass', null])
    assert.equal(calls.length, 0)
  })
  // An undeclared derived edge of the offering itself is entry drift too (no hash changes).
  await install(async x => {
    const { probe, calls } = recordingProbe()
    const result = shaped(await inspectOffering(options(x, { probe })), x)
    assert.deepEqual(checks(result).entry, ['fail', 'ENTRY_DRIFT'])
    assert.equal(result.status, 'unsupported'); assert.equal(calls.length, 0)
  }, { dependencies: {}, skills: { autobuild: '# inert autobuild\nSee skills/decisions/SKILL.md.\n' } })
})

test('a missing or drifted transitive dependency is unsupported with zero probe calls', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    const { probe, calls } = recordingProbe()
    rmSync(x.source('decisions'), { recursive: true })
    const result = shaped(await inspectOffering(options(x, { probe })), x)
    assert.equal(result.status, 'unsupported')
    assert.deepEqual(checks(result).dependencies, ['fail', 'DEPENDENCY_MISSING'])
    assert.deepEqual(checks(result).entry, ['pass', null])
    assert.deepEqual(checks(result).catalog, ['pass', null])
    assert.equal(calls.length, 0)
  })
  await install(async x => {
    const { probe, calls } = recordingProbe()
    writeFileSync(join(x.source('bughunt'), 'SKILL.md'), 'drifted\n')
    const result = shaped(await inspectOffering(options(x, { probe })), x)
    assert.deepEqual(checks(result).dependencies, ['fail', 'DEPENDENCY_DRIFT'])
    assert.equal(result.status, 'unsupported'); assert.equal(calls.length, 0)
  })
})

test('a missing transport entry and drift elsewhere in the catalog are unsupported', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    const { probe, calls } = recordingProbe()
    rmSync(join(x.installationRoot, 'transport/codex-autobuild.mjs'))
    let result = shaped(await inspectOffering(options(x, { probe })), x)
    assert.deepEqual(checks(result).transport, ['fail', 'TRANSPORT_MISSING'])
    assert.deepEqual(checks(result).catalog, ['pass', null])
    // Under claude the same problem belongs to no check of autobuild, so it is catalog drift.
    result = shaped(await inspectOffering(options(x, { probe, backend: 'claude' })), x)
    assert.deepEqual(checks(result).transport, ['pass', null])
    assert.deepEqual(checks(result).catalog, ['fail', 'CATALOG_DRIFT'])
    assert.equal(result.status, 'unsupported'); assert.equal(calls.length, 0)
  })
  await install(async x => {
    const { probe, calls } = recordingProbe()
    writeFileSync(join(x.source('security-audit'), 'SKILL.md'), 'unrelated drift\n')
    const result = shaped(await inspectOffering(options(x, { probe })), x)
    assert.deepEqual(checks(result).catalog, ['fail', 'CATALOG_DRIFT'])
    assert.deepEqual([checks(result).entry, checks(result).dependencies], [['pass', null], ['pass', null]])
    assert.equal(result.status, 'unsupported'); assert.equal(calls.length, 0)
  })
})

test('a v1 catalog has no pins and is never ready', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    const { probe, calls } = recordingProbe()
    for (const backend of ['codex', 'claude']) {
      const result = shaped(await inspectOffering(options(x, { probe, backend })), x)
      assert.equal(result.status, 'unsupported')
      assert.deepEqual(checks(result).catalog, ['fail', 'CATALOG_NO_PINS'])
      for (const id of ['entry', 'transport', 'dependencies', 'probe']) assert.deepEqual(checks(result)[id], ['skipped', null], id)
      assert.deepEqual(result.limitations, [])
    }
    assert.equal(calls.length, 0)
  }, { version: 1 })
})

test('missing model, effort or concurrency configuration is unsupported with zero probe calls', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    const { probe, calls } = recordingProbe()
    for (const key of ['model', 'effort', 'maxConcurrentSubagents']) {
      const result = shaped(await inspectOffering(options(x, { probe, configuration: { ...CONFIG, [key]: null } })), x)
      assert.deepEqual(checks(result).configuration, ['fail', 'CONFIGURATION_MISSING'], key)
      assert.equal(result.status, 'unsupported')
    }
    assert.equal(calls.length, 0)
  })
})

test('each Claude-only cap under codex is UNSUPPORTED_CONTROL with zero probe calls', async () => {
  const { inspectOffering, CLAUDE_ONLY_CONTROLS } = await loadInspect()
  assert.deepEqual(CLAUDE_ONLY_CONTROLS, CAPS)
  assert.ok(Object.isFrozen(CLAUDE_ONLY_CONTROLS))
  await install(async x => {
    const { probe, calls } = recordingProbe()
    for (const [cap, value] of CAPS.map((cap, i) => [cap, i === 2 ? 0 : 10])) {
      const configuration = { ...CONFIG, limits: { maxIterations: 8, [cap]: value } }
      const result = shaped(await inspectOffering(options(x, { probe, configuration })), x)
      assert.equal(result.status, 'unsupported', cap)
      assert.deepEqual(checks(result).controls, ['fail', 'UNSUPPORTED_CONTROL'], cap)
      assert.deepEqual(checks(result).probe, ['skipped', null], cap)
      assert.deepEqual(result.unsupportedControls, [cap])
    }
    const every = Object.fromEntries([...CAPS].reverse().map(cap => [cap, 1]))
    const result = shaped(await inspectOffering(options(x, { probe, configuration: { ...CONFIG, limits: every } })), x)
    assert.deepEqual(result.unsupportedControls, CAPS, 'in the constant order')
    assert.equal(calls.length, 0, 'no probe call for any cap')
  })
})

test('caps that are null, other limits, and caps under claude do not block ready', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    const nulls = Object.fromEntries(CAPS.map(cap => [cap, null]))
    let probe = recordingProbe()
    let result = shaped(await inspectOffering(options(x, { probe: probe.probe,
      configuration: { ...CONFIG, limits: { ...nulls, maxIterations: 8, noProgressLimit: 3 } } })), x)
    assert.equal(result.status, 'ready'); assert.deepEqual(result.unsupportedControls, []); assert.equal(probe.calls.length, 1)
    probe = recordingProbe()
    const every = Object.fromEntries(CAPS.map(cap => [cap, 5]))
    result = shaped(await inspectOffering(options(x, { probe: probe.probe, backend: 'claude', configuration: { ...CONFIG, limits: every } })), x)
    assert.equal(result.status, 'ready')
    assert.deepEqual(checks(result).controls, ['pass', null]); assert.deepEqual(result.unsupportedControls, [])
    assert.equal(probe.calls.length, 1)
  })
})

test('the six cap names are autobuild limits keys', async () => {
  const { DEFAULTS } = await import(url('graphs/autobuild/tool/lib/config.mjs'))
  for (const cap of CAPS) assert.ok(Object.hasOwn(DEFAULTS.limits, cap), cap)
})

// ---- inspectOffering: unknown ------------------------------------------------------

test('no probe is never ready, and an inspection error is unknown with zero probe calls', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    for (const backend of ['codex', 'claude']) {
      const result = shaped(await inspectOffering(options(x, { backend })), x)
      assert.equal(result.status, 'unknown')
      assert.deepEqual(checks(result).probe, ['unknown', 'PROBE_ABSENT'])
      for (const id of CHECK_IDS.slice(0, 8)) assert.deepEqual(checks(result)[id], ['pass', null], id)
      const undef = shaped(await inspectOffering(options(x, { backend, probe: undefined })), x)
      assert.equal(undef.status, 'unknown')
    }
  })
  // A workflow that names a missing role makes the drift guard throw (a role-file code).
  await install(async x => {
    const { probe, calls } = recordingProbe()
    const result = shaped(await inspectOffering(options(x, { probe })), x)
    assert.equal(result.status, 'unknown')
    assert.deepEqual(checks(result).catalog, ['unknown', 'INSPECTION_ERROR'])
    for (const id of ['entry', 'transport', 'dependencies', 'probe']) assert.deepEqual(checks(result)[id], ['skipped', null], id)
    assert.equal(calls.length, 0)
  }, { mutate(catalog, root) {
    const source = 'graphs/fixture/workflows/flow.js', text = 'export const flow = 1\n'
    mkdirSync(join(root, dirname(source)), { recursive: true }); writeFileSync(join(root, source), text)
    catalog.workflows = [{ source, roles: ['no-such-role'], nativeReadiness: 'unknown', sha256: sha(text) }]
  } })
})

test('a throwing, rejecting or malformed probe gives unknown and never echoes probe text', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    let getterHits = 0
    const getter = { model: true, effort: true }
    Object.defineProperty(getter, 'concurrency', { enumerable: true, get() { getterHits++; return true } })
    class Report { constructor() { this.model = true; this.effort = true; this.concurrency = true } }
    const cases = [
      [() => { throw new Error('PRIVATE sync') }, 'PROBE_ERROR'],
      [() => Promise.reject(Object.assign(new Error('PRIVATE async'), { code: 'PRIVATE_CODE' })), 'PROBE_ERROR'],
      [async () => { throw 'PRIVATE string' }, 'PROBE_ERROR'],
      [() => null, 'PROBE_INVALID'], [() => [], 'PROBE_INVALID'], [() => 'PRIVATE', 'PROBE_INVALID'],
      [() => ({ model: true, effort: true }), 'PROBE_INVALID'],
      [() => ({ ...ALL_TRUE, extra: true }), 'PROBE_INVALID'],
      [() => ({ ...ALL_TRUE, model: 'true' }), 'PROBE_INVALID'],
      [() => ({ ...ALL_TRUE, effort: 1 }), 'PROBE_INVALID'],
      [() => getter, 'PROBE_INVALID'], [() => new Report(), 'PROBE_INVALID'], [() => new Proxy({ ...ALL_TRUE }, {}), 'PROBE_INVALID'],
    ]
    for (const [report, code] of cases) {
      const { probe, calls } = recordingProbe(report)
      const result = shaped(await inspectOffering(options(x, { probe })), x)
      assert.equal(result.status, 'unknown', code)
      assert.deepEqual(checks(result).probe, ['unknown', code])
      assert.equal(calls.length, 1)
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
    }
    assert.equal(getterHits, 0, 'a report getter is never run')
  })
})

// The inspection must settle by itself; this outer bound turns a missing timeout into a
// failure instead of a hung test. It never decides the result.
async function bounded(pending, ms) {
  let timer
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('inspection did not settle')), ms) })
  try { return await Promise.race([pending, guard]) } finally { clearTimeout(timer) }
}

test('a probe that does not settle times out as unknown, aborts its signal and never leaks a rejection', async () => {
  const { inspectOffering: inspectRaw } = await loadInspect()
  const inspectOffering = input => bounded(inspectRaw(input), 5000)
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    await install(async x => {
      let seen
      const hang = recordingProbe(request => { seen = request.signal; return new Promise(() => {}) })
      let started = Date.now()
      let result = shaped(await inspectOffering(options(x, { probe: hang.probe, probeTimeoutMs: 300 })), x)
      let elapsed = Date.now() - started
      assert.deepEqual(checks(result).probe, ['unknown', 'PROBE_TIMEOUT'])
      assert.equal(result.status, 'unknown')
      assert.ok(elapsed >= 250 && elapsed < 2300, `timed out after ${elapsed} ms`)
      assert.equal(seen.aborted, true, 'the probe signal is aborted at the timeout')
      // A probe that rejects after the timeout changes nothing and is not an unhandled rejection.
      const late = recordingProbe(() => new Promise((_, reject) => setTimeout(() => reject(new Error('PRIVATE late')), 600)))
      started = Date.now()
      result = shaped(await inspectOffering(options(x, { probe: late.probe, probeTimeoutMs: 200 })), x)
      elapsed = Date.now() - started
      assert.deepEqual(checks(result).probe, ['unknown', 'PROBE_TIMEOUT'])
      assert.ok(elapsed < 2200, `resolved after ${elapsed} ms without waiting for the probe`)
      await new Promise(done => setTimeout(done, 1000))
      assert.deepEqual(unhandled, [])
    })
  } finally { process.off('unhandledRejection', onUnhandled) }
})

// ---- inspectOffering: ready (wiring proof) -----------------------------------------

test('ready needs a probe that reports model, effort and concurrency supported (wiring proof)', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    for (const backend of ['codex', 'claude']) {
      const { probe, calls } = recordingProbe()
      const result = shaped(await inspectOffering(options(x, { probe, backend })), x)
      assert.equal(result.status, 'ready', backend)
      for (const id of CHECK_IDS) assert.deepEqual(checks(result)[id], ['pass', null], id)
      assert.deepEqual([result.offeringId, result.backend, result.unsupportedControls], ['autobuild', backend, []])
      assert.deepEqual(result.limitations, providersFor(v1Fixture().offerings.find(r => r.id === 'autobuild'))[backend].limitations)
      assert.equal(calls.length, 1)
      const [request] = calls
      assert.ok(Object.isFrozen(request))
      assert.deepEqual(Object.keys(request).sort(),
        ['backend', 'effort', 'executable', 'maxConcurrentSubagents', 'model', 'offeringId', 'signal'])
      assert.deepEqual([request.backend, request.offeringId, request.executable, request.model, request.effort, request.maxConcurrentSubagents],
        [backend, 'autobuild', x.executable, CONFIG.model, CONFIG.effort, CONFIG.maxConcurrentSubagents])
      assert.ok(request.signal instanceof AbortSignal)
    }
    // A symlinked executable is followed for the check and still never run.
    const linked = join(x.bin, 'linked-codex')
    symlinkSync(x.executable, linked)
    const { probe } = recordingProbe()
    assert.equal(shaped(await inspectOffering(options(x, { probe, executable: linked })), x).status, 'ready')
    // A synchronous report works the same as a promise.
    const sync = recordingProbe(() => ({ ...ALL_TRUE }))
    assert.equal(shaped(await inspectOffering(options(x, { probe: sync.probe })), x).status, 'ready')
  })
})

test('a probe that reports model, effort or concurrency unsupported makes the offering unsupported', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    const cases = [[{ model: false, effort: false, concurrency: false }, 'MODEL_UNSUPPORTED'],
      [{ model: true, effort: false, concurrency: false }, 'EFFORT_UNSUPPORTED'],
      [{ model: true, effort: true, concurrency: false }, 'CONCURRENCY_UNSUPPORTED']]
    for (const [report, code] of cases) {
      const { probe, calls } = recordingProbe(() => report)
      const result = shaped(await inspectOffering(options(x, { probe })), x)
      assert.equal(result.status, 'unsupported', code)
      assert.deepEqual(checks(result).probe, ['fail', code])
      assert.equal(calls.length, 1)
    }
  })
})

test('on the candidate root only the codex-partial offerings can be ready (wiring proof)', async () => {
  const { inspectOffering } = await loadInspect()
  await install(async x => {
    const catalog = JSON.parse(readFileSync(resolve(ROOT, 'spec/offering-capabilities.json'), 'utf8'))
    const { probe, calls } = recordingProbe()
    const ready = []
    for (const row of catalog.offerings) {
      const result = shaped(await inspectOffering({ installationRoot: ROOT, offeringId: row.id, backend: 'codex',
        executable: x.executable, configuration: { ...CONFIG }, probe }), x)
      if (result.status === 'ready') ready.push(row.id)
      else assert.deepEqual(checks(result).implementation, ['fail', 'PROVIDER_UNAVAILABLE'], row.id)
    }
    // Amended for the codex-parity waves: the partial rows (and so the ready set) are the expected-state
    // fixture's (tests/fixtures/codex-expected-state.json); each is inspectable as ready (wiring proof).
    const partial = row => row.providers.codex.implementation === 'partial'
    const expected = PARTIAL_IDS
    assert.deepEqual(catalog.offerings.filter(partial).map(o => o.id).sort(), expected, 'no other codex row is partial')
    assert.deepEqual(ready.sort(), expected)
    assert.deepEqual(calls.map(call => call.offeringId).sort(), expected)
  })
})

test('inspect-offering.mjs takes drift from checkCatalogDrift and cannot start a process itself', () => {
  const source = readFileSync(INSPECT_FILE, 'utf8')
  assert.match(source, /\bcheckCatalogDrift\b/)
  assert.match(source, /from\s+['"]\.\/catalog\.mjs['"]/)
  assert.doesNotMatch(source, /createHash|node:crypto|node:child_process|node:worker_threads|node:cluster/)
})

// ---- preflight CLI -----------------------------------------------------------------

test('v1 CLI cases are unchanged', async () => {
  const ids = ['autobuild', 'bughunt', 'decisions', 'security-audit']
  await install(async x => {
    for (const id of ids) x.link(id)
    const expected = [
      ['codex', 'autobuild', 0, []], ['claude', 'autobuild', 0, []],
      ['codex', 'security-audit', 2, ['IMPLEMENTATION_NOT_CERTIFIED', 'NOT_INSTALL_ELIGIBLE']],
      ['claude', 'security-audit', 2, ['IMPLEMENTATION_NOT_CERTIFIED']],
      ['codex', 'decisions', 2, ['IMPLEMENTATION_NOT_CERTIFIED', 'NOT_INSTALL_ELIGIBLE', 'LIBRARY_ONLY']],
      ['claude', 'decisions', 2, ['IMPLEMENTATION_NOT_CERTIFIED', 'LIBRARY_ONLY']],
    ]
    for (const [backend, offering, status, reasons] of expected) {
      const result = await runCli(cliArgs(x, backend, offering)), out = cliReport(result)
      assert.equal(result.status, status, `${backend} ${offering}`)
      assert.deepEqual(out.refusal, { refused: reasons.length > 0, reasons }, `${backend} ${offering}`)
      assert.equal(out.implementation, ['autobuild', 'bughunt'].includes(offering) ? 'present-limited' : 'not-certified')
    }
    rmSync(join(x.skillsRoot, 'autobuild'))
    let result = await runCli(cliArgs(x, 'codex', 'autobuild')), out = cliReport(result)
    assert.equal(result.status, 2); assert.deepEqual(out.refusal.reasons, ['READINESS_DEGRADED'])
    x.link('autobuild'); rmSync(x.source('decisions'), { recursive: true })
    result = await runCli(cliArgs(x, 'codex', 'autobuild')); out = cliReport(result)
    assert.equal(result.status, 2); assert.deepEqual(out.refusal.reasons, ['DEPENDENCY_SOURCE_NOT_PRESENT'])
  }, { version: 1, ids })
  const source = readFileSync(CLI_FILE, 'utf8')
  assert.doesNotMatch(source, /node:(?:fs|child_process|net|http|https|dns|tls|dgram)|\bfetch\(|process\.env\.[A-Za-z]/)
  assert.doesNotMatch(source, /inspect-offering/)
})

test('v1 CLI usage errors are unchanged and load nothing', async () => {
  let loads = 0
  const opts = { env: {}, load: async () => { loads++; throw new Error('must not load') } }
  const base = ['--installation-root', '/abs/install', '--skills-root', '/abs/skills', '--backend', 'codex', '--offering', 'autobuild']
  const swap = (index, value) => base.map((item, i) => i === index ? value : item)
  for (const args of [[], base.slice(0, 6), [...base, 'extra'], [...base, '--probe', 'x'], swap(5, 'fallback'), swap(0, '--bogus')]) {
    const result = await runCli(args, opts)
    assert.equal(result.status, 1); assert.deepEqual(result.out, [])
    assert.equal(JSON.parse(result.err[0]).error, 'INVALID_USAGE')
  }
  assert.equal(loads, 0)
})

test('with a v2 catalog the implementation refusal is keyed on the backend provider row', async () => {
  const ids = ['autobuild', 'bughunt', 'decisions', 'security-audit']
  await install(async x => {
    for (const id of ids) x.link(id)
    const expected = [
      ['codex', 'autobuild', 0, []], ['claude', 'autobuild', 0, []],
      ['codex', 'security-audit', 2, ['IMPLEMENTATION_NOT_CERTIFIED', 'NOT_INSTALL_ELIGIBLE']],
      ['claude', 'security-audit', 0, []],
      ['codex', 'decisions', 2, ['IMPLEMENTATION_NOT_CERTIFIED', 'NOT_INSTALL_ELIGIBLE', 'LIBRARY_ONLY']],
      ['claude', 'decisions', 2, ['LIBRARY_ONLY']],
      ['claude', 'bughunt', 2, ['IMPLEMENTATION_NOT_CERTIFIED']], ['codex', 'bughunt', 0, []],
    ]
    for (const [backend, offering, status, reasons] of expected) {
      const result = await runCli(cliArgs(x, backend, offering)), out = cliReport(result)
      assert.equal(result.status, status, `${backend} ${offering}`)
      assert.deepEqual(out.refusal, { refused: reasons.length > 0, reasons }, `${backend} ${offering}`)
      assert.equal(out.readiness, 'unknown')
    }
  }, { ids, dependencies: {}, mutate(catalog) {
    // bughunt with an unavailable claude row: only the claude backend is refused for it.
    const row = catalog.offerings.find(r => r.id === 'bughunt')
    row.providers.claude = { implementation: 'unavailable', transportId: null, limitations: ['NO_PROVIDER_TRANSPORT', 'REQUIREMENTS_INCOMPLETE'] }
  } })
})

// ---- offline mode starts no process ------------------------------------------------

test('offline inspection and in-process CLI runs call no child_process spawn function', async () => {
  const { inspectOffering } = await loadInspect()
  await loadCli()
  for (const version of [1, 2]) {
    await install(async x => {
      x.link('autobuild')
      const calls = await withSpawnSpy(async () => {
        for (const backend of ['codex', 'claude']) {
          shaped(await inspectOffering(options(x, { backend })), x)
          shaped(await inspectOffering(options(x, { backend, offeringId: 'security-audit' })), x)
          const result = await runCli(cliArgs(x, backend, 'autobuild'))
          assert.equal(result.status, 0); cliReport(result)
        }
      })
      assert.deepEqual(calls, [], `v${version}`)
    }, { version })
  }
})

test('a real CLI child with only recording stubs on PATH runs none of them', async () => {
  for (const version of [1, 2]) {
    await install(async x => {
      x.link('autobuild')
      const stubs = join(x.root, 'path stubs'), log = join(x.root, 'stub-calls.log')
      mkdirSync(stubs)
      for (const name of ['codex', 'claude', 'git']) {
        writeFileSync(join(stubs, name), `#!/bin/sh\necho ${name} >> '${log}'\nexit 0\n`)
        chmodSync(join(stubs, name), 0o755)
      }
      for (const backend of ['codex', 'claude']) {
        const child = cp.spawnSync(process.execPath, [CLI_FILE, ...cliArgs(x, backend, 'autobuild')],
          { env: { PATH: stubs }, encoding: 'utf8', timeout: 30000 })
        assert.equal(child.status, 0, child.stderr)
        assert.equal(child.stderr, '')
        const out = JSON.parse(child.stdout)
        assert.deepEqual(Object.keys(out), CLI_KEYS)
        assert.equal(out.mode, 'offline-static-preflight')
      }
      assert.equal(existsSync(log), false, 'no stub on PATH was started')
    }, { version })
  }
})
