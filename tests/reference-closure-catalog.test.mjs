// CP-03b implementation edges the frozen acceptance does not pin: it checks that
// declared dependencies are a superset of the closure and that GUIDANCE_ONLY is
// present. This pins the contract's exact catalog result: the "dependencies after"
// table, the exact sorted limitation lists of the seven reference rows, an acyclic
// dependency graph, and GUIDANCE_ONLY being a limitation, not a refusal (stripping it
// changes no eligibility, implementation or validation answer).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { validateCatalog, installEligible, nativeImplementationOf, providerImplementation } from '../core/skills/native-runtime/catalog.mjs'
import { KEEP_NATIVE_UNVERIFIED, SKILL_IDS, SKILL_TRANSPORT } from './codex-expected-state.mjs'
const catalog = JSON.parse(readFileSync(join(REPO, 'spec/offering-capabilities.json'), 'utf8'))
const byId = new Map(catalog.offerings.map(o => [o.id, o]))
const REFERENCE_ROWS = ['backlog', 'bug-lenses', 'default-stack', 'findings', 'gtm-brief', 'knowledge-map', 'run-records']
const CLAUDE_LIMITS = ['GUIDANCE_ONLY', 'REQUIREMENTS_INCOMPLETE']
// Amended for the codex-skill transport: each reference row is codex partial over codex-skill, with the
// Claude limitation set, plus NATIVE_UNVERIFIED only where the fixture lists the row (run-records).
const SKILLS = { ids: SKILL_IDS, keepNativeUnverified: KEEP_NATIVE_UNVERIFIED, transport: SKILL_TRANSPORT }
const codexLimits = id => [...CLAUDE_LIMITS, ...(SKILLS.keepNativeUnverified.includes(id) ? ['NATIVE_UNVERIFIED'] : [])].sort()
const CODEX_LIMITS = codexLimits('backlog')
const codeUnitSorted = list => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

await test('dev, bughunt and release-pr declare exactly the contract table', () => {
  assert.deepEqual(byId.get('dev').dependencies,
    ['backlog', 'default-stack', 'harness-review', 'knowledge-map', 'native-runtime', 'verify', 'workflow-state']) // native-runtime: CP-06's dev-native.mjs and Codex runner
  // native-runtime: native-cli.mjs imports host-provider.mjs (the host app decides the default provider).
  assert.deepEqual(byId.get('bughunt').dependencies,
    ['backlog', 'bug-lenses', 'default-stack', 'findings', 'knowledge-map', 'native-runtime', 'verify', 'workflow-state'])
  // Amended at CP-08: release-pr's Codex CLI imports the native runtime.
  assert.deepEqual(byId.get('release-pr').dependencies, ['backlog', 'default-stack', 'knowledge-map', 'native-runtime'])
})

await test('every dependency list is sorted, unique, names a known offering and never itself', () => {
  for (const row of catalog.offerings) {
    assert.deepEqual(row.dependencies, codeUnitSorted(new Set(row.dependencies)), `${row.id}: sorted and unique`)
    for (const dependency of row.dependencies) {
      assert.ok(byId.has(dependency), `${row.id} -> ${dependency} is a catalog offering`)
      assert.notEqual(dependency, row.id, `${row.id} does not depend on itself`)
    }
  }
})

await test('the dependency graph is acyclic, and every added target is a leaf', () => {
  for (const target of ['backlog', 'harness-review', 'verify']) assert.deepEqual(byId.get(target).dependencies, [], `${target} is a leaf`)
  const DONE = 2, ACTIVE = 1, state = new Map()
  const visit = (id, path) => {
    if (state.get(id) === DONE) return
    assert.notEqual(state.get(id), ACTIVE, `cycle: ${[...path, id].join(' -> ')}`)
    state.set(id, ACTIVE)
    for (const next of byId.get(id).dependencies) visit(next, [...path, id])
    state.set(id, DONE)
  }
  for (const row of catalog.offerings) visit(row.id, [])
})

await test('the seven reference rows carry exactly the sorted limitation lists and no dependencies', () => {
  assert.deepEqual(catalog.offerings.filter(o => o.kind === 'shared-reference-contract').map(o => o.id), REFERENCE_ROWS)
  for (const id of REFERENCE_ROWS) {
    const row = byId.get(id)
    assert.deepEqual(row.dependencies, [], `${id}: no rule derives an edge from a reference row`)
    assert.deepEqual(row.providers.claude.limitations, CLAUDE_LIMITS, `${id} claude`)
    assert.ok(SKILLS.ids.includes(id), `${id} is a codex-skill offering`)
    assert.deepEqual(row.providers.codex.limitations, codexLimits(id), `${id} codex`)
    assert.equal(row.providers.claude.implementation, 'partial', `${id} claude stays partial`)
    assert.deepEqual([row.providers.codex.implementation, row.providers.codex.transportId], ['partial', SKILLS.transport.id], `${id} codex`)
  }
  assert.deepEqual(codeUnitSorted(CODEX_LIMITS), CODEX_LIMITS, 'GUIDANCE_ONLY sorts first')
})

await test('GUIDANCE_ONLY appears only on reference rows', () => {
  for (const row of catalog.offerings) {
    for (const backend of ['claude', 'codex']) {
      assert.equal(row.providers[backend].limitations.includes('GUIDANCE_ONLY'), REFERENCE_ROWS.includes(row.id), `${row.id} ${backend}`)
    }
  }
})

await test('GUIDANCE_ONLY is a limitation, not a refusal: stripping it changes no answer', () => {
  const strip = row => ({ ...row, providers: Object.fromEntries(Object.entries(row.providers).map(([backend, entry]) =>
    [backend, { ...entry, limitations: entry.limitations.filter(code => code !== 'GUIDANCE_ONLY') }])) })
  for (const id of REFERENCE_ROWS) {
    const row = byId.get(id), bare = strip(row)
    assert.notDeepEqual(bare, row, `${id}: the strip removed something`)
    for (const backend of ['claude', 'codex']) {
      assert.equal(installEligible(row, backend), installEligible(bare, backend), `${id} ${backend} installEligible`)
      assert.equal(providerImplementation(row, backend), providerImplementation(bare, backend), `${id} ${backend} implementation`)
    }
    assert.equal(nativeImplementationOf(row), nativeImplementationOf(bare), `${id} nativeImplementationOf`)
    assert.equal(installEligible(row, 'claude'), true, `${id} stays Claude-installable`)
    assert.equal(installEligible(row, 'codex'), true, `${id} is Codex-installable over codex-skill`)
  }
  assert.deepEqual(validateCatalog(catalog), [], 'the catalog validates with GUIDANCE_ONLY')
  assert.deepEqual(validateCatalog({ ...catalog, offerings: catalog.offerings.map(strip) }), [], 'and without it')
})
