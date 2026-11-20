// CP-01a frozen acceptance: catalog schema v2 alongside v1
// (spec/contracts/codex-parity-cp-01a.md). Offline and static: no provider,
// installer or child process. The v2 form is derived from the production v1
// catalog at run time, so the fixture never drifts from the real inventory.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const loadCatalog = () => import(pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/catalog.mjs')))
const loadRuntime = () => import(pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/runtime.mjs')))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const productionV1 = () => JSON.parse(readFileSync(resolve(ROOT, 'acceptance/native-runtime/oc-01-catalog.fixture.json'), 'utf8'))

const CODEX_TRANSPORTS = { autobuild: 'codex-autobuild', bughunt: 'codex-bughunt' }
const TRANSPORTS = [
  { id: 'claude-code', provider: 'claude', entry: 'install.sh' },
  { id: 'codex-autobuild', provider: 'codex', entry: 'graphs/autobuild/tool/lib/codex.mjs' },
  { id: 'codex-bughunt', provider: 'codex', entry: 'graphs/hunt/skills/bughunt/native-runner.mjs' },
]

function limitationsFor(row, implementation) {
  const codes = []
  if (!row.entrySkill) codes.push('LIBRARY_ONLY')
  if (!row.requirementsComplete) codes.push('REQUIREMENTS_INCOMPLETE')
  return codes.concat(implementation)
}

// The v1 -> v2 mapping the contract's accessors must agree with.
function toV2(v1) {
  const offerings = v1.offerings.map(row => {
    const { codexInstallEligible, nativeImplementation, ...shared } = row
    const codexImpl = nativeImplementation === 'present-limited' ? 'partial' : 'unavailable'
    const claudeImpl = row.installTargets.length > 0 ? 'supported' : 'unavailable'
    return {
      ...shared,
      providers: {
        claude: {
          implementation: claudeImpl,
          transportId: claudeImpl === 'unavailable' ? null : 'claude-code',
          limitations: limitationsFor(row, []),
        },
        codex: {
          implementation: codexImpl,
          transportId: codexImpl === 'unavailable' ? null : CODEX_TRANSPORTS[row.id],
          limitations: limitationsFor(row, codexImpl === 'partial'
            ? ['NATIVE_UNVERIFIED', 'LIVE_PROOF_MISSING'] : ['NATIVE_UNVERIFIED']),
        },
      },
      permissionProfile: null,
      proofRefs: [],
    }
  })
  const workflows = v1.workflows.map(row => ({ ...row, sha256: sha(readFileSync(resolve(ROOT, row.source))) }))
  return { ...v1, schemaVersion: 2, offerings, workflows, transports: structuredClone(TRANSPORTS) }
}

// One real offering in an owned temp installation root, as OC-01's fixture does.
function smallInstall(t) {
  const root = mkdtempSync(join(tmpdir(), 'cp-01a-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const installationRoot = join(root, 'install'), skillsRoot = join(root, 'skills')
  const source = join(installationRoot, 'source/autobuild')
  mkdirSync(source, { recursive: true }); mkdirSync(skillsRoot)
  writeFileSync(join(source, 'SKILL.md'), '# inert source\n')
  const v1 = productionV1()
  v1.offerings = [{ ...v1.offerings.find(x => x.id === 'autobuild'), source: 'source/autobuild', entrySha256: sha('# inert source\n') }]
  for (const key of ['workflows', 'assets', 'fixedTargets', 'installerTargets', 'aliases']) v1[key] = []
  return { root, installationRoot, skillsRoot, source, v1, v2: toV2(v1) }
}

test('the production v1 catalog and its v2 form both validate', async () => {
  const api = await loadCatalog()
  const v1 = productionV1(), v2 = toV2(v1)
  assert.equal(v1.schemaVersion, 1)
  assert.deepEqual(api.validateCatalog(v1), [])
  assert.deepEqual(api.validateCatalog(v2), [])
  assert.equal(v2.offerings.length, v1.offerings.length)
  assert.equal(v2.workflows.length, v1.workflows.length)
})

test('v2 rejects each malformed shape with no input echoed', async () => {
  const api = await loadCatalog()
  const mutations = {
    'unknown top-level key': c => { c.extra = true },
    'schemaVersion 3': c => { c.schemaVersion = 3 },
    'v1-only field in a v2 row': c => { c.offerings[0].codexInstallEligible = false },
    'nativeImplementation in a v2 row': c => { c.offerings[0].nativeImplementation = 'not-certified' },
    'missing providers': c => { delete c.offerings[0].providers },
    'extra provider key': c => { c.offerings[0].providers.gemini = c.offerings[0].providers.codex },
    'implementation outside the set': c => { c.offerings[0].providers.codex.implementation = 'ready' },
    'limitation outside the closed set': c => { c.offerings[0].providers.codex.limitations.push('TRUST_ME') },
    'duplicate limitation': c => { c.offerings[0].providers.codex.limitations.push('NATIVE_UNVERIFIED') },
    'transportId not in transports': c => {
      const row = c.offerings.find(x => x.id === 'autobuild'); row.providers.codex.transportId = 'codex-missing'
    },
    'transport of the other provider': c => {
      const row = c.offerings.find(x => x.id === 'autobuild'); row.providers.codex.transportId = 'claude-code'
    },
    'unavailable with a transport': c => {
      const row = c.offerings.find(x => x.id === 'dev'); row.providers.codex.transportId = 'codex-autobuild'
    },
    'available without a transport': c => {
      const row = c.offerings.find(x => x.id === 'autobuild'); row.providers.codex.transportId = null
    },
    'library row without LIBRARY_ONLY': c => {
      const row = c.offerings.find(x => x.id === 'decisions')
      row.providers.codex.limitations = row.providers.codex.limitations.filter(x => x !== 'LIBRARY_ONLY')
    },
    'permissionProfile outside PROFILES': c => { c.offerings[0].permissionProfile = 'admin' },
    'proofRefs with a path': c => { c.offerings[0].proofRefs = ['../evidence'] },
    'duplicate proofRef': c => { c.offerings[0].proofRefs = ['p1', 'p1'] },
    'workflow sha256 not lowercase hex': c => { c.workflows[0].sha256 = c.workflows[0].sha256.toUpperCase() },
    'workflow without sha256': c => { delete c.workflows[0].sha256 },
    'duplicate transport id': c => { c.transports.push({ ...c.transports[0] }) },
    'transport provider outside the set': c => { c.transports[0].provider = 'fallback' },
    'transport entry escaping the root': c => { c.transports[0].entry = '../outside.mjs' },
    'v1 catalog carrying transports': c => { Object.assign(c, productionV1(), { transports: [] }) },
  }
  for (const [name, mutate] of Object.entries(mutations)) {
    const catalog = toV2(productionV1())
    mutate(catalog)
    const problems = api.validateCatalog(catalog)
    assert.ok(problems.length > 0, `accepted: ${name}`)
    assert.ok(problems.every(p => !p.includes('TRUST_ME') && !p.includes('admin')), `echoed input: ${name}`)
  }
})

test('v2 validation runs no getter or proxy hook', async () => {
  const api = await loadCatalog()
  let hooks = 0
  const catalog = toV2(productionV1())
  Object.defineProperty(catalog.offerings[0], 'providers', { enumerable: true, get() { hooks++; return {} } })
  assert.ok(api.validateCatalog(catalog).length > 0)
  const proxied = toV2(productionV1())
  proxied.transports = new Proxy([], { ownKeys() { hooks++; return [] } })
  assert.ok(api.validateCatalog(proxied).length > 0)
  assert.equal(hooks, 0)
})

test('permission profiles come from the runtime, not a copy', async () => {
  const api = await loadCatalog(), runtime = await loadRuntime()
  assert.ok(runtime.PROFILES instanceof Set)
  assert.deepEqual([...runtime.PROFILES].sort(), ['audit-source-only', 'build-workspace', 'release-controlled', 'source-review'])
  for (const profile of runtime.PROFILES) {
    const catalog = toV2(productionV1())
    catalog.offerings[0].permissionProfile = profile
    assert.deepEqual(api.validateCatalog(catalog), [], profile)
  }
})

test('accessors give the same answers for the v1 and v2 forms of every offering', async () => {
  const api = await loadCatalog()
  const v1 = productionV1(), v2 = toV2(v1)
  v1.offerings.forEach((row, i) => {
    const next = v2.offerings[i]
    for (const backend of ['claude', 'codex']) {
      assert.equal(api.providerImplementation(next, backend), api.providerImplementation(row, backend), `${row.id} ${backend}`)
      assert.equal(api.installEligible(next, backend), api.installEligible(row, backend), `${row.id} ${backend}`)
    }
    assert.equal(api.nativeImplementationOf(next), row.nativeImplementation, row.id)
    assert.equal(api.nativeImplementationOf(row), row.nativeImplementation, row.id)
  })
  const eligible = v2.offerings.filter(x => api.installEligible(x, 'codex')).map(x => x.id).sort()
  assert.deepEqual(eligible, ['autobuild', 'bughunt'])
})

test('v2 reads from the providers field, not from a stale v1 field', async () => {
  const api = await loadCatalog()
  const row = toV2(productionV1()).offerings.find(x => x.id === 'dev')
  row.providers.codex = { implementation: 'partial', transportId: 'codex-autobuild', limitations: ['NATIVE_UNVERIFIED'] }
  assert.equal(api.providerImplementation(row, 'codex'), 'partial')
  assert.equal(api.installEligible(row, 'codex'), true)
  assert.equal(api.nativeImplementationOf(row), 'present-limited')
})

test('load, discovery and preflight agree for the same offering in v1 and v2', async t => {
  const api = await loadCatalog()
  const x = smallInstall(t)
  mkdirSync(join(x.installationRoot, 'spec'))
  writeFileSync(join(x.installationRoot, 'spec/offering-capabilities.json'), JSON.stringify(x.v2))
  assert.deepEqual(api.loadOfferingCatalog({ installationRoot: x.installationRoot }), x.v2)
  symlinkSync(x.source, join(x.skillsRoot, 'autobuild'), 'dir')
  const settings = { values: {}, sources: {} }
  for (const backend of ['claude', 'codex']) {
    const args = { installationRoot: x.installationRoot, skillsRoot: x.skillsRoot, backend }
    const fromV1 = api.discoverOfferings({ ...args, catalog: x.v1 })
    const fromV2 = api.discoverOfferings({ ...args, catalog: x.v2 })
    assert.deepEqual(fromV2, fromV1, backend)
    assert.equal(fromV2.offerings[0].nativeReadiness, 'unknown')
    const preflight = catalog => api.projectOfferingPreflight({
      catalog, discovery: api.discoverOfferings({ ...args, catalog }), offeringId: 'autobuild', backend, settings,
    })
    assert.deepEqual(preflight(x.v2), preflight(x.v1), backend)
    assert.notEqual(preflight(x.v2).readiness, 'ready')
  }
})
