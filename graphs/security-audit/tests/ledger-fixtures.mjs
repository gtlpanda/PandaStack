// ledger-fixtures.mjs - shared by the audit-ledger tests: recon input, hunter results, and a run seeded with them.
// Not a test file: scripts/test-workflow.mjs runs only *.test.mjs.
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { validateLedgerFile } from '../skills/security-audit/upstream.mjs'
import { seed } from '../skills/security-audit/audit-ledger.mjs'
import { newRun } from './audit-fixtures.mjs'

export const ARCH = 'The fixture app routes requests to handlers and a tiny data layer.'
export const LEDGER_PATH = runDir => join(runDir, 'coverage-ledger.json')
export const readLedger = runDir => JSON.parse(readFileSync(LEDGER_PATH(runDir), 'utf8'))
export const ledgerBytes = runDir => readFileSync(LEDGER_PATH(runDir), 'utf8')
export const readJsonFile = (runDir, name) => JSON.parse(readFileSync(join(runDir, name), 'utf8'))
export const ledgerValid = runDir => validateLedgerFile(LEDGER_PATH(runDir)).valid

export const refsOf = (name, over = {}) => ({ surface: `src/app.js#${name}`, boundary: 'src/db.js#q', subsystem: 'src', attack_class: 'ATTACK-CLASSES.md#Access control', ...over })
// A recon unit: canonical_refs (source-derived), display labels (unique per name, or two units would be one semantic tuple), blocks.
export const unitInput = (name, over = {}) => ({
  canonical_refs: refsOf(name), surface: `Route ${name}`, boundary: 'Query helper', subsystem: 'Source', attack_class: 'Access control',
  starting_paths: ['src/app.js'], ordinary_attack_class_block: 'ATTACK-CLASSES.md#Access control', selected_companion_blocks: [], excluded_blocks: [],
  priority_class: 2, ...over,
})
export const reconInput = (units, over = {}) => ({ architecture_md: ARCH, units, ...over })

// A run on a fresh fixture repo, seeded: { repo, runDir, ids } with the IDs in ledger order.
export function seeded(units, opts) {
  const run = newRun(opts)
  seed(run.runDir, reconInput(units))
  return { ...run, ids: readLedger(run.runDir).map(u => u.coverage_id) }
}

// The hunter side of a wave: what plan-wave assigned, as { agent id -> [coverage_id] }, from the ledger.
export function assignments(runDir) {
  const out = {}
  for (const u of readLedger(runDir)) if (u.status === 'in_progress') (out[u.agent_id] ??= []).push(u.coverage_id)
  return out
}

export const checkOf = (agent, paths = ['src/app.js'], over = {}) => ({
  agent_id: agent, reviewed_paths: paths, invariant: 'the handler checks ownership before the write', method: 'source',
  result: 'the handler calls requireOwner before it writes', artifact: null, ...over,
})
export const hunterUnit = (id, agent, over = {}) => ({
  coverage_id: id, disposition: 'covered', reviewed_paths: ['src/app.js'], checks: [checkOf(agent)], candidate_fingerprints: [], unresolved: [], ...over,
})
export const hunterResult = (units, over = {}) => ({ units, candidates: [], hardening: [], uncovered: [], ...over })
export const candidateOf = (fingerprint, over = {}) => ({
  fingerprint, proposed_verdict: 'needs_validation', title: 'Unchecked owner on update', description: 'The update handler may skip the owner check.',
  claimed_root_cause: 'update does not call requireOwner.', trace: [{ kind: 'sink', file: 'src/app.js', line: 1, scope: 'a', description: 'The write happens.' }],
  evidence: [{ file: 'src/app.js', line: 1, description: 'No check precedes the write.' }],
  blockers: ['No sandbox exists to run the handler.'], validation_plan: { local: 'Call update as a second user.' }, ...over,
})
// A hunter result that closes every unit it was assigned as covered.
export const coverAll = assigned => Object.fromEntries(Object.entries(assigned).map(([agent, ids]) => [agent, hunterResult(ids.map(id => hunterUnit(id, agent)))]))
