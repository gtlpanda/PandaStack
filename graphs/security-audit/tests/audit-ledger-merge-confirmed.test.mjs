// audit-ledger-merge-confirmed.test.mjs - merge-wave and a hunter candidate that proposes "confirmed". The hunter prompt
// (security-audit-flow.js) says no sandbox exists and "a proposed confirmed is rejected", so merge-wave must send the unit back.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeWave, planWave } from '../skills/security-audit/audit-ledger.mjs'
import { advanceState } from '../skills/security-audit/audit-run.mjs'
import { assignments, candidateOf, hunterResult, hunterUnit, readJsonFile, readLedger, refsOf, seeded, unitInput } from './ledger-fixtures.mjs'

test('a hunter candidate proposing "confirmed" is rejected: the unit returns to planned and nothing enters candidates.json', () => {
  const { runDir } = seeded([unitInput('a', { canonical_refs: refsOf('a', { subsystem: 'src' }) })])
  planWave(runDir)
  advanceState(runDir, 'hunt')
  const [[agent, [id]]] = Object.entries(assignments(runDir))
  const result = hunterResult([hunterUnit(id, agent, { disposition: 'candidate', candidate_fingerprints: ['fp-confirmed'] })], { candidates: [candidateOf('fp-confirmed', { proposed_verdict: 'confirmed' })] })
  mergeWave(runDir, { [agent]: result })
  const [unit] = readLedger(runDir)
  assert.equal(unit.status, 'planned', 'BUGHUNT-F3 merge-wave accepted a hunter candidate proposing confirmed (unit is not returned to planned) although the hunter prompt says a proposed confirmed is rejected')
  const pool = existsSync(join(runDir, 'candidates.json')) ? readJsonFile(runDir, 'candidates.json') : []
  assert.deepEqual(pool.map(c => [c.fingerprint, c.proposed_verdict]), [], 'BUGHUNT-F3 candidates.json holds a proposed confirmed candidate')
})
