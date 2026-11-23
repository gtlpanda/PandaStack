// CP-05e implementation edges the frozen acceptance does not pin. The frozen case 4
// checks dev's exact proofRefs, that only dev carries cp-05e-qa-gate, that dev's codex
// row is unavailable and that the drift guard is clean. This adds: the id is a catalog
// identifier that names the contract and its frozen test (the contract's review item);
// dev carries it because dev alone owns the graphs/qa evidence; and the new reference is
// never evidence (dropping it from dev, or adding it to every row, changes no derived
// eligibility, implementation or validation answer).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { validateCatalog, installEligible, nativeImplementationOf, providerImplementation } from '../core/skills/native-runtime/catalog.mjs'
import { identifier } from '../core/skills/native-runtime/catalog-data.mjs'

const PROOF_REF = 'cp-05e-qa-gate'
const HOST_WIRING_REF = 'cp-02f-host-wiring'
const QA_EVIDENCE = 'graphs/qa/workflows/harness-repair.js'
const catalog = JSON.parse(readFileSync(join(REPO, 'spec/offering-capabilities.json'), 'utf8'))
const dev = catalog.offerings.find(o => o.id === 'dev')

const derivedAnswers = row => JSON.stringify([
  installEligible(row, 'claude'), installEligible(row, 'codex'),
  providerImplementation(row, 'claude'), providerImplementation(row, 'codex'), nativeImplementationOf(row),
])

await test('the QA gate reference is a catalog identifier appended after the host-wiring one', () => {
  assert.ok(identifier(PROOF_REF), 'the reference is a catalog identifier')
  // CP-06 appends cp-06-dev-codex after this reference.
  assert.deepEqual(dev.proofRefs, [HOST_WIRING_REF, PROOF_REF, 'cp-06-dev-codex'], 'appended, not reordered or replacing')
  assert.equal(new Set(dev.proofRefs).size, dev.proofRefs.length, 'no duplicate reference')
})

await test('the reference id names this contract and its frozen test', () => {
  for (const file of ['spec/contracts/codex-parity-cp-05e.md', 'acceptance/codex-parity/cp-05e-qa-gate.test.mjs']) {
    assert.ok(readFileSync(join(REPO, file), 'utf8').includes(PROOF_REF), `${file} names ${PROOF_REF}`)
  }
})

await test('dev carries it because dev alone owns the graphs/qa evidence', () => {
  assert.ok(dev.evidenceOwners.includes(QA_EVIDENCE), `dev owns ${QA_EVIDENCE}`)
  const qaOwners = catalog.offerings.filter(o => o.evidenceOwners?.some(path => path.startsWith('graphs/qa/')))
  assert.deepEqual(qaOwners.map(o => o.id), ['dev'], 'no other offering owns graphs/qa evidence')
  assert.equal(catalog.offerings.some(o => o.id === 'qa'), false, 'graphs/qa has no owning offering of its own')
})

await test('the QA gate reference is never evidence: no derived answer reads it', () => {
  const withoutRef = { ...dev, proofRefs: [HOST_WIRING_REF, 'cp-06-dev-codex'] }
  assert.equal(derivedAnswers(dev), derivedAnswers(withoutRef), 'dropping the reference changes no dev answer')
  // CP-06 flips dev's codex row to partial: installable, present-limited, and still not from a reference.
  assert.equal(installEligible(dev, 'codex'), true, 'dev is Codex-installable through its row, not through a reference')
  assert.equal(nativeImplementationOf(dev), 'present-limited', 'dev is present-limited through its row')
  for (const row of catalog.offerings) {
    const tagged = { ...row, proofRefs: [...new Set([...row.proofRefs, PROOF_REF])] }
    assert.equal(derivedAnswers(tagged), derivedAnswers(row), `${row.id}: answers do not depend on ${PROOF_REF}`)
  }
  assert.deepEqual(validateCatalog(catalog), [], 'the catalog validates with the reference')
  const reverted = { ...catalog, offerings: catalog.offerings.map(o => (o.id === 'dev' ? withoutRef : o)) }
  assert.deepEqual(validateCatalog(reverted), [], 'and without it')
})
