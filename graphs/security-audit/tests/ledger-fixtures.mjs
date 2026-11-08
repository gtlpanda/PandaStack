// ledger-fixtures.mjs - shared by the audit-ledger tests: recon input, hunter results, and a run seeded with them.
// Not a test file: scripts/test-workflow.mjs runs only *.test.mjs.
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { canonicalCoverageId as canonicalIdOf, validateLedgerFile } from '../skills/security-audit/upstream.mjs'
import { seed } from '../skills/security-audit/audit-ledger.mjs'
import { init, newRun, put, sh } from './audit-fixtures.mjs'

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

// ---- earlier runs: hand-made ledgers and findings that pass both upstream validators ----
const trace = file => [{ kind: 'sink', file, line: 1, scope: 'a', description: 'The write happens.' }]
const evidence = file => [{ file, line: 1, description: 'No check precedes the write.' }]
export const confirmedRecord = (fingerprint, file = 'src/app.js') => ({
  verdict: 'confirmed', fingerprint, title: `Confirmed ${fingerprint}`, description: 'An attacker reaches an operation without the owner check.',
  root_cause: `${fingerprint} omits the ownership check.`, intended_behavior: 'Only the owner changes the object.', trace: trace(file), evidence: evidence(file), conditions: [],
  execution: { attacker_perspective: 'A remote user with an account.', payloads: ['Another user\'s object id.'], instructions: ['Submit the id.'], observed_result: 'The other user\'s object changes.' },
  remediation: { strategy: 'Check ownership first.' },
  severity: { likelihood: { score: 'medium', reason: 'Reachable.' }, impact: { score: 'medium', reason: 'One object changes.' }, overall_severity: 'medium' },
  confidence: { score: 'high', reason: 'Reproduced.' },
})
export const needsValidationRecord = (fingerprint, file = 'src/app.js') => ({
  verdict: 'needs_validation', fingerprint, title: `Lead ${fingerprint}`, description: 'A size may reach an allocation unchecked.', claimed_root_cause: `${fingerprint} may skip a limit.`,
  trace: trace(file), evidence: evidence(file), blockers: ['The generated parser is absent.'], validation_plan: { local: 'Generate it and submit an oversized input.' },
})
export const rejectedRecord = (fingerprint, file = 'src/app.js') => ({
  verdict: 'rejected', fingerprint, title: `Rejected ${fingerprint}`, description: 'The claim was refuted.', claimed_root_cause: `${fingerprint} was claimed to skip a check.`,
  trace: trace(file), evidence: evidence(file), reason: 'Every route passes the wrapper first.',
})

// A prior ledger unit in a given state (upstream's state table), as a finished earlier run would hold it; `over` replaces any field.
export function priorUnit(name, status = 'covered', over = {}) {
  const input = unitInput(name), { reason, status: _status, ...base } = input
  const owner = 'h1-01', reviewed = over.reviewed_paths ?? base.starting_paths
  const live = ['covered', 'candidate', 'blocked'].includes(status) ? { agent_id: owner, reviewed_paths: reviewed, local_checks: [checkOf(owner, reviewed)] } : { agent_id: status === 'in_progress' ? owner : null }
  return {
    coverage_id: canonicalIdOf(base.canonical_refs), ...base, status, wave: 1, prior_status: 'none', attempts: [],
    reviewed_paths: [], local_checks: [], result_fingerprints: [], unresolved: ['blocked', 'deferred', 'out_of_scope', 'not_applicable'].includes(status) ? ['why'] : [],
    ...live, ...over,
  }
}

// A finished earlier run beside the repo's other runs: init makes the run directory, then its ledger and findings are replaced
// with hand-made ones that pass the validators. Returns its run directory.
export function priorRun(repo, units, findings = [], args = []) {
  const r = init([repo, '--full', ...args])
  if (!r.ok) throw new Error(`init failed: ${r.stdout}${r.stderr}`)
  writeFileSync(LEDGER_PATH(r.runDir), JSON.stringify([...units].sort((a, b) => (a.coverage_id < b.coverage_id ? -1 : 1)), null, 2))
  writeFileSync(join(r.runDir, 'findings.json'), JSON.stringify([...findings].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1)), null, 2))
  return r.runDir
}
// Commit `files` ({ path: text | null }) on top of the repo's current commit; null deletes. Returns the new commit.
export function commitChange(repo, files, message = 'change') {
  for (const [p, text] of Object.entries(files)) {
    if (text === null) sh(repo, 'rm', '-q', p)
    else { put(join(repo, p), text); sh(repo, 'add', p) }
  }
  sh(repo, 'commit', '-qm', message)
  return sh(repo, 'rev-parse', 'HEAD')
}
