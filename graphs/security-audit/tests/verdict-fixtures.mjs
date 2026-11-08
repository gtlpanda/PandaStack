// verdict-fixtures.mjs - shared by the consolidate, validate and verify tests: a run taken, in process, to the point where hunting is over and the
// candidates are waiting for their verifiers. Not a test file: scripts/test-workflow.mjs runs only *.test.mjs.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyCritic, mergeWave, planWave } from '../skills/security-audit/audit-ledger.mjs'
import { advanceState } from '../skills/security-audit/audit-run.mjs'
import { audit } from './audit-fixtures.mjs'
import { candidateOf, hunterResult, hunterUnit, needsValidationRecord, readJsonFile, readLedger, refsOf, seeded, unitInput } from './ledger-fixtures.mjs'

export const nameOf = u => u.canonical_refs.surface.split('#')[1]
export const unitByName = runDir => Object.fromEntries(readLedger(runDir).map(u => [nameOf(u), u]))
export const next = runDir => audit(['next', runDir]).last
export const events = runDir => readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))

// Two critics that find nothing, one after the other (the post-wave critic, then the distinct final-clean critic): hunting is over.
export function closeCoverage(runDir) {
  for (const kind of ['post-wave', 'final-clean']) {
    advanceState(runDir, 'critic', { critic_kind: kind })
    advanceState(runDir, 'mint')
    applyCritic(runDir, { missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: true }, { units: [] })
  }
}

// A run whose hunters have reported. `defs` is one entry per unit: { name, candidates: [fingerprint | [fingerprint, overrides]], prior? } (each unit has a subsystem of its
// own, so each has a hunter of its own, h1-01 onwards in the ledger's order). A candidate is a needs_validation record, as a hunter writes one (candidateOf); the unit
// that links it is `candidate`, the others `covered`. `opts` goes to the fixture repo and to init. Returns { repo, runDir, owners: { unit name -> hunter ID } }.
export function atValidation(defs, opts = {}) {
  const run = seeded(defs.map(d => unitInput(d.name, { canonical_refs: refsOf(d.name, { subsystem: d.name }) })), opts)
  planWave(run.runDir)
  advanceState(run.runDir, 'hunt')
  const byName = unitByName(run.runDir)
  const results = {}
  const owners = {}
  for (const d of defs) {
    const u = byName[d.name]
    owners[d.name] = u.agent_id
    const found = (d.candidates ?? []).map(c => (Array.isArray(c) ? c : [c, {}]))
    results[u.agent_id] = hunterResult([hunterUnit(u.coverage_id, u.agent_id, found.length ? { disposition: 'candidate', candidate_fingerprints: found.map(f => f[0]) } : {})], { candidates: found.map(([fp, over]) => candidateOf(fp, over)) })
  }
  mergeWave(run.runDir, results)
  closeCoverage(run.runDir)
  return { ...run, owners }
}

// What a verifier returns for a candidate: the decision and a record of that verdict (a needs_validation record unless `record` says otherwise).
export const verified = (fingerprint, over = {}) => ({ decision: 'needs_validation', record: { ...needsValidationRecord(fingerprint), ...over } })
export const pool = runDir => readJsonFile(runDir, 'candidates.json')
