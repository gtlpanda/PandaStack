// upstream.test.mjs - the wrappers around the vendored Cloudflare validators
// (graphs/security-audit/skills/security-audit/upstream.mjs): where the vendor tree is found, the last
// line and exit code of each CLI, and the functions re-exported from the validators.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, existsSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import {
  VENDOR_DIR, VENDOR_SKILL_DIR, lastLine, runValidator, validateFindingsFile, validateLedgerFile,
  canonicalCoverageId, isSafeAgentId, validateFindingsDocument, validateLedgerDocument,
} from '../skills/security-audit/upstream.mjs'

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'security-audit')

// A needs_validation and a rejected finding: the only two verdicts a source-only audit can produce.
// Fresh objects every time: the validator rejects one object that appears twice in a document.
const trace = () => [{ kind: 'sink', file: 'src/router.ts', line: 10, scope: 'dispatch', description: 'Attacker data reaches the operation.' }]
const evidence = () => [{ file: 'src/router.ts', line: 10, description: 'The source performs the operation without a check.' }]
const needsValidation = () => ({
  verdict: 'needs_validation', fingerprint: 'src-parser-size-hypothesis', title: 'Unchecked parsed size',
  description: 'A parsed size may reach an allocation without a limit.',
  claimed_root_cause: 'parse_size may pass an unbounded value to allocate.', trace: trace(), evidence: evidence(),
  blockers: ['The generated parser source is absent from this checkout.'],
  validation_plan: { local: 'Generate the parser and submit the smallest input over the limit.' },
})
const rejected = () => ({
  verdict: 'rejected', fingerprint: 'src-router-auth-bypass', title: 'Authorization bypass in router',
  description: 'The candidate claimed a route bypassed authorization.',
  claimed_root_cause: 'dispatch was claimed to skip the authorization wrapper.', trace: trace(), evidence: evidence(),
  reason: 'All routes pass through the authorization wrapper before dispatch.',
})
// Sorted by fingerprint, as the validator requires.
const validFindings = () => [needsValidation(), rejected()].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1))
const REFS = { surface: 'src/router.ts#POST /users/:id', boundary: 'src/authz.ts#requireOwner', subsystem: 'packages/api', attack_class: 'ATTACK-CLASSES.md#Access control' }
const plannedUnit = (over = {}) => ({
  coverage_id: canonicalCoverageId(REFS), canonical_refs: REFS,
  surface: 'Update-user route', boundary: 'Object ownership', subsystem: 'API', attack_class: 'Access control',
  starting_paths: ['src/router.ts'], ordinary_attack_class_block: 'ATTACK-CLASSES.md#Access control',
  selected_companion_blocks: [], excluded_blocks: [], prior_status: 'new', attempts: [], wave: 1, status: 'planned',
  agent_id: null, reviewed_paths: [], local_checks: [], result_fingerprints: [], unresolved: [], ...over,
})

// Write `contents` to a file in a fresh temp dir, hand its path to fn, and clean up.
function withFile(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-test-'))
  try {
    const file = join(dir, 'doc.json')
    writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents))
    return fn(file)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('== upstream.mjs: where the vendored skill is')
