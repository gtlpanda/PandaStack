// report-fixtures.mjs - shared by the report tests: a run directory made by hand from fixed values (so a report made from it is the same bytes on every machine), holding a ledger
// and findings that pass both vendored validators. Not a test file: scripts/test-workflow.mjs runs only *.test.mjs.
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { EXECUTION_BLOCKERS, EXECUTION_POLICY, SHARED_FILE_OWNERS } from '../skills/security-audit/audit-run.mjs'
import { validateFindingsFile, validateLedgerFile } from '../skills/security-audit/upstream.mjs'
import { fresh } from './audit-fixtures.mjs'
import { confirmedRecord, needsValidationRecord, priorUnit, rejectedRecord } from './ledger-fixtures.mjs'

export const COMMIT = 'a'.repeat(40)
export const TREE_FILES = { 'src/app.js': Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n', 'src/db.js': 'export const q = s => s\n', 'src/files.js': Array.from({ length: 12 }, (_, i) => `f${i}`).join('\n') + '\n' }
const byId = (a, b) => (a.coverage_id < b.coverage_id ? -1 : 1)
const byFp = (a, b) => (a.fingerprint < b.fingerprint ? -1 : 1)

export const META = (over = {}) => ({
  version: 1, run_id: 'run-7', repo: 'fixture-repo', target: '/fixture/target', source_ref: { commit: COMMIT, tree: 'b'.repeat(40), dirty: false, uncommitted: { tracked: 0, untracked: 0 } },
  profile: 'standard', scope_paths: [], budget: null, limits: { max_parallel: 8, max_units_per_hunter: 4 }, execution_policy: EXECUTION_POLICY, execution_capability: 'none', execution_blockers: EXECUTION_BLOCKERS,
  selected_companion_files: [], prior_run_paths: [], shared_file_owners: SHARED_FILE_OWNERS, upstream_pin: { repo: 'x', commit: 'y' }, agents_spent: 23, stage_spend: { 'earlier': 23 }, agents_planned: null,
  run_status: 'complete', incomplete_reason: null, created: '2026-01-01T00:00:00.000Z', ...over,
})
export const STATE = (over = {}) => ({ version: 1, last: 'verify', wave: 2, critic_kind: 'final-clean', updated: '2026-01-01T00:00:00.000Z', ...over })
// A ledger unit by name, in a state: labels are fixed text, and `over` replaces any field. A candidate carries `result_fingerprints`.
export const UNIT = (name, status = 'covered', over = {}) => ({ ...priorUnit(name, status, { surface: `Route ${name}`, boundary: `Boundary of ${name}`, ...over }), prior_status: 'none', ...(over.priority_class !== undefined ? { priority_class: over.priority_class } : {}) })
export const NV = (fp, over = {}) => ({ ...needsValidationRecord(fp), ...over })
export const RJ = (fp, over = {}) => ({ ...rejectedRecord(fp), ...over })
export const CF = (fp, over = {}) => ({ ...confirmedRecord(fp), ...over })

// Writes the run and checks that what it wrote passes both vendored validators, as every test that makes an artifact must. Files are written only for what is given:
// a run that stopped before the ledger has none.
export function fixtureRun({ meta = META(), state = STATE(), ledger = null, findings = null, decisions = null, pool = [], priors = [], critic = null, files = TREE_FILES } = {}) {
  const dir = fresh('report')
  mkdirSync(join(dir, 'tree', 'src'), { recursive: true })
  for (const [p, text] of Object.entries(files)) writeFileSync(join(dir, 'tree', p), text)
  const put = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2))
  put('run-metadata.json', meta)
  put('stage-state.json', state)
  writeFileSync(join(dir, 'events.jsonl'), '')
  put('prior-runs.json', priors)
  put('candidates.json', pool)
  if (ledger) put('coverage-ledger.json', [...ledger].sort(byId))
  if (findings) put('findings.json', [...findings].sort(byFp))
  if (decisions) put('decisions.json', decisions)
  if (critic) put('critic.json', critic)
  if (ledger && !validateLedgerFile(join(dir, 'coverage-ledger.json')).valid) throw new Error('the fixture ledger does not pass upstream\'s validator')
  if (findings && !validateFindingsFile(join(dir, 'findings.json')).valid) throw new Error(`the fixture findings do not pass upstream's validator: ${validateFindingsFile(join(dir, 'findings.json')).lastLine}`)
  return dir
}
// decisions.json for entries: { fingerprint, n, state, unresolved?, record? }; the rest is the shape the stages write.
export const DECISIONS = entries => ({ version: 1, rounds: { validate: 1, verify: 1 }, entries: entries.map(e => ({ proposed_verdict: 'needs_validation', attempts: [], decision: null, record: null, verifier_id: null, unresolved: null, phase5: null, state: 'decided', ...e })) })
