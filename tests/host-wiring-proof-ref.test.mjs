// CP-02f implementation edges the frozen acceptance does not pin: it checks that
// dev's proofRefs include cp-02f-host-wiring and that no other row carries it. This
// pins the contract's exact catalog result: dev's list is exactly the expected-state
// fixture's, every other row carries only its own fixture-listed references, dev's codex
// row is partial (CP-06), the id names the contract and its frozen test, and a reference
// is never evidence (removing it, or adding it to every row, changes no eligibility,
// implementation, validation or install-plan answer).
// Amended for the codex-parity waves: which rows are partial and which references each
// carries come from tests/fixtures/codex-expected-state.json (tests/codex-expected-state.mjs).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { validateCatalog, installEligible, nativeImplementationOf, providerImplementation } from '../core/skills/native-runtime/catalog.mjs'
import { identifier } from '../core/skills/native-runtime/catalog-data.mjs'
import { installPlan } from '../core/skills/native-runtime/install-plan.mjs'
import { PARTIAL_IDS, STATE, expectedCodexRow, expectedPlan, expectedProofRefs } from './codex-expected-state.mjs'

const PROOF_REF = 'cp-02f-host-wiring'
const catalog = JSON.parse(readFileSync(join(REPO, 'spec/offering-capabilities.json'), 'utf8'))
const byId = new Map(catalog.offerings.map(o => [o.id, o]))
const withRefs = (row, proofRefs) => ({ ...row, proofRefs })

await test('dev carries exactly the fixture\'s references (the wiring proof first); every other row carries its own fixture list', () => {
  assert.deepEqual(byId.get('dev').proofRefs, expectedProofRefs('dev'))
  assert.equal(byId.get('dev').proofRefs[0], PROOF_REF, 'the wiring-proof reference stays first')
  assert.ok(identifier(PROOF_REF), 'the reference is a catalog identifier')
  for (const row of catalog.offerings) {
    assert.deepEqual(row.proofRefs, expectedProofRefs(row.id), `${row.id} proofRefs`)
    if (row.id !== 'dev') assert.ok(!row.proofRefs.includes(PROOF_REF), `${row.id} does not carry dev's wiring-proof reference`)
  }
})

await test("dev's provider rows: claude unchanged, codex the fixture's partial row on codex-graph-host (CP-06)", () => {
  const dev = byId.get('dev')
  assert.deepEqual(dev.providers, {
    claude: { implementation: 'partial', transportId: 'claude-code', limitations: ['REQUIREMENTS_INCOMPLETE'] },
    codex: expectedCodexRow(catalog, 'dev'),
  })
  assert.equal(dev.providers.codex.transportId, 'codex-graph-host')
  assert.equal(dev.requirementsComplete, false)
  assert.equal(dev.nativeReadiness, 'unknown')
  assert.deepEqual(dev.evidenceOwners, ['graphs/dev/workflows/dev-build.js', 'graphs/qa/workflows/harness-repair.js'],
    'dev owns both proven workflows, which is why it carries the reference')
})

await test('the reference id names this contract and its frozen test', () => {
  for (const file of ['spec/contracts/codex-parity-cp-02f.md', 'acceptance/codex-parity/cp-02f-native-graphs.test.mjs']) {
    assert.ok(readFileSync(join(REPO, file), 'utf8').includes(PROOF_REF), `${file} names ${PROOF_REF}`)
  }
})

await test('a reference is never evidence: no derived answer reads proofRefs', () => {
  const variants = { none: [], dev: [PROOF_REF], many: [PROOF_REF, 'another-proof'] }
  for (const row of catalog.offerings) {
    const answers = Object.values(variants).map(refs => {
      const r = withRefs(row, refs)
      return JSON.stringify([installEligible(r, 'claude'), installEligible(r, 'codex'),
        providerImplementation(r, 'claude'), providerImplementation(r, 'codex'), nativeImplementationOf(r)])
    })
    assert.equal(new Set(answers).size, 1, `${row.id}: answers do not depend on proofRefs`)
  }
  const dev = byId.get('dev')
  assert.equal(installEligible(dev, 'codex'), true, 'dev is Codex-installable through its row, not through a reference')
  assert.equal(nativeImplementationOf(dev), 'present-limited', 'dev is present-limited through its row')
  assert.deepEqual(validateCatalog(catalog), [], 'the catalog validates with the reference')
  assert.deepEqual(validateCatalog({ ...catalog, offerings: catalog.offerings.map(o => withRefs(o, [])) }), [], 'and without it')
})

await test('the Codex install plan is exactly the fixture\'s partial rows (the pre-wave two, the wave-flipped graph rows, the codex-skill offerings)', () => {
  assert.deepEqual(installPlan({ installationRoot: REPO, backend: 'codex' }).map(entry => entry.dest),
    expectedPlan(catalog).map(entry => entry.dest))
  assert.deepEqual(PARTIAL_IDS.filter(id => !byId.has(id)), [], 'every fixture id is a catalog row')
})

await test('build-app\'s CP-07 reference is an identifier that names its contract and its test, and its Codex row is the one the contract pins', () => {
  const ref = 'cp-07-build-app-wiring'
  assert.ok(identifier(ref))
  assert.deepEqual(byId.get('build-app').proofRefs, [ref])
  for (const file of ['spec/contracts/codex-parity-cp-07.md', 'graphs/build/tests/driver-codex.test.mjs']) {
    assert.ok(readFileSync(join(REPO, file), 'utf8').includes(ref), `${file} names ${ref}`)
  }
  assert.deepEqual(byId.get('build-app').providers.codex,
    { implementation: 'partial', transportId: 'codex-autobuild', limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] })
  assert.deepEqual(byId.get('build-app').providers.claude, { implementation: 'partial', transportId: 'claude-code', limitations: ['REQUIREMENTS_INCOMPLETE'] })
  assert.equal(byId.get('build-app').requirementsComplete, false)
  assert.equal(byId.get('build-app').nativeReadiness, 'unknown')
  assert.equal(nativeImplementationOf(byId.get('build-app')), 'present-limited')
  assert.deepEqual(catalog.transports.filter(t => t.id === 'codex-autobuild'), STATE.transports.filter(t => t.id === 'codex-autobuild'), 'no new transport')
})
