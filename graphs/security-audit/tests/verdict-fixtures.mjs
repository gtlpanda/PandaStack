// verdict-fixtures.mjs - shared by the consolidate, validate and verify tests: a run taken, in process, to the point where hunting is over and the
// candidates are waiting for their verifiers. Not a test file: scripts/test-workflow.mjs runs only *.test.mjs.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyCritic, mergeWave, planWave } from '../skills/security-audit/audit-ledger.mjs'
import { advanceState } from '../skills/security-audit/audit-run.mjs'
import assert from 'node:assert/strict'
import { audit } from './audit-fixtures.mjs'
import { returnedFile, runScript, stage, stageDirOf } from './stage-fixtures.mjs'
import { candidateOf, checkOf, hunterResult, hunterUnit, needsValidationRecord, readJsonFile, readLedger, refsOf, rejectedRecord, seeded, unitInput } from './ledger-fixtures.mjs'

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

// A run whose hunters have reported. `defs` is one entry per unit: { name, candidates: [fingerprint | [fingerprint, overrides]], unit?, hardening?, uncovered?, checkResult? } (each unit
// has a subsystem of its own, so each has a hunter of its own, h1-01 onwards in the ledger's order). A candidate is a needs_validation record, as a hunter writes one (candidateOf);
// the unit that links it is `candidate`, the others `covered`. `unit` overrides the unit's recon input (its companion blocks, for one), `checkResult` is the prose of its check.
// `opts` goes to the fixture repo and to init. Returns { repo, runDir, owners: { unit name -> hunter ID } }.
export function atValidation(defs, opts = {}) {
  const run = seeded(defs.map(d => unitInput(d.name, { canonical_refs: refsOf(d.name, { subsystem: d.name }), ...d.unit })), opts)
  planWave(run.runDir)
  advanceState(run.runDir, 'hunt')
  const byName = unitByName(run.runDir)
  const results = {}
  const owners = {}
  for (const d of defs) {
    const u = byName[d.name]
    if (u.status !== 'in_progress') continue   // a carried prior record's unit belongs to its verifier and is not hunted
    owners[d.name] = u.agent_id
    const found = (d.candidates ?? []).map(c => (Array.isArray(c) ? c : [c, {}]))
    const check = checkOf(u.agent_id, ['src/app.js'], d.checkResult ? { result: d.checkResult } : {})
    results[u.agent_id] = hunterResult([hunterUnit(u.coverage_id, u.agent_id, { checks: [check], ...(found.length && { disposition: 'candidate', candidate_fingerprints: found.map(f => f[0]) }) })],
      { candidates: found.map(([fp, over]) => candidateOf(fp, over)), hardening: d.hardening ?? [], uncovered: d.uncovered ?? [] })
  }
  mergeWave(run.runDir, results)
  closeCoverage(run.runDir)
  return { ...run, owners }
}

// What a verifier returns for a candidate: the decision and a record of that verdict (a needs_validation record unless `record` says otherwise).
export const verified = (fingerprint, over = {}) => ({ decision: 'needs_validation', record: { ...needsValidationRecord(fingerprint), ...over } })
export const rejected = fingerprint => ({ decision: 'rejected', record: rejectedRecord(fingerprint) })
export const pool = runDir => readJsonFile(runDir, 'candidates.json')
export const decisions = runDir => readJsonFile(runDir, 'decisions.json')
export const history = runDir => readJsonFile(runDir, 'agent-history.json')

// Hunting over and consolidation skipped: the point validate starts from.
export const toValidate = (defs, opts) => { const run = atValidation(defs, opts); advanceState(run.runDir, 'consolidate'); return run }
// plan, run the generated script against analysts that answer by label with answerFor(label, input), apply: { plan, dir, input, ran, apply, prompts }.
export async function round(runDir, answerFor) {
  const plan = stage(['plan', runDir])
  assert.equal(plan.status, 0, plan.stdout)
  const dir = stageDirOf(plan, runDir)
  const input = readJsonFile(dir, 'input.json')
  const ran = await runScript(join(dir, 'run.js'), { 'audit-analyst': input.candidates.map(() => (prompt, opts) => answerFor(opts.label, input.candidates.find(c => c.agent_id === opts.label))) })
  return { plan, dir, input, ran, apply: stage(['apply', runDir, returnedFile(dir, ran.result)]), prompts: Object.fromEntries(ran.calls.map(c => [c.label, c.prompt])) }
}
export const good = c => verified(c.fingerprint)