await test('VENDOR_DIR holds the pinned tree, and is the same through a symlinked skill directory', () => {
  assert.equal(VENDOR_DIR, realpathSync(VENDOR_DIR))
  for (const f of ['UPSTREAM.json', 'LICENSE']) assert.ok(existsSync(join(VENDOR_DIR, f)), f)
  for (const f of ['validate-findings.cjs', 'validate-coverage-ledger.cjs', 'report-schema.json']) assert.ok(existsSync(join(VENDOR_SKILL_DIR, f)), f)
  // install.sh links the skill directory into ~/.claude: import through such a link.
  const dir = mkdtempSync(join(tmpdir(), 'upstream-link-'))
  try {
    symlinkSync(SKILL_DIR, join(dir, 'linked'))
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(join(dir, 'linked', 'upstream.mjs'))}).then(m => console.log(m.VENDOR_DIR))`], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), VENDOR_DIR)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log('== upstream.mjs: the CLI wrappers')
await test('lastLine is the last non-empty line, ignoring trailing blanks and carriage returns', () => {
  assert.equal(lastLine('PASS: 1 findings valid\n'), 'PASS: 1 findings valid')
  assert.equal(lastLine('ERROR: a\r\nFAIL: 1 validation error(s)\r\n\n\n'), 'FAIL: 1 validation error(s)')
  assert.equal(lastLine(''), '')
  assert.equal(lastLine('\n \n'), '')
})
await test('findings validator: a valid document is its PASS line and exit 0; an invalid one is its FAIL line and exit 1', () => {
  assert.deepEqual(withFile(validFindings(), validateFindingsFile), { lastLine: 'PASS: 2 findings valid', exitCode: 0 })
  // Only the order is wrong, so exactly one error.
  assert.deepEqual(withFile(validFindings().reverse(), validateFindingsFile), { lastLine: 'FAIL: 1 validation error(s)', exitCode: 1 })
  assert.equal(withFile([{ verdict: 'confirmed' }], validateFindingsFile).exitCode, 1)
})
await test('ledger validator: a valid document is its PASS line and exit 0; an invalid one is its FAIL line and exit 1', () => {
  assert.deepEqual(withFile([plannedUnit()], validateLedgerFile), { lastLine: 'PASS: 1 coverage units valid', exitCode: 0 })
  assert.deepEqual(withFile([plannedUnit({ coverage_id: 'display-label-slug' })], validateLedgerFile), { lastLine: 'FAIL: 1 validation error(s)', exitCode: 1 })
})
await test('input a validator rejects before validating: its own message is the last line, exit 1', () => {
  assert.deepEqual(withFile('[', validateFindingsFile), { lastLine: 'Failed to parse findings JSON: invalid JSON syntax', exitCode: 1 })
  assert.deepEqual(withFile('[', validateLedgerFile), { lastLine: 'Failed to parse coverage ledger: input has truncated JSON structure', exitCode: 1 })
  const missing = join(tmpdir(), 'upstream-test-no-such-dir', 'x.json')
  assert.deepEqual(validateFindingsFile(missing), { lastLine: 'Failed to read findings JSON: input could not be opened or read safely', exitCode: 1 })
  assert.deepEqual(validateLedgerFile(missing), { lastLine: 'Failed to read coverage ledger: input could not be opened or read safely', exitCode: 1 })
})
await test('a run with no verdict throws instead of returning an exit code', () => {
  withFile([], file => {
    assert.throws(() => validateFindingsFile(file, { timeoutMs: 1 }), /validate-findings\.cjs: no answer in 1 ms/)
    assert.throws(() => runValidator('no-such-validator.cjs', file), /vendored validator is missing/)
  })
  for (const bad of [undefined, null, '', 7, {}]) assert.throws(() => validateLedgerFile(bad), /a file path is required/, String(bad))
})

console.log('== upstream.mjs: the re-exported functions')
await test('canonicalCoverageId and isSafeAgentId are the validator\'s own, and its ledger accepts what they make', () => {
  assert.equal(canonicalCoverageId({ surface: 'route:POST /users', boundary: 'b', subsystem: 'c', attack_class: 'd' }), 'route%3APOST%20%2Fusers::b::c::d')
  assert.equal(canonicalCoverageId({ surface: 'a', boundary: 'b', subsystem: 'c', attack_class: 'd', lifecycle: 'retry' }), 'a::b::c::d::retry')
  assert.throws(() => canonicalCoverageId({ surface: 'a', boundary: 'b', subsystem: 'c' }), /missing or unexpected/)
  for (const id of ['hunter-1', 'verifier_2', 'a0']) assert.equal(isSafeAgentId(id), true, id)
  for (const id of ['Hunter-1', 'con', 'com1', '../hunter', 'hunter.1', '', null, 7]) assert.equal(isSafeAgentId(id), false, String(id))
})
await test('the document validators return the error lists the CLIs print, so both gates agree', () => {
  assert.deepEqual(validateFindingsDocument(validFindings()), [])
  assert.equal(validateFindingsDocument(validFindings().reverse()).length, 1)
  assert.match(validateFindingsDocument(validFindings().reverse())[0], /sorted lexicographically/)
  assert.deepEqual(validateLedgerDocument([plannedUnit()]), [])
  assert.match(validateLedgerDocument([plannedUnit({ coverage_id: 'x' })])[0], /expected canonical ID/)
  assert.deepEqual(validateLedgerDocument({ units: [] }), ['$: expected a top-level array'])
  // The same four documents through the CLI: PASS exactly when the error list is empty.
  for (const [doc, run, validate] of [[validFindings(), validateFindingsFile, validateFindingsDocument], [validFindings().reverse(), validateFindingsFile, validateFindingsDocument],
    [[plannedUnit()], validateLedgerFile, validateLedgerDocument], [[plannedUnit({ coverage_id: 'x' })], validateLedgerFile, validateLedgerDocument]]) {
    assert.equal(withFile(doc, run).exitCode === 0, validate(doc).length === 0)
  }
})
