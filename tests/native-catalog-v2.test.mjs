// CP-01a implementation edges the frozen acceptance does not pin: list caps at
// their bounds, the claude side of the provider rules, version mixing, and the
// public accessors failing closed on input that never went through catalogData.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test, REPO } from '../scripts/workflow-harness.mjs'

const api = () => import('../core/skills/native-runtime/catalog.mjs')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const productionV1 = () => JSON.parse(readFileSync(join(REPO, 'acceptance/native-runtime/oc-01-catalog.fixture.json'), 'utf8'))
const coded = e => e.code === 'INVALID_CATALOG_INPUT'

// Minimal v1 -> v2 mapping; transport ids for the two codex-eligible offerings.
function toV2(v1) {
  const offerings = v1.offerings.map(({ codexInstallEligible, nativeImplementation, ...row }) => {
    const library = row.entrySkill ? [] : ['LIBRARY_ONLY']
    const claude = row.installTargets.length ? 'supported' : 'unavailable'
    const codex = nativeImplementation === 'present-limited' ? 'partial' : 'unavailable'
    return { ...row, permissionProfile: null, proofRefs: [], providers: {
      claude: { implementation: claude, transportId: claude === 'unavailable' ? null : 'claude-code', limitations: library },
      codex: { implementation: codex, transportId: codex === 'unavailable' ? null : `codex-${row.id}`,
        limitations: [...library, 'NATIVE_UNVERIFIED'] },
    } }
  })
  const workflows = v1.workflows.map(row => ({ ...row, sha256: sha(readFileSync(join(REPO, row.source))) }))
  const transports = [{ id: 'claude-code', provider: 'claude', entry: 'install.sh' },
    { id: 'codex-autobuild', provider: 'codex', entry: 'graphs/autobuild/tool/lib/codex.mjs' },
    { id: 'codex-bughunt', provider: 'codex', entry: 'graphs/hunt/skills/bughunt/native-runner.mjs' }]
  return { ...v1, schemaVersion: 2, offerings, workflows, transports }
}
const valid = (a, mutate) => { const c = toV2(productionV1()); mutate(c); return a.validateCatalog(c).length === 0 }
const pad = (n, make) => Array.from({ length: n }, (_, i) => make(i))

await test('v2 list caps accept their bound and reject one past it', async () => {
  const a = await api()
  const extraTransports = n => c => {
    c.transports.push(...pad(n - c.transports.length, i => ({ id: `spare-${i}`, provider: 'codex', entry: 'x.mjs' })))
  }
  assert.equal(valid(a, extraTransports(32)), true)
  assert.equal(valid(a, extraTransports(33)), false)
  assert.equal(valid(a, c => { c.offerings[0].proofRefs = pad(64, i => `p${i}`) }), true)
  assert.equal(valid(a, c => { c.offerings[0].proofRefs = pad(65, i => `p${i}`) }), false)
  const tenLimitations = ['NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE', 'LIBRARY_ONLY', 'GUIDANCE_ONLY', 'NO_NATIVE_ENTRY',
    'NO_PROVIDER_TRANSPORT', 'PROFILE_UNSUPPORTED', 'UNSUPPORTED_CONTROL', 'LIVE_PROOF_MISSING', 'EXTERNAL_SERVICE']
  assert.equal(valid(a, c => { c.offerings[0].providers.codex.limitations = tenLimitations }), true)
})

await test('v2 rejects the claude side of the provider rules and malformed scalars', async () => {
  const a = await api()
  const row = (c, id) => c.offerings.find(x => x.id === id)
  const rejected = {
    'library row missing LIBRARY_ONLY under claude only': c => {
      const r = row(c, 'decisions'); r.providers.claude.limitations = []
    },
    'claude bound to a codex transport': c => { row(c, 'autobuild').providers.claude.transportId = 'codex-autobuild' },
    'claude unavailable with a transport': c => { row(c, 'decisions').providers.claude.implementation = 'unavailable' },
    'permissionProfile as a number': c => { c.offerings[0].permissionProfile = 1 },
    'permissionProfile as an inherited name': c => { c.offerings[0].permissionProfile = 'constructor' },
    'proofRef not an identifier': c => { c.offerings[0].proofRefs = ['P1'] },
    'providers as an array': c => { c.offerings[0].providers = [] },
    'provider entry missing limitations': c => { delete c.offerings[0].providers.claude.limitations },
    'transport entry absolute': c => { c.transports[0].entry = '/etc/passwd' },
    'transport id not an identifier': c => { c.transports[0].id = 'Claude Code' },
    'schemaVersion as a string': c => { c.schemaVersion = '2' },
    'v2 without transports': c => { delete c.transports },
    'v1 catalog with a v2 row': c => { const v1 = productionV1(); v1.offerings[0] = c.offerings[0]; Object.assign(c, v1); delete c.transports },
    'v2 catalog with a v1 row': c => { c.offerings[0] = productionV1().offerings[0] },
  }
  for (const [name, mutate] of Object.entries(rejected)) assert.equal(valid(a, mutate), false, name)
  assert.equal(valid(a, c => { row(c, 'autobuild').providers.codex.implementation = 'supported' }), true)
})

await test('accessors derive v2 answers from providers alone', async () => {
  const a = await api()
  const c = toV2(productionV1())
  const dev = c.offerings.find(x => x.id === 'dev')
  dev.installTargets = []
  dev.providers = { claude: { implementation: 'unavailable', transportId: null, limitations: [] },
    codex: { implementation: 'supported', transportId: 'codex-autobuild', limitations: [] } }
  assert.equal(a.providerImplementation(dev, 'codex'), 'supported')
  assert.equal(a.nativeImplementationOf(dev), 'present-limited')
  // Implemented but with nothing to install: never install-eligible on either backend.
  assert.equal(a.installEligible(dev, 'codex'), false)
  assert.equal(a.installEligible(dev, 'claude'), false)
  assert.equal(a.providerImplementation(dev, 'claude'), 'unavailable')
})

await test('accessors fail closed with the fixed code and run no hook', async () => {
  const a = await api()
  const row = toV2(productionV1()).offerings[0]
  let hooks = 0
  const getter = { ...row }
  Object.defineProperty(getter, 'providers', { enumerable: true, get() { hooks++; return row.providers } })
  const inconsistent = structuredClone(row)
  inconsistent.providers.codex.transportId = 'codex-autobuild'
  const inputs = [null, undefined, 0, 'autobuild', [], {}, getter, new Proxy(row, { get() { hooks++ } }), inconsistent]
  for (const accessor of ['providerImplementation', 'installEligible']) {
    for (const value of inputs) assert.throws(() => a[accessor](value, 'codex'), coded, `${accessor} ${typeof value}`)
    for (const backend of ['gemini', '__proto__', 'Codex', null, 1]) {
      assert.throws(() => a[accessor](row, backend), coded, `${accessor} ${String(backend)}`)
    }
  }
  for (const value of inputs) assert.throws(() => a.nativeImplementationOf(value), coded)
  assert.equal(hooks, 0)
})
