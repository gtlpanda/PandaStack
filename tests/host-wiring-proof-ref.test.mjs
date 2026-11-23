// CP-02f implementation edges the frozen acceptance does not pin: it checks that
// dev's proofRefs include cp-02f-host-wiring and that no other row carries it. This
// pins the contract's exact catalog result: dev's list is exactly that one id, every
// other row stays empty, dev's codex row is partial (CP-06), the id names the contract
// and its frozen test, and a reference is never evidence (removing it, or adding it to
// every row, changes no eligibility, implementation, validation or install-plan answer).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { validateCatalog, installEligible, nativeImplementationOf, providerImplementation } from '../core/skills/native-runtime/catalog.mjs'
import { identifier } from '../core/skills/native-runtime/catalog-data.mjs'
import { installPlan } from '../core/skills/native-runtime/install-plan.mjs'

const PROOF_REF = 'cp-02f-host-wiring'
const catalog = JSON.parse(readFileSync(join(REPO, 'spec/offering-capabilities.json'), 'utf8'))
const byId = new Map(catalog.offerings.map(o => [o.id, o]))
const withRefs = (row, proofRefs) => ({ ...row, proofRefs })
// Amended at the tier-4 freeze (W2-10): CP-05e appends its own proof reference to dev's
// list, and CP-04e makes blueprint Codex install-eligible. Each pin accepts exactly the
// state before or after that feature; their own frozen tests pin the new state.
const CP05E_REF = 'cp-05e-qa-gate'
const CP06_REF = 'cp-06-dev-codex'
// Amended for CP-06: dev's codex row is partial on codex-graph-host and its list gains CP06_REF.
const blueprintFlipped = byId.get('blueprint').providers.codex.implementation === 'partial'

await test('dev carries exactly the one wiring-proof reference (plus CP-05e\'s and CP-06\'s); every other row carries none', () => {
  assert.ok([[PROOF_REF], [PROOF_REF, CP05E_REF], [PROOF_REF, CP05E_REF, CP06_REF]].map(list => JSON.stringify(list)).includes(JSON.stringify(byId.get('dev').proofRefs)),
    `dev's proofRefs are [${PROOF_REF}], [${PROOF_REF}, ${CP05E_REF}] or [${PROOF_REF}, ${CP05E_REF}, ${CP06_REF}]`)
  assert.ok(identifier(PROOF_REF), 'the reference is a catalog identifier')
  for (const row of catalog.offerings) {
    if (row.id !== 'dev') assert.deepEqual(row.proofRefs, [], `${row.id} has no proofRefs`)
  }
})

await test("dev's provider rows: claude unchanged, codex partial on codex-graph-host (CP-06)", () => {
  const dev = byId.get('dev')
  assert.deepEqual(dev.providers, {
    claude: { implementation: 'partial', transportId: 'claude-code', limitations: ['REQUIREMENTS_INCOMPLETE'] },
    codex: { implementation: 'partial', transportId: 'codex-graph-host',
      limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] },
  })
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

await test('the Codex install plan names autobuild and bughunt (and blueprint after CP-04e, dev after CP-06)', () => {
  assert.deepEqual(installPlan({ installationRoot: REPO, backend: 'codex' }).map(entry => entry.dest),
    blueprintFlipped ? ['skills/autobuild', 'skills/blueprint', 'skills/bughunt', 'skills/dev'] : ['skills/autobuild', 'skills/bughunt'])
})
