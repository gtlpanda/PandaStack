// audit-findings-write.test.mjs - audit-findings.mjs write, link-check and complete-check: findings.json written only through both vendored validators and the link-check, a
// failure leaving the previous file intact and the run incomplete, the cross-checks upstream's validators cannot make (the plan's negatives), complete-check closing upstream's
// prose-only rule, and what `next` does around them. Every artifact is judged by the real vendored validators.
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { commitFindings, completeProblems, decisionsOf, ensureDecisions, evidenceLinks, finalRecords, finishRun, historyOf, linkCheck, needsPhase5, readPool, recordAgent, saveDecisions } from '../skills/security-audit/audit-findings.mjs'
import { advanceState, loadRun, markComplete, markIncomplete, recordSpend } from '../skills/security-audit/audit-run.mjs'
import { validateFindingsFile, validateLedgerFile } from '../skills/security-audit/upstream.mjs'
import { audit, ENV, meta, newRun } from './audit-fixtures.mjs'
import { confirmedRecord, needsValidationRecord, readJsonFile, readLedger } from './ledger-fixtures.mjs'
import { atValidation, decisions, events, next, rejected, round, toValidate, unitByName, verified } from './verdict-fixtures.mjs'

const FINDINGS = 'findings.json'
const AUDIT_FINDINGS = join(import.meta.dirname, '..', 'skills', 'security-audit', 'audit-findings.mjs')
const cli = (cmd, runDir) => { const r = spawnSync(process.execPath, [AUDIT_FINDINGS, cmd, runDir], { encoding: 'utf8', env: { ...process.env, ...ENV } }); const lines = r.stdout.trim().split('\n'); return { status: r.status, stdout: r.stdout, stderr: r.stderr, last: lines.at(-1), lines } }
// The history with fp-a's Phase 3 verifier also serving as its replacement verifier: the reuse independence forbids.
const recordAgentBroken = h => ({ ...h, fingerprints: { ...h.fingerprints, 'fp-a': [...h.fingerprints['fp-a'], { role: 'replacer', id: h.fingerprints['fp-a'].find(e => e.role === 'validator').id }] } })
const found = runDir => JSON.parse(readFileSync(join(runDir, FINDINGS), 'utf8'))
const validators = runDir => [validateFindingsFile(join(runDir, FINDINGS)).valid, validateLedgerFile(join(runDir, 'coverage-ledger.json')).valid]
const ok = runDir => { assert.deepEqual(validators(runDir), [true, true], 'both vendored validators pass'); assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`) }

// A run whose candidates are validated (two leads and a rejection): the point `write` starts from.
async function validated(defs = [{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }, { name: 'c', candidates: ['fp-c'] }], opts, answer = (l, c) => (c.fingerprint === 'fp-b' ? rejected('fp-b') : verified(c.fingerprint, { title: `Verified ${c.fingerprint}` }))) {
  const run = toValidate(defs, opts)
  const res = await round(run.runDir, answer)
  assert.equal(res.apply.status, 0, res.apply.stdout)
  assert.equal(next(run.runDir), 'NEXT: write-findings run=helper')
  return run
}
// What verify does when its last round is applied, minus the stage itself: every retained record verified by a Phase 5 verifier of its own, and the step saved.
function markVerified(runDir) {
  const d = decisions(runDir)
  let h = historyOf(runDir)
  const entries = d.entries.map(e => {
    if (e.state !== 'decided' || !needsPhase5(e.record)) return e
    const id = `r${String(e.n).padStart(2, '0')}`
    h = recordAgent(h, e.fingerprint, 'verifier', id)
    return { ...e, phase5: { state: 'verified', verifier_id: id, attempts: [], replacement: null, rounds: 0, reason: null } }
  })
  saveDecisions(runDir, { ...d, entries })
  writeFileSync(join(runDir, 'agent-history.json'), JSON.stringify(h))
  advanceState(runDir, 'verify')
}

console.log('== write: findings.json from the decided records')
await test('write puts the decided records, sorted by fingerprint, in findings.json through both vendored validators, saves the step, and next says verify', async () => {
  const run = await validated()
  const r = cli('write', run.runDir)
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.last, /^AUDIT: OK write records=3 confirmed=0 needs_validation=2 rejected=1$/)
  assert.deepEqual(found(run.runDir).map(x => [x.fingerprint, x.verdict]), [['fp-a', 'needs_validation'], ['fp-b', 'rejected'], ['fp-c', 'needs_validation']])
  assert.equal(found(run.runDir)[0].title, 'Verified fp-a', 'the verifier\'s record, not the hunter\'s wording')
  ok(run.runDir)
  assert.equal(next(run.runDir), 'NEXT: verify run=workflow')
  assert.deepEqual(readJsonFile(run.runDir, 'evidence-links.json').map(l => [l.fingerprint, l.verdict, l.units.length, l.units[0].checks.map(c => c.method)]), [['fp-a', 'needs_validation', 1, ['source', 'source']], ['fp-b', 'rejected', 1, ['source', 'source']], ['fp-c', 'needs_validation', 1, ['source', 'source']]])
  assert.equal(meta(run.runDir).run_status, 'in_progress', 'Phase 5 has yet to read the records')
  assert.ok(!existsSync(join(run.runDir, 'findings.json.candidate')))
  assert.deepEqual(events(run.runDir).filter(e => e.cmd === 'write-findings').map(e => [e.result, e.counts]), [['ok', { confirmed: 0, needs_validation: 2, rejected: 1 }]])
})
await test('a run with no candidate writes an empty findings.json and is complete: nothing needs Phase 5, and next goes to the report', () => {
  const run = atValidation([{ name: 'a', candidates: [] }, { name: 'b', candidates: [] }])
  assert.equal(next(run.runDir), 'NEXT: write-findings run=helper')
  const r = cli('write', run.runDir)
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /^note: no record needs Phase 5; every candidate has an independent final disposition and every retained record passed Phase 5: the run is complete$/m)
  assert.deepEqual(found(run.runDir), [])
  assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['complete', null])
  assert.equal(next(run.runDir), 'NEXT: report run=helper')
  ok(run.runDir)
})
await test('a run whose every candidate was rejected is complete after write: a rejected record is final and is not verified again', async () => {
  const run = await validated([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }], undefined, (l, c) => rejected(c.fingerprint))
  const r = cli('write', run.runDir)
  assert.equal(r.status, 0, r.stdout)
  assert.deepEqual(found(run.runDir).map(x => x.verdict), ['rejected', 'rejected'])
  assert.equal(meta(run.runDir).run_status, 'complete')
  assert.equal(next(run.runDir), 'NEXT: report run=helper')
  ok(run.runDir)
})
await test('an incomplete run writes what is decided, lists the unresolved candidate, and stays incomplete: an unvalidated candidate is never in findings.json', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }, { name: 'c', candidates: ['fp-c'] }], { args: ['--budget', '40'] })
  recordSpend(run.runDir, 'earlier', 38)   // two agents left: fp-c is not funded
  const res = await round(run.runDir, (l, c) => verified(c.fingerprint))
  assert.equal(res.apply.status, 0, res.apply.stdout)
  const r = cli('write', run.runDir)
  assert.equal(r.status, 0, r.stdout)
  assert.deepEqual(found(run.runDir).map(x => x.fingerprint), ['fp-a', 'fp-b'], 'fp-c was never validated: it is not a record under any verdict')
  assert.match(r.stdout, /^AUDIT: OK write records=2/m)
  assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['incomplete', 'validation_budget_exhausted'])
  const link = cli('link-check', run.runDir)
  assert.equal(link.status, 0, link.stdout)
  assert.match(link.stdout, /^note: unresolved fp-c \(validation_budget_exhausted\) units=/m)
  assert.match(link.last, /^AUDIT: OK link-check records=2 unresolved=1$/)
  ok(run.runDir)
})
await test('write runs only as the next step, and refuses what is not over: no decisions for a pool, a pending candidate, a stage not finished', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  assert.match(cli('write', run.runDir).last, /^AUDIT: FAIL write-findings is not the next step of this run: NEXT: validate run=workflow/)
  advanceState(run.runDir, 'validate')
  assert.match(cli('write', run.runDir).last, /^AUDIT: FAIL 2 candidate\(s\) in candidates\.json were never validated \(decisions\.json is missing\)/)
  ensureDecisions(run.runDir, readPool(run.runDir))
  assert.match(cli('write', run.runDir).last, /^AUDIT: FAIL 2 candidate\(s\) are still pending a verifier: validate is not over/)
  assert.ok(!existsSync(join(run.runDir, 'findings.json')))
})
await test('an applied write is not applied twice: next has moved on', async () => {
  const run = await validated()
  assert.equal(cli('write', run.runDir).status, 0)
  assert.match(cli('write', run.runDir).last, /^AUDIT: FAIL write-findings is not the next step of this run: NEXT: verify run=workflow/)
})

console.log('== write: a failure leaves the previous file intact, and the run says why')
await test('records the validators would refuse make write fail with the validator\'s errors, mark the run incomplete with findings_validation_failed, write no findings.json, and send next to the report', async () => {
  const run = await validated()
  const d = decisions(run.runDir)
  // a decision no stage would have saved: a severity on a needs_validation record
  saveDecisions(run.runDir, { ...d, entries: d.entries.map(e => (e.fingerprint === 'fp-a' ? { ...e, record: { ...e.record, severity: { overall_severity: 'high' } } } : e)) })
  const r = cli('write', run.runDir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^findings: .*needs_validation finding must not contain "severity"/m)
  assert.match(r.last, /^AUDIT: FAIL the findings would not pass upstream's validator \(\d+ error\(s\)\); findings\.json is unchanged; the run is marked incomplete \(findings_validation_failed\) and `next` goes to the report$/)
  assert.ok(!existsSync(join(run.runDir, 'findings.json')) && !existsSync(join(run.runDir, 'findings.json.candidate')))
  assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['incomplete', 'findings_validation_failed'])
  assert.equal(next(run.runDir), 'NEXT: report run=helper reason=findings_validation_failed')
  assert.equal(audit(['check', run.runDir]).last, `AUDIT: OK ${run.runDir} passes check`)
  assert.deepEqual(events(run.runDir).filter(e => e.cmd === 'write-findings').map(e => [e.result, e.reason]), [['failed', 'findings_validation_failed']])
})
await test('a failed first write in a run that was already incomplete for another reason still sends next to the report: the first reason stands, and the failure is recorded in the step state', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }, { name: 'c', candidates: ['fp-c'] }], { args: ['--budget', '40'] })
  recordSpend(run.runDir, 'earlier', 38)   // two agents left: one candidate is validated and fp-c is not funded, so the run is incomplete before write
  assert.equal((await round(run.runDir, (l, c) => verified(c.fingerprint))).apply.status, 0)
  assert.equal(meta(run.runDir).incomplete_reason, 'validation_budget_exhausted')
  const d = decisions(run.runDir)
  saveDecisions(run.runDir, { ...d, entries: d.entries.map(e => (e.state === 'decided' ? { ...e, record: { ...e.record, severity: { overall_severity: 'high' } } } : e)) })
  const r = cli('write', run.runDir)
  assert.equal(r.status, 1)
  assert.match(r.last, /`next` goes to the report/)
  assert.equal(meta(run.runDir).incomplete_reason, 'validation_budget_exhausted', 'the first reason stands')
  assert.ok(!existsSync(join(run.runDir, 'findings.json')))
  assert.equal(next(run.runDir), 'NEXT: report run=helper reason=validation_budget_exhausted', 'not NEXT: FAIL, which no command could finish')
  assert.equal(audit(['check', run.runDir]).last, `AUDIT: OK ${run.runDir} passes check`)
  assert.equal(readJsonFile(run.runDir, 'stage-state.json').write_failed, true)
})
await test('a ledger the vendored validator would refuse fails write the same way: a wrong coverage_id, a covered unit with no checks', async () => {
  for (const [name, tamper] of [['a wrong coverage_id', l => { l[0].coverage_id = `${l[0].coverage_id}x` }], ['a covered unit with no checks', l => { const u = l.find(x => x.status === 'covered' || x.status === 'candidate'); u.local_checks = []; u.reviewed_paths = [] }], ['an unsorted ledger', l => l.reverse()]]) {
    const run = await validated()
    const ledger = readLedger(run.runDir)
    tamper(ledger)
    writeFileSync(join(run.runDir, 'coverage-ledger.json'), JSON.stringify(ledger))
    const r = cli('write', run.runDir)
    assert.equal(r.status, 1, name)
    assert.match(r.last, /^AUDIT: FAIL upstream's validate-coverage-ledger\.cjs said "FAIL: \d+ validation error\(s\)" \(exit 1\); findings\.json is unchanged; the run is marked incomplete \(findings_validation_failed\)/, name)
    assert.ok(!existsSync(join(run.runDir, 'findings.json')), name)
    assert.equal(meta(run.runDir).run_status, 'incomplete', name)
  }
})
await test('commitFindings leaves the previous findings.json byte for byte when a later write fails: a forbidden field, a severity above impact, an unsorted or duplicate set, a missing snapshot file', async () => {
  const run = await validated()
  assert.equal(cli('write', run.runDir).status, 0)
  const before = readFileSync(join(run.runDir, 'findings.json'))
  const evidenceBefore = readFileSync(join(run.runDir, 'evidence-links.json'))
  const nv = needsValidationRecord('fp-a')
  const cases = [
    ['a forbidden field (a reason on a needs_validation record)', [{ ...nv, reason: 'x' }]],
    ['a severity above impact', [{ ...confirmedRecord('fp-a'), severity: { likelihood: { score: 'high', reason: 'r' }, impact: { score: 'low', reason: 'r' }, overall_severity: 'critical' } }]],
    ['a duplicate fingerprint', [nv, { ...nv, title: 'again' }]],
    ['a record that is not an object', [null]],
    ['a trace file that is not in the snapshot', [{ ...nv, trace: [{ kind: 'sink', file: 'src/ghost.js', line: 1, scope: 'a', description: 'x' }] }]],
    ['a line past the end of the file', [{ ...nv, evidence: [{ file: 'src/app.js', line: 50, description: 'x' }] }]],
    ['a confirmed record with nothing local behind it', [confirmedRecord('fp-a')]],
  ]
  for (const [name, records] of cases) {
    assert.throws(() => commitFindings(run.runDir, records), e => Array.isArray(e.problems) || /unchanged/.test(e.message), name)
    assert.deepEqual(readFileSync(join(run.runDir, 'findings.json')), before, `${name}: findings.json is as it was`)
    assert.deepEqual(readFileSync(join(run.runDir, 'evidence-links.json')), evidenceBefore, name)
    assert.ok(!existsSync(join(run.runDir, 'findings.json.candidate')), `${name}: no candidate file is left`)
  }
  assert.throws(() => commitFindings(run.runDir, 'not an array'), /findings are an array of records; findings\.json is unchanged/)
  assert.throws(() => commitFindings(run.runDir, undefined), /findings are an array/)
})
await test('commitFindings sorts by fingerprint in code-unit order and a second write of the same records changes nothing', async () => {
  const run = await validated([{ name: 'a', candidates: ['fp-b'] }, { name: 'b', candidates: ['fp-B'] }, { name: 'c', candidates: ['fp-a'] }], undefined, (l, c) => verified(c.fingerprint))
  const records = finalRecords(decisions(run.runDir)).reverse()
  commitFindings(run.runDir, records)
  assert.deepEqual(found(run.runDir).map(r => r.fingerprint), ['fp-B', 'fp-a', 'fp-b'], 'upper case before lower case: the vendored validator\'s order, never localeCompare')
  const once = readFileSync(join(run.runDir, 'findings.json'))
  commitFindings(run.runDir, records)
  assert.deepEqual(readFileSync(join(run.runDir, 'findings.json')), once)
  ok(run.runDir)
})

console.log('== link-check: what the two validators cannot see')
const LEDGER = () => [{ coverage_id: 'u1', status: 'candidate', result_fingerprints: ['fp-1'], attempts: [], local_checks: [{ agent_id: 'h1-01', method: 'source', artifact: null }], merged_fingerprints: [] }]
const NV = (fp, over = {}) => ({ ...needsValidationRecord(fp), ...over })
const LC = async (over = {}) => {
  const run = await validated([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  return { run, check: (records, extra = {}) => linkCheck({ runDir: run.runDir, records, ledger: readLedger(run.runDir), decisions: decisionsOf(run.runDir), pool: readPool(run.runDir), meta: loadRun(run.runDir).meta, ...over, ...extra }) }
}
await test('a clean run has no problem; a record linked from no unit is a problem', async () => {
  const { run, check } = await LC()
  const recs = finalRecords(decisionsOf(run.runDir))
  assert.deepEqual(check(recs), { problems: [], unresolved: [] })
  const orphan = check([...recs, NV('fp-orphan')])
  assert.deepEqual(orphan.problems, ['record "fp-orphan" is linked from no coverage unit'])
})
await test('a candidate with no record is a problem unless it is listed unresolved by the decisions and the run is incomplete; one never settled is always a problem', async () => {
  const { run, check } = await LC()
  const recs = finalRecords(decisionsOf(run.runDir))
  const only = recs.filter(r => r.fingerprint === 'fp-a')
  assert.deepEqual(check(only).problems, ['candidate "fp-b" has no record in findings.json and is not listed as unresolved: nothing may be dropped silently'], 'decided, and then missing from the file: dropped silently')
  const d = decisionsOf(run.runDir)
  const unvalidated = { ...d, entries: d.entries.map(e => (e.fingerprint === 'fp-b' ? { ...e, state: 'unvalidated', unresolved: 'validation_budget_exhausted', record: null, decision: null, verifier_id: null } : e)) }
  const inProgress = check(only, { decisions: unvalidated })
  assert.deepEqual(inProgress.problems, ['candidate "fp-b" is unresolved (validation_budget_exhausted) but the run is not marked incomplete'])
  assert.deepEqual(inProgress.unresolved.map(u => [u.fingerprint, u.reason, u.units.length]), [['fp-b', 'validation_budget_exhausted', 1]])
  const incomplete = check(only, { decisions: unvalidated, meta: { ...loadRun(run.runDir).meta, run_status: 'incomplete' } })
  assert.deepEqual(incomplete.problems, [])
  assert.deepEqual(incomplete.unresolved.map(u => u.fingerprint), ['fp-b'])
  const never = check(only, { decisions: { ...d, entries: d.entries.map(e => (e.fingerprint === 'fp-b' ? { ...e, state: 'pending' } : e)) }, meta: { ...loadRun(run.runDir).meta, run_status: 'incomplete' } })
  assert.match(never.problems[0], /^candidate "fp-b" has no record in findings\.json and is not listed as unresolved/)
  const noDecisions = check(only, { decisions: null, meta: { ...loadRun(run.runDir).meta, run_status: 'incomplete' } })
  assert.match(noDecisions.problems[0], /not listed as unresolved/)
})
await test('a record Phase 5 removed is listed unresolved with its reason; a record with nothing removed is not', async () => {
  const { run, check } = await LC()
  const recs = finalRecords(decisionsOf(run.runDir))
  const d = decisionsOf(run.runDir)
  const removed = { ...d, entries: d.entries.map(e => (e.fingerprint === 'fp-a' ? { ...e, phase5: { state: 'removed', reason: 'record_verification_unresolved' } } : e)) }
  const out = check(recs.filter(r => r.fingerprint !== 'fp-a'), { decisions: removed, meta: { ...loadRun(run.runDir).meta, run_status: 'incomplete' } })
  assert.deepEqual([out.problems, out.unresolved.map(u => [u.fingerprint, u.reason])], [[], [['fp-a', 'record_verification_unresolved']]])
})
await test('an alias from a consolidation resolves a merged fingerprint an archived attempt still names, and links the kept record from the unit that held the old one', () => {
  const ledger = [{ ...LEDGER()[0], result_fingerprints: [], status: 'covered', attempts: [{ result_fingerprints: ['fp-old'] }], merged_fingerprints: [{ fingerprint: 'fp-old', into: 'fp-new', reason: 'same cause' }] }]
  const rec = { ...NV('fp-new') }
  const out = linkCheck({ runDir: '/nonexistent', records: [rec], ledger, decisions: null, pool: [], meta: { run_status: 'in_progress' } })
  assert.ok(!out.problems.some(p => /fp-old|linked from no/.test(p)), out.problems.join(' | '))
  assert.deepEqual(out.unresolved, [])
  const bare = linkCheck({ runDir: '/nonexistent', records: [rec], ledger: [{ ...ledger[0], merged_fingerprints: [] }], decisions: null, pool: [], meta: { run_status: 'in_progress' } })
  assert.ok(bare.problems.includes('record "fp-new" is linked from no coverage unit'), 'without the alias the kept record is linked from nowhere')
  assert.ok(bare.problems.some(p => /candidate "fp-old" has no record/.test(p)), 'and the old fingerprint looks like a candidate with no record')
})
await test('a confirmed record needs a unit check with method local whose artifact is a regular file that exists: none, a missing file, a directory, a symlink and a real file', () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-1'] }])
  const dir = run.runDir
  const unit = (checks) => [{ ...LEDGER()[0], local_checks: checks }]
  const conf = confirmedRecord('fp-1')
  const link = ledger => linkCheck({ runDir: dir, records: [conf], ledger, decisions: null, pool: [], meta: { run_status: 'in_progress' } }).problems.filter(p => /confirmed record/.test(p))
  const check = artifact => ({ agent_id: 'v01', method: 'local', artifact })
  assert.equal(link(unit([{ agent_id: 'h1-01', method: 'source', artifact: null }])).length, 1, 'only source checks')
  mkdirSync(join(dir, 'agents', 'v01', 'artifacts'), { recursive: true })
  assert.equal(link(unit([check('agents/v01/artifacts/missing.txt')])).length, 1, 'a file that does not exist')
  mkdirSync(join(dir, 'agents', 'v01', 'artifacts', 'adir'))
  assert.equal(link(unit([check('agents/v01/artifacts/adir')])).length, 1, 'a directory')
  writeFileSync(join(dir, 'outside.txt'), 'x')
  symlinkSync(join(dir, 'outside.txt'), join(dir, 'agents', 'v01', 'artifacts', 'sym.txt'))
  assert.equal(link(unit([check('agents/v01/artifacts/sym.txt')])).length, 1, 'a symlink is not a regular file')
  writeFileSync(join(dir, 'agents', 'v01', 'artifacts', 'real.txt'), 'observed')
  assert.equal(link(unit([check('agents/v01/artifacts/real.txt')])).length, 0, 'a regular file that exists (what PR 10 would promote)')
  assert.equal(link(unit([check(null), check(7), check({})])).length, 1, 'an artifact that is not a path')
})
await test('every trace and evidence file must be in the snapshot and every line within it, in every record, and a malformed trace entry is a problem, not an exception', async () => {
  const { run, check } = await LC()
  const recs = finalRecords(decisionsOf(run.runDir))
  const bad = (over) => check([{ ...recs[0], ...over }]).problems.filter(p => /^record "fp-a": /.test(p))
  assert.equal(bad({}).length, 0)
  assert.match(bad({ trace: [{ kind: 'sink', file: 'src/ghost.js', line: 1, scope: 'a', description: 'x' }] })[0], /"src\/ghost\.js" is not in tree\//)
  assert.match(bad({ evidence: [{ file: 'src/app.js', line: 2, description: 'x' }] })[0], /has 1 line\(s\)/)
  assert.match(bad({ trace: [{ kind: 'sink', file: 'src', line: 1 }] })[0], /is a directory, not a file/)
  assert.match(bad({ trace: [{ kind: 'sink', file: '../x', line: 1 }] })[0], /not a safe repository-relative path/)
  assert.ok(bad({ trace: [null, 7, 'x', { file: 5, line: 'a' }] }).length >= 3)
  assert.ok(bad({ trace: 'none', evidence: null }).length === 0, 'a record whose lists are not lists has no entries to check (the validator refuses it)')
})
await test('link-check on the command line: OK with the counts, FAIL with one findings: line per problem; a missing findings.json is refused by name', async () => {
  const run = await validated()
  assert.match(cli('link-check', run.runDir).last, /^AUDIT: FAIL findings\.json is missing/)
  assert.equal(cli('write', run.runDir).status, 0)
  assert.match(cli('link-check', run.runDir).last, /^AUDIT: OK link-check records=3 unresolved=0$/)
  const records = found(run.runDir)
  writeFileSync(join(run.runDir, 'findings.json'), JSON.stringify([...records, NV('fp-zzz')]))
  const bad = cli('link-check', run.runDir)
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /^findings: record "fp-zzz" is linked from no coverage unit$/m)
  assert.match(bad.last, /^AUDIT: FAIL .* has 1 link problem\(s\)$/)
})

console.log('== complete-check: the prose-only rule, closed')
await test('a run whose every candidate is decided and every retained record passed Phase 5 is marked complete, and complete-check is harmless again', async () => {
  const run = await validated()
  assert.equal(cli('write', run.runDir).status, 0)
  assert.equal(meta(run.runDir).run_status, 'in_progress')
  markVerified(run.runDir)
  const r = cli('complete-check', run.runDir)
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.last, /^AUDIT: OK complete-check every candidate has an independent final disposition and every retained record passed Phase 5: the run is complete$/)
  assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['complete', null])
  assert.equal(audit(['check', run.runDir]).last, `AUDIT: OK ${run.runDir} passes check`)
  assert.equal(cli('complete-check', run.runDir).status, 0)
  assert.equal(finishRun(run.runDir).status, 'complete')
})
await test('a retained record no Phase 5 verifier passed fails complete-check: the run in progress is marked incomplete with complete_check_failed, and never complete', async () => {
  const run = await validated()
  assert.equal(cli('write', run.runDir).status, 0)
  advanceState(run.runDir, 'verify')   // verify ended without verifying them (nothing here calls it)
  const r = cli('complete-check', run.runDir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^findings: record "fp-a" did not pass Phase 5$/m)
  assert.match(r.stdout, /^findings: record "fp-c" did not pass Phase 5$/m)
  assert.ok(!/fp-b/.test(r.stdout), 'a rejected record is not read by Phase 5')
  assert.match(r.last, /^AUDIT: FAIL 2 problem\(s\): the run is marked incomplete \(complete_check_failed\)$/)
  assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['incomplete', 'complete_check_failed'])
  assert.match(cli('complete-check', run.runDir).last, /^AUDIT: FAIL the run is incomplete \(complete_check_failed\): it stays so, and the report discloses why$/)
})
await test('an incomplete run stays incomplete whatever complete-check finds, and a complete run is not downgraded when a later check finds a problem', async () => {
  const run = await validated()
  assert.equal(cli('write', run.runDir).status, 0)
  markVerified(run.runDir)
  markIncomplete(run.runDir, 'critic_budget_exhausted')
  assert.match(cli('complete-check', run.runDir).last, /^AUDIT: FAIL the run is incomplete \(critic_budget_exhausted\)/)
  assert.equal(meta(run.runDir).incomplete_reason, 'critic_budget_exhausted', 'the first reason stands')
  const done = await validated()
  assert.equal(cli('write', done.runDir).status, 0)
  markVerified(done.runDir)
  assert.equal(cli('complete-check', done.runDir).status, 0)
  writeFileSync(join(done.runDir, 'agent-history.json'), JSON.stringify(recordAgentBroken(historyOf(done.runDir))))
  const r = cli('complete-check', done.runDir)
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL the run is marked complete and \d+ problem\(s\) were found: it is not downgraded$/)
  assert.equal(meta(done.runDir).run_status, 'complete')
})
await test('every way a run can look complete and not be is a named problem: a missing findings file, a missing ledger, a pending candidate, a findings record that is not the decided one, a verifier reused across roles, a Phase 5 verifier absent from the history', async () => {
  const fresh = async () => { const run = await validated(); assert.equal(cli('write', run.runDir).status, 0); markVerified(run.runDir); return run }
  let run = await fresh()
  rmSync(join(run.runDir, 'findings.json'))
  assert.match(completeProblems(run.runDir).problems[0], /^findings\.json is missing: nothing was written$/)
  run = await fresh()
  rmSync(join(run.runDir, 'coverage-ledger.json'))
  assert.match(completeProblems(run.runDir).problems[0], /^coverage-ledger\.json is missing$/)
  run = await fresh()
  const d = decisions(run.runDir)
  saveDecisions(run.runDir, { ...d, entries: d.entries.map(e => (e.fingerprint === 'fp-a' ? { ...e, state: 'pending' } : e)) })
  assert.ok(completeProblems(run.runDir).problems.some(p => /candidate "fp-a" was never decided \(pending\)/.test(p)))
  run = await fresh()
  writeFileSync(join(run.runDir, 'findings.json'), JSON.stringify(found(run.runDir).map(r => (r.fingerprint === 'fp-a' ? { ...r, title: 'Edited after the verifiers' } : r))))
  assert.ok(completeProblems(run.runDir).problems.some(p => /record "fp-a" in findings\.json is not the decided record/.test(p)))
  run = await fresh()
  writeFileSync(join(run.runDir, 'agent-history.json'), JSON.stringify(recordAgentBroken(historyOf(run.runDir))))
  assert.ok(completeProblems(run.runDir).problems.some(p => /fp-a: agent v01 is both validator and replacer/.test(p)))
  run = await fresh()
  const h = historyOf(run.runDir)
  writeFileSync(join(run.runDir, 'agent-history.json'), JSON.stringify({ ...h, fingerprints: { ...h.fingerprints, 'fp-a': h.fingerprints['fp-a'].filter(e => e.role !== 'verifier') } }))
  assert.ok(completeProblems(run.runDir).problems.some(p => /record "fp-a" did not pass Phase 5/.test(p)))
  run = await fresh()
  const h2 = historyOf(run.runDir)
  writeFileSync(join(run.runDir, 'agent-history.json'), JSON.stringify({ ...h2, fingerprints: { ...h2.fingerprints, 'fp-a': h2.fingerprints['fp-a'].filter(e => e.role !== 'validator') } }))
  assert.ok(completeProblems(run.runDir).problems.some(p => /record "fp-a" was verified by no Phase 3 verifier/.test(p)))
})
await test('a confirmed record can never make a run complete: findings that hold one fail link-check and complete-check', async () => {
  const run = await validated()
  assert.equal(cli('write', run.runDir).status, 0)
  markVerified(run.runDir)
  writeFileSync(join(run.runDir, 'findings.json'), JSON.stringify([...found(run.runDir).filter(r => r.fingerprint !== 'fp-a'), confirmedRecord('fp-a')].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1))))
  const out = completeProblems(run.runDir)
  assert.ok(out.problems.some(p => /confirmed record "fp-a" is backed by no unit check with method "local"/.test(p)), out.problems.join(' | '))
  assert.equal(cli('complete-check', run.runDir).status, 1)
  assert.notEqual(meta(run.runDir).run_status, 'complete')
})

await test('complete-check is refused until the run has reached its end: it cannot be run after init or between write and verify and downgrade a run that has not been verified yet', async () => {
  const fresh = newRun()
  const early = cli('complete-check', fresh.runDir)
  assert.equal(early.status, 1)
  assert.match(early.last, /^AUDIT: FAIL complete-check runs at the end of a run, when `audit-run\.mjs next` says report or done: it is NEXT: seed run=helper now; nothing was changed$/)
  assert.equal(meta(fresh.runDir).run_status, 'in_progress')
  assert.equal(next(fresh.runDir), 'NEXT: seed run=helper', 'the run was not sent to the report')
  const run = await validated()
  assert.equal(cli('write', run.runDir).status, 0)
  assert.equal(next(run.runDir), 'NEXT: verify run=workflow')
  assert.match(cli('complete-check', run.runDir).last, /^AUDIT: FAIL complete-check runs at the end of a run/)
  assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['in_progress', null], 'verify can still make it complete')
  markVerified(run.runDir)
  assert.equal(next(run.runDir), 'NEXT: report run=helper')
  assert.equal(cli('complete-check', run.runDir).status, 0)
  assert.equal(meta(run.runDir).run_status, 'complete')
  assert.equal(cli('complete-check', run.runDir).status, 0, 'and again, once the run is done')
})
console.log('== markComplete and next')
await test('markComplete clears the reason, is idempotent, refuses an incomplete run, and refuses a directory that is not a run', async () => {
  const run = await validated()
  markComplete(run.runDir)
  assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['complete', null])
  markComplete(run.runDir)
  assert.throws(() => markIncomplete(run.runDir, 'x'), /a complete run cannot be marked incomplete/)
  const other = await validated()
  markIncomplete(other.runDir, 'budget_cannot_reserve_critics_and_validation')
  assert.throws(() => markComplete(other.runDir), /an incomplete run \(budget_cannot_reserve_critics_and_validation\) is never marked complete/)
  assert.throws(() => markComplete(join(run.runDir, 'tree')), /not a run directory/)
})
await test('next: a failed first write goes to the report with its reason, and any other missing findings.json is still refused', async () => {
  const run = await validated()
  advanceState(run.runDir, 'write-findings')
  assert.match(next(run.runDir), /^NEXT: FAIL findings\.json is missing or not an array after write-findings$/)
  markIncomplete(run.runDir, 'critic_budget_exhausted')
  assert.match(next(run.runDir), /^NEXT: FAIL findings\.json is missing or not an array after write-findings$/, 'only findings_validation_failed explains a missing file')
  const bad = await validated()
  advanceState(bad.runDir, 'write-findings', { write_failed: true })
  markIncomplete(bad.runDir, 'findings_validation_failed')
  assert.equal(next(bad.runDir), 'NEXT: report run=helper reason=findings_validation_failed')
  writeFileSync(join(bad.runDir, 'findings.json'), '{}')
  assert.match(next(bad.runDir), /^NEXT: FAIL findings\.json is missing or not an array after write-findings$/, 'a file that is not an array is never excused')
  const named = await validated()
  advanceState(named.runDir, 'write-findings')
  markIncomplete(named.runDir, 'findings_validation_failed')
  assert.match(next(named.runDir), /^NEXT: FAIL findings\.json is missing/, 'the reason alone does not excuse a missing file: the failed write says so in the step state')
})

console.log('== the command line')
await test('usage errors are exit 2 on stderr: an unknown command, a missing run directory, extra arguments; a directory that is not a run is a FAIL', () => {
  for (const args of [[], ['frobnicate', '/tmp'], ['write'], ['write', '/tmp/x', 'extra'], ['complete-check']]) {
    const r = spawnSync(process.execPath, [AUDIT_FINDINGS, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV } })
    assert.equal(r.status, 2, JSON.stringify(args))
    assert.match(r.stderr, /^usage: audit-findings\.mjs write <run dir>/)
  }
  const r = cli('write', '/tmp/definitely-not-a-run-dir')
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL .* is not a run directory/)
})
await test('evidenceLinks names, for each record, the units that carry it and every check on them, and nothing for a record no unit carries', async () => {
  const run = await validated()
  const recs = finalRecords(decisionsOf(run.runDir))
  const links = evidenceLinks([...recs, NV('fp-none')], readLedger(run.runDir))
  assert.deepEqual(links.map(l => [l.fingerprint, l.units.length]), [['fp-a', 1], ['fp-b', 1], ['fp-c', 1], ['fp-none', 0]])
  assert.deepEqual(links[0].units[0].checks.map(c => c.agent_id), [unitByName(run.runDir).a.agent_id, 'v01'])
})
