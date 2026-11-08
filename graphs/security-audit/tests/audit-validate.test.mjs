// audit-validate.test.mjs - the validate stage (Phase 3, audit-verdicts.mjs wired in audit-stage.mjs): what a verifier is sent and what it is not, the independence history,
// every result judged by the real vendored validator and the snapshot, a bad result discarded and retried once, the budget, batches, carried prior records, the ledger the
// decisions write, the crash window. The workflow side is in security-audit-verdicts.test.mjs.
import { join } from 'node:path'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { commitLedger } from '../skills/security-audit/audit-ledger.mjs'
import { encodedSize } from '../skills/security-audit/audit-inputs.mjs'
import { MAX_VALIDATE_BYTES, bounded, judgeValidator, validateInput } from '../skills/security-audit/audit-verdicts.mjs'
import { agentId, writeFindings } from '../skills/security-audit/audit-findings.mjs'
import { MAX_SCRIPT_BYTES } from '../skills/security-audit/audit-stage.mjs'
import { loadRun, recordSpend } from '../skills/security-audit/audit-run.mjs'
import { canonicalCoverageId } from '../skills/security-audit/upstream.mjs'
import { companions, parts, resolve as block } from '../skills/security-audit/blocks.mjs'
import { audit, meta } from './audit-fixtures.mjs'
import { confirmedRecord, ledgerBytes, ledgerValid, needsValidationRecord, priorRun, priorUnit, readJsonFile, readLedger, refsOf, rejectedRecord } from './ledger-fixtures.mjs'
import { fuzzApply, returnedFile, runScript, snapshot, stage, stageDirOf, stageDirs } from './stage-fixtures.mjs'
import { decisions, good, history, next, pool, rejected, round, toValidate, unitByName, verified } from './verdict-fixtures.mjs'

const AI = companions().find(c => c.file === 'AI-AND-LLM.md')
const ok = runDir => { assert.ok(ledgerValid(runDir), 'upstream\'s validator passes the ledger'); assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`) }
const TWO_DEFS = () => [{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }]
const entry = (runDir, fp) => decisions(runDir).entries.find(e => e.fingerprint === fp)

console.log('== what a verifier is sent')
await test('each candidate is one input entry: its record, its linked checks without the hunter\'s ID, the validation blocks of the companions its units selected, and no hunter, wave or hardening note', () => {
  const companion = [AI.core, AI.classes[0], AI.universal, AI.validation]
  const run = toValidate([{ name: 'a', candidates: [['fp-a', { title: 'Title A' }]], unit: { selected_companion_blocks: companion }, checkResult: 'A-CHECK-PROSE', hardening: ['HARDENING-NOTE'] }, { name: 'b', candidates: ['fp-b'] }, { name: 'c', candidates: [] }])
  const input = validateInput(run.runDir, loadRun(run.runDir))
  assert.deepEqual([input.stage, input.part, input.round, input.tree], ['validate', 'validate', 1, join(run.runDir, 'tree')])
  assert.deepEqual(input.candidates.map(c => [c.agent_id, c.fingerprint, c.proposed_verdict]), [['v01', 'fp-a', 'needs_validation'], ['v02', 'fp-b', 'needs_validation']])
  const [a, b] = input.candidates
  assert.deepEqual(Object.keys(a).sort(), ['agent_id', 'blocks', 'checks', 'fingerprint', 'priors', 'proposed_verdict', 'record'])
  assert.equal(a.record.title, 'Title A')
  assert.ok(!('proposed_verdict' in a.record) && !('verdict' in a.record), 'the record is what merge-wave kept: the hunter\'s fields, no verdict yet')
  assert.deepEqual(a.checks.map(c => [c.reviewed_paths, c.method, c.artifact, c.result]), [[['src/app.js'], 'source', null, 'A-CHECK-PROSE']])
  assert.ok(a.checks.every(c => !('agent_id' in c)), 'the hunter\'s ID is not in what the verifier reads')
  assert.deepEqual([a.blocks, b.blocks], [[AI.validation], []])
  assert.deepEqual(Object.keys(input.blocks), [AI.validation])
  assert.equal(input.blocks[AI.validation], block(AI.validation).text)
  assert.ok(!JSON.stringify(input).includes('HARDENING-NOTE') && !JSON.stringify(input).includes(run.owners.a) && !JSON.stringify(input).includes(run.owners.b), 'no hardening note, no hunter ID')
  for (const k of ['verifierPrompt', 'verifierPromotion', 'localBoundaries', 'recordContract', 'schema_confirmed', 'schema_needs_validation', 'schema_rejected']) assert.equal(typeof input.parts[k], 'string', k)
  assert.equal(input.parts.recordContract, parts().recordContract.text)
  assert.deepEqual(validateInput(run.runDir, loadRun(run.runDir)), input, 'the same state gives the same input and IDs')
})
await test('planning numbers the candidates for life and records, for each, its hunters and its verifier in the independence history', () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  validateInput(run.runDir, loadRun(run.runDir))
  assert.deepEqual(decisions(run.runDir).entries.map(e => [e.fingerprint, e.n, e.state, e.attempts]), [['fp-a', 1, 'pending', []], ['fp-b', 2, 'pending', []]])
  assert.deepEqual(history(run.runDir).fingerprints, { 'fp-a': [{ role: 'hunter', id: run.owners.a }, { role: 'validator', id: 'v01' }], 'fp-b': [{ role: 'hunter', id: run.owners.b }, { role: 'validator', id: 'v02' }] })
})
await test('a hunter\'s own ID cannot be its candidate\'s verifier: a pool that names the verifier\'s ID as a hunter is refused at the plan, with no stage written', () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  writeFileSync(join(run.runDir, 'candidates.json'), JSON.stringify(pool(run.runDir).map(c => (c.fingerprint === 'fp-a' ? { ...c, hunter_ids: [...c.hunter_ids, 'v01'] } : c))))
  const r = stage(['plan', run.runDir])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL agent v01 already served as hunter of fp-a: it cannot also be its validator/)
  assert.deepEqual(stageDirs(run.runDir), [])
  for (const bad of ['con', '../x', 'A', 'x'.repeat(65)]) {
    writeFileSync(join(run.runDir, 'candidates.json'), JSON.stringify(pool(run.runDir).map(c => (c.fingerprint === 'fp-a' ? { ...c, hunter_ids: [bad] } : c))))
    assert.match(stage(['plan', run.runDir]).last, /^AUDIT: FAIL ".*" is not a safe agent ID/, bad)
  }
})
await test('a sentinel in a hunter\'s hardening notes, uncovered gaps, another candidate, or a unit that does not carry the candidate never reaches the verifier prompt; the candidate\'s own fields, which the method sends, do', async () => {
  const run = toValidate([
    { name: 'a', candidates: [['fp-a', { title: 'OWN-TITLE-A' }]], checkResult: 'OWN-CHECK-A', hardening: ['SENTINEL-HARDENING'], uncovered: [{ surface: 'SENTINEL-UNCOVERED', boundary: 'b', subsystem: 's', attack_class: 'a', starting_paths: ['src/db.js'], reason: 'SENTINEL-UNCOVERED-REASON' }] },
    { name: 'b', candidates: [['fp-b', { title: 'OWN-TITLE-B', description: 'OWN-DESC-B' }]], checkResult: 'OWN-CHECK-B' },
    { name: 'c', candidates: [], checkResult: 'SENTINEL-UNLINKED-UNIT-CHECK', hardening: ['SENTINEL-HARDENING-C'] },
  ])
  const res = await round(run.runDir, (label, c) => good(c))
  assert.equal(res.apply.status, 0, res.apply.stdout)
  assert.ok(res.prompts.v01.includes('OWN-TITLE-A') && res.prompts.v01.includes('OWN-CHECK-A'), 'the positive control: what the method sends is there')
  assert.ok(res.prompts.v02.includes('OWN-TITLE-B') && res.prompts.v02.includes('OWN-CHECK-B'))
  for (const [label, prompt] of Object.entries(res.prompts)) {
    assert.ok(!/SENTINEL-/.test(prompt), `${label}: no hardening note, no uncovered gap, nothing of a unit that does not carry the candidate`)
    assert.ok(!prompt.includes(run.owners.a) && !prompt.includes(run.owners.b) && !prompt.includes(run.owners.c), `${label}: no hunter ID`)
  }
  assert.ok(!res.prompts.v01.includes('OWN-TITLE-B') && !res.prompts.v01.includes('OWN-CHECK-B') && !res.prompts.v02.includes('OWN-TITLE-A') && !res.prompts.v02.includes('OWN-CHECK-A'), 'a verifier never sees another candidate or another candidate\'s unit')
})
await test('a verifier never sees another verifier\'s result: the second candidate\'s verifier is planned and run before the first is applied, so the prompts hold nothing of any decision', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const res = await round(run.runDir, (label, c) => verified(c.fingerprint, { title: `DECIDED-TITLE-${c.fingerprint}`, blockers: [`DECIDED-BLOCKER-${c.fingerprint}`] }))
  for (const [label, prompt] of Object.entries(res.prompts)) assert.ok(!/DECIDED-/.test(prompt), label)
  assert.equal(entry(run.runDir, 'fp-a').record.title, 'DECIDED-TITLE-fp-a')
})
await test('one candidate\'s input is bounded whatever a hunter wrote: at most 10 checks of 10 paths and 600 characters, at most 2 prior records, so the first of a batch always fits one script', () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const ledger = readLedger(run.runDir)
  const a = ledger.find(u => u.result_fingerprints.includes('fp-a'))
  a.local_checks = Array.from({ length: 30 }, (_, i) => ({ agent_id: a.agent_id, reviewed_paths: ['src/app.js'], invariant: `i${i} ${'i'.repeat(3000)}`, method: 'source', result: `r${i} ${'r'.repeat(3000)}`, artifact: null }))
  commitLedger(run.runDir, ledger)
  const input = validateInput(run.runDir, loadRun(run.runDir))
  const [c] = input.candidates
  assert.equal(c.checks.length, 10)
  assert.ok(c.checks.every(k => k.invariant.length <= 601 && k.result.length <= 601))
  assert.ok(encodedSize(c) < 150_000, `${encodedSize(c)} bytes`)
})
await test('a record in a prompt is bounded: one over 64 KiB is cut and says so, one under is sent whole; a prior record of the same fingerprint reaches the verifier', () => {
  assert.deepEqual(bounded({ a: 'x'.repeat(100) }, 1000), { a: 'x'.repeat(100) })
  const cut = bounded({ a: 'x'.repeat(5000), b: Array.from({ length: 40 }, (_, i) => i) }, 1000)
  assert.equal(cut.truncated, true)
  assert.ok(cut.a.length <= 301 && cut.b.length === 20)
  const before = repo => priorRun(repo, [priorUnit('p', 'candidate', { result_fingerprints: ['fp-a'] })], [{ ...rejectedRecord('fp-a'), title: 'EARLIER-RUN-TITLE' }])
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }], { before })
  const input = validateInput(run.runDir, loadRun(run.runDir))
  assert.deepEqual(input.candidates[0].priors.map(p => [p.run_id, p.record.title, p.record.verdict]), [['run-1', 'EARLIER-RUN-TITLE', 'rejected']])
  assert.deepEqual(input.candidates[1].priors, [])
})

console.log('== the verifier\'s result is judged, never repaired')
await test('a valid result is kept: the verifier\'s corrected record replaces the hunter\'s wording, a rejected decision is kept too, the ledger passes, and next says write-findings', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }, { name: 'c', candidates: ['fp-c'] }])
  const res = await round(run.runDir, (label, c) => (c.fingerprint === 'fp-b' ? rejected('fp-b') : verified(c.fingerprint, { title: `Corrected ${c.fingerprint}` })))
  assert.equal(res.apply.status, 0, res.apply.stdout)
  assert.match(res.apply.last, /^AUDIT: OK apply validate round=1 candidates=3 decided=3 retried=0 unvalidated=0 pending=0 agents=3$/)
  assert.match(res.apply.stdout, new RegExp(`^then: node audit-findings\\.mjs write ${run.runDir}$`, 'm'))
  assert.equal(next(run.runDir), 'NEXT: write-findings run=helper')
  const d = decisions(run.runDir)
  assert.deepEqual(d.entries.map(e => [e.fingerprint, e.state, e.decision, e.verifier_id, e.attempts.length]), [['fp-a', 'decided', 'needs_validation', 'v01', 0], ['fp-b', 'decided', 'rejected', 'v02', 0], ['fp-c', 'decided', 'needs_validation', 'v03', 0]])
  assert.equal(d.entries[0].record.title, 'Corrected fp-a')
  assert.equal(d.entries[0].record.verdict, 'needs_validation')
  assert.equal(d.rounds.validate, 1)
  assert.equal(meta(run.runDir).agents_spent, 3)
  assert.deepEqual(stageDirs(run.runDir), ['01-validate-r1'])
  ok(run.runDir)
})
await test('the ledger carries each decision: the verifier\'s check is added beside the hunter\'s on the unit that holds the candidate, the unit keeps its owner, its reviewed_paths are the union, and a rejected decision is recorded too', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const before = unitByName(run.runDir)
  const res = await round(run.runDir, (label, c) => (c.fingerprint === 'fp-b' ? rejected('fp-b') : verified(c.fingerprint, { trace: [{ kind: 'entrypoint', file: 'src/db.js', line: 1, scope: 'q', description: 'in' }, { kind: 'sink', file: 'src/app.js', line: 1, scope: 'a', description: 'out' }] })))
  assert.equal(res.apply.status, 0, res.apply.stdout)
  const after = unitByName(run.runDir)
  const a = after.a
  assert.deepEqual([a.status, a.agent_id, a.result_fingerprints], ['candidate', run.owners.a, ['fp-a']], 'the unit keeps its assignment owner')
  assert.deepEqual(a.local_checks.map(c => [c.agent_id, c.method, c.artifact]), [[run.owners.a, 'source', null], ['v01', 'source', null]])
  assert.deepEqual(a.local_checks[1].reviewed_paths, ['src/app.js', 'src/db.js'], 'the files of the record\'s trace and evidence')
  assert.deepEqual(a.reviewed_paths, ['src/app.js', 'src/db.js'], 'the union across checks')
  assert.match(a.local_checks[1].invariant, /^independent Phase 3 verification of fp-a: /)
  assert.match(a.local_checks[1].result, /^decision needs_validation; the claimed root cause stands as a lead: /)
  const b = after.b
  assert.deepEqual(b.local_checks.map(c => c.agent_id), [run.owners.b, 'v02'])
  assert.match(b.local_checks[1].result, /^decision rejected; the claim was refuted: Every route passes the wrapper first\./)
  assert.deepEqual([a.attempts, a.wave, a.prior_status], [before.a.attempts, before.a.wave, before.a.prior_status])
  ok(run.runDir)
})
// What each bad result is, and what the parent says: { name, make(candidate) -> result, kind }. A good record is `needsValidationRecord`; each case breaks exactly one thing.
const nvRec = (fp, over = {}) => ({ ...needsValidationRecord(fp), ...over })
const BAD = [
  ['no result at all', () => null, 'no_result', /returned no result/],
  ['a result wrapped in prose', () => 'Here is the JSON you asked for: {"decision": "needs_validation"}', 'no_result', /returned no result/],
  ['a number', () => 7, 'no_result', /returned no result/],
  ['an extra top-level key', c => ({ ...good(c), notes: 'I also checked X' }), 'malformed', /exactly one object with decision and record, and nothing else/],
  ['no record', () => ({ decision: 'needs_validation' }), 'malformed', /exactly one object with decision and record/],
  ['an unknown decision', c => ({ ...good(c), decision: 'maybe' }), 'malformed', /decision is "maybe"/],
  ['a record that is a string', () => ({ decision: 'needs_validation', record: 'the record' }), 'malformed', /the record is not an object/],
  ['a record that is an array', c => ({ decision: 'needs_validation', record: [nvRec(c.fingerprint)] }), 'malformed', /the record is not an object/],
  ['a severity on a needs_validation record', c => ({ decision: 'needs_validation', record: nvRec(c.fingerprint, { severity: { overall_severity: 'high' } }) }), 'malformed', /needs_validation finding must not contain "severity"/],
  ['an unknown field', c => ({ decision: 'needs_validation', record: nvRec(c.fingerprint, { surprise: 1 }) }), 'malformed', /unexpected field "surprise"/],
  ['no blockers', c => ({ decision: 'needs_validation', record: nvRec(c.fingerprint, { blockers: [] }) }), 'malformed', /blockers/],
  ['a verdict that is not the decision', c => ({ decision: 'rejected', record: nvRec(c.fingerprint) }), 'malformed', /the record's verdict is "needs_validation", not "rejected"/],
  ['a trace file that is not in the snapshot', c => ({ decision: 'needs_validation', record: nvRec(c.fingerprint, { trace: [{ kind: 'sink', file: 'src/ghost.js', line: 1, scope: 'a', description: 'x' }] }) }), 'malformed', /"src\/ghost.js" is not in tree\//],
  ['a line past the end of the file', c => ({ decision: 'needs_validation', record: nvRec(c.fingerprint, { evidence: [{ file: 'src/app.js', line: 99, description: 'x' }] }) }), 'malformed', /has 1 line\(s\); "src\/app.js:99" reaches line 99/],
  ['a different fingerprint', c => ({ decision: 'needs_validation', record: nvRec('fp-other-root-cause') }), 'other_fingerprint', /a different root cause is not applied here/],
  ['a fingerprint with a line number added', c => ({ decision: 'needs_validation', record: nvRec(`${c.fingerprint}:12`) }), 'other_fingerprint', /not "fp-a"/],
  ['a confirmed decision', c => ({ decision: 'confirmed', record: confirmedRecord(c.fingerprint) }), 'confirmed', /needs_validation to confirmed is not possible here/],
  ['a confirmed decision with a needs_validation record', c => ({ decision: 'confirmed', record: nvRec(c.fingerprint) }), 'confirmed', /needs_validation to confirmed is not possible here/],
]
await test('every kind of bad result is discarded without repair, the candidate is retried once with a fresh ID, and after a second failure it stays unvalidated with the run incomplete', async () => {
  for (const [name, make, kind, re] of BAD) {
    const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
    const r1 = await round(run.runDir, (label, c) => (c.fingerprint === 'fp-a' ? make(c) : good(c)))
    assert.equal(r1.apply.status, 0, `${name}: ${r1.apply.stdout}`)
    assert.match(r1.apply.stdout, /^note: discarded, never repaired: v01: /m, name)
    assert.match(r1.apply.last, /decided=1 retried=1 unvalidated=0 pending=1 /, name)
    assert.equal(next(run.runDir), 'NEXT: validate run=workflow', `${name}: the step is not saved while a candidate is pending`)
    const e1 = entry(run.runDir, 'fp-a')
    assert.deepEqual([e1.state, e1.decision, e1.record, e1.attempts.map(a => [a.id, a.kind])], ['pending', null, null, [['v01', kind]]], name)
    assert.match(e1.attempts[0].problems.join(' '), re, name)
    assert.equal(entry(run.runDir, 'fp-b').state, 'decided', `${name}: the other candidate is kept`)
    const ledgerAfter1 = ledgerBytes(run.runDir)
    assert.ok(!JSON.stringify(readLedger(run.runDir)).includes('"v02"'), `${name}: the ledger is written once, when the step closes`)
    // the retry: only the pending candidate, a fresh ID
    const r2 = await round(run.runDir, (label, c) => make(c))
    assert.deepEqual(r2.input.candidates.map(c => c.agent_id), ['v01-t2'], name)
    assert.equal(r2.input.round, 2)
    assert.ok(r2.dir.endsWith('validate-r2'))
    assert.equal(r2.apply.status, 0, `${name}: ${r2.apply.stdout}`)
    assert.match(r2.apply.last, /decided=0 retried=0 unvalidated=1 pending=0 /, name)
    const e2 = entry(run.runDir, 'fp-a')
    const reason = kind === 'confirmed' ? 'confirmed_without_local_evidence' : 'validation_budget_exhausted'
    assert.deepEqual([e2.state, e2.unresolved, e2.record, e2.attempts.map(a => a.id)], ['unvalidated', reason, null, ['v01', 'v01-t2']], name)
    const m = meta(run.runDir)
    assert.deepEqual([m.run_status, m.incomplete_reason], ['incomplete', reason], name)
    assert.equal(next(run.runDir), 'NEXT: write-findings run=helper', name)
    const a = unitByName(run.runDir).a
    assert.deepEqual([a.status, a.result_fingerprints, a.unresolved], ['candidate', ['fp-a'], [reason]], `${name}: the unvalidated fingerprint stays linked to its candidate unit with its reason`)
    assert.ok(a.local_checks.every(c => !c.agent_id.startsWith('v')), `${name}: no verifier evidence on it`)
    assert.ok(unitByName(run.runDir).b.local_checks.some(c => c.agent_id === 'v02'))
    assert.notEqual(ledgerBytes(run.runDir), ledgerAfter1)
    assert.deepEqual(history(run.runDir).fingerprints['fp-a'].filter(h => h.role === 'validator').map(h => h.id), ['v01', 'v01-t2'], name)
    ok(run.runDir)
  }
})
await test('a verifier that returns a record of megabytes is discarded like any malformed result: it cannot sink findings.json for every other finding', async () => {
  const run = toValidate(TWO_DEFS())
  const res = await round(run.runDir, (l, c) => (c.fingerprint === 'fp-a' ? verified(c.fingerprint, { description: 'd'.repeat(6_000_000) }) : good(c)))
  assert.equal(res.apply.status, 0, res.apply.stdout)
  const e = entry(run.runDir, 'fp-a')
  assert.deepEqual([e.state, e.attempts.map(a => a.kind)], ['pending', ['malformed']])
  assert.match(e.attempts[0].problems[0], /^the record is \d+ bytes, over the 65536 a record may hold$/)
  assert.ok(readFileSync(join(run.runDir, 'decisions.json')).length < 200_000, 'decisions.json holds none of it')
})
await test('a retry that succeeds is the candidate\'s decision, made by the fresh verifier; the first result is kept only as a discarded attempt; a refused confirmed is retried with the parent\'s note, a malformed one without', async () => {
  for (const [name, make, kind] of [BAD[3], BAD[17]].map(([n, m, k]) => [n, m, k])) {
    const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
    await round(run.runDir, (label, c) => (c.fingerprint === 'fp-a' ? make(c) : good(c)))
    const r2 = await round(run.runDir, (label, c) => verified(c.fingerprint, { title: 'Second try' }))
    assert.equal(r2.apply.status, 0, r2.apply.stdout)
    const e = entry(run.runDir, 'fp-a')
    assert.deepEqual([e.state, e.decision, e.verifier_id, e.record.title, e.attempts.map(a => [a.id, a.kind])], ['decided', 'needs_validation', 'v01-t2', 'Second try', [['v01', kind]]], name)
    assert.equal(r2.prompts['v01-t2'].includes('## 11. A previous verifier\'s result for this candidate was refused'), kind === 'confirmed', name)
    if (kind === 'confirmed') assert.match(r2.prompts['v01-t2'], /<parent-note>\nThe previous verifier returned decision confirmed for this candidate\. needs_validation to confirmed is not possible here/)
    assert.ok(!r2.prompts['v01-t2'].includes('I also checked X') && !r2.prompts['v01-t2'].includes('Confirmed fp-a'), 'nothing of the discarded result reaches the fresh verifier')
    assert.equal(meta(run.runDir).run_status, 'in_progress')
    assert.equal(next(run.runDir), 'NEXT: write-findings run=helper')
    assert.deepEqual(history(run.runDir).fingerprints['fp-a'].filter(h => h.role === 'validator').map(h => h.id), ['v01', 'v01-t2'])
    assert.equal(meta(run.runDir).agents_spent, 3)
    ok(run.runDir)
  }
})
await test('a first confirmed and a second malformed result is validation_budget_exhausted: confirmed_without_local_evidence names only a verifier that insisted', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  await round(run.runDir, (label, c) => (c.fingerprint === 'fp-a' ? BAD[17][1](c) : good(c)))
  await round(run.runDir, (label, c) => BAD[5][1](c))
  assert.deepEqual([entry(run.runDir, 'fp-a').unresolved, meta(run.runDir).incomplete_reason], ['validation_budget_exhausted', 'validation_budget_exhausted'])
})
await test('judgeValidator: a decision and record are kept only when the record is that decision\'s branch of the schema, with the candidate\'s fingerprint; null, numbers, arrays and prose are all discarded', () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const e = { fingerprint: 'fp-a', proposed_verdict: 'needs_validation' }
  assert.equal(judgeValidator(run.runDir, e, verified('fp-a'), new Map()).decision, 'needs_validation')
  assert.equal(judgeValidator(run.runDir, e, rejected('fp-a'), new Map()).decision, 'rejected')
  for (const bad of [null, undefined, 0, 7, 'x', true, [], [verified('fp-a')], {}, { decision: null, record: null }, { decision: 'needs_validation', record: null }, { decision: ['needs_validation'], record: nvRec('fp-a') }, { decision: 'needs_validation', record: nvRec('fp-a'), x: 1 }]) {
    const r = judgeValidator(run.runDir, e, bad, new Map())
    assert.ok(r.kind && !r.decision, JSON.stringify(bad))
    assert.ok(r.problems.every(p => typeof p === 'string' && p.length <= 300))
  }
  const carried = judgeValidator(run.runDir, { ...e, proposed_verdict: 'confirmed' }, rejected('fp-a'), new Map())
  assert.equal(carried.decision, 'rejected', 'a carried confirmed record may be refuted')
  assert.equal(judgeValidator(run.runDir, { ...e, proposed_verdict: 'confirmed' }, verified('fp-a'), new Map()).decision, 'needs_validation', 'or demoted')
})
await test('the verdict a verifier\'s record names is the decision: a result is never kept under a decision its record contradicts, and the kept record is a copy', () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const e = { fingerprint: 'fp-a', proposed_verdict: 'needs_validation' }
  const input = verified('fp-a')
  const kept = judgeValidator(run.runDir, e, input, new Map())
  kept.record.title = 'mutated'
  assert.notEqual(input.record.title, 'mutated')
})

console.log('== the budget and the size of a round')
await test('a strict budget funds candidates in fingerprint order; the rest stay unvalidated candidates with upstream\'s reason, the run is incomplete, and no agent is launched for them', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }, { name: 'c', candidates: ['fp-c'] }], { args: ['--budget', '40'] })
  recordSpend(run.runDir, 'earlier', 38)   // 2 left
  const res = await round(run.runDir, (label, c) => good(c))
  assert.deepEqual(res.input.candidates.map(c => c.fingerprint), ['fp-a', 'fp-b'])
  assert.equal(res.apply.status, 0, res.apply.stdout)
  assert.deepEqual(decisions(run.runDir).entries.map(e => [e.fingerprint, e.state, e.unresolved]), [['fp-a', 'decided', null], ['fp-b', 'decided', null], ['fp-c', 'unvalidated', 'validation_budget_exhausted']])
  const m = meta(run.runDir)
  assert.deepEqual([m.run_status, m.incomplete_reason, m.agents_spent], ['incomplete', 'validation_budget_exhausted', 40])
  assert.deepEqual(unitByName(run.runDir).c.unresolved, ['validation_budget_exhausted'])
  assert.deepEqual(unitByName(run.runDir).c.local_checks.map(c => c.agent_id), [run.owners.c])
  assert.equal(next(run.runDir), 'NEXT: write-findings run=helper')
  ok(run.runDir)
})
await test('with no agent left every candidate is unvalidated at once: the plan launches nobody, says so, closes the step, and next goes on', () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }], { args: ['--budget', '40'] })
  recordSpend(run.runDir, 'earlier', 40)
  const r = stage(['plan', run.runDir])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL validation_budget_exhausted: 0 agent\(s\) are left of the budget \(--budget 40, 40 spent\) and 2 candidate\(s\) need a verifier; none was launched, they stay unvalidated candidates in the ledger and the run is marked incomplete/)
  assert.deepEqual(stageDirs(run.runDir), [])
  assert.deepEqual(decisions(run.runDir).entries.map(e => e.state), ['unvalidated', 'unvalidated'])
  assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['incomplete', 'validation_budget_exhausted'])
  assert.equal(next(run.runDir), 'NEXT: write-findings run=helper')
  assert.ok(unitByName(run.runDir).a.unresolved.includes('validation_budget_exhausted'))
  ok(run.runDir)
})
await test('a retry is gated by the budget like any agent: with the budget gone after the first round the retry is not launched and the candidate is unvalidated', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }], { args: ['--budget', '40'] })
  recordSpend(run.runDir, 'earlier', 38)
  await round(run.runDir, (label, c) => (c.fingerprint === 'fp-a' ? BAD[0][1](c) : good(c)))
  assert.equal(meta(run.runDir).agents_spent, 40)
  const r = stage(['plan', run.runDir])
  assert.match(r.last, /^AUDIT: FAIL validation_budget_exhausted: 0 agent\(s\) are left/)
  assert.equal(entry(run.runDir, 'fp-a').state, 'unvalidated')
  assert.equal(next(run.runDir), 'NEXT: write-findings run=helper')
})
await test('a round of first tries that every verifier failed is refused without using a try, and the stage is planned again; a round of retries that all fail uses the try, which is what ends the loop', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const r1 = await round(run.runDir, () => null)
  assert.equal(r1.apply.status, 1)
  assert.match(r1.apply.last, /^AUDIT: FAIL every verifier of the round returned nothing \(0 of 2 verifier\(s\) returned a result: .*\); no try was used \(2 agent\(s\) spent\): plan the stage again to retry it/)
  assert.deepEqual(decisions(run.runDir).entries.map(e => [e.state, e.attempts.length]), [['pending', 0], ['pending', 0]], 'no try was used')
  assert.equal(meta(run.runDir).agents_spent, 2, 'the agents ran, so they are spent')
  assert.equal(next(run.runDir), 'NEXT: validate run=workflow')
  const r2 = await round(run.runDir, () => null)   // the same first tries again, under the same IDs
  assert.deepEqual(r2.input.candidates.map(c => c.agent_id), ['v01', 'v02'])
  assert.equal(r2.apply.status, 1)
  const r3 = await round(run.runDir, (label, c) => (c.fingerprint === 'fp-a' ? good(c) : null))   // one succeeds: now each counts
  assert.equal(r3.apply.status, 0, r3.apply.stdout)
  assert.deepEqual(decisions(run.runDir).entries.map(e => [e.state, e.attempts.length]), [['decided', 0], ['pending', 1]])
  const r4 = await round(run.runDir, () => null)   // a retry round that all fail
  assert.equal(r4.apply.status, 0, r4.apply.stdout)
  assert.deepEqual(decisions(run.runDir).entries.map(e => e.state), ['decided', 'unvalidated'])
  assert.equal(meta(run.runDir).incomplete_reason, 'validation_budget_exhausted')
})
await test('candidates go in batches that fit one script: the first round takes what fits, the rest wait pending and run next round; no script is over the ceiling', async () => {
  const defs = Array.from({ length: 8 }, (_, i) => ({ name: `n${i}`, candidates: [[`fp-${i}`, { description: 'd'.repeat(60_000) }]] }))
  const run = toValidate(defs)
  const sizes = []
  let rounds = 0
  while (next(run.runDir) === 'NEXT: validate run=workflow') {
    const res = await round(run.runDir, (label, c) => good(c))
    assert.equal(res.apply.status, 0, res.apply.stdout)
    sizes.push([res.input.candidates.length, statSync(join(res.dir, 'run.js')).size])
    rounds += 1
    assert.ok(rounds <= 4)
  }
  assert.ok(sizes.length >= 2, `more than one round: ${JSON.stringify(sizes)}`)
  assert.equal(sizes.reduce((n, [c]) => n + c, 0), 8)
  for (const [, bytes] of sizes) assert.ok(bytes < MAX_SCRIPT_BYTES, `${bytes} is under the guard`)
  assert.ok(MAX_VALIDATE_BYTES < MAX_SCRIPT_BYTES)
  assert.deepEqual(decisions(run.runDir).entries.map(e => e.state), Array(8).fill('decided'))
  assert.deepEqual(decisions(run.runDir).entries.map(e => e.n), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(next(run.runDir), 'NEXT: write-findings run=helper')
  ok(run.runDir)
})

console.log('== carried prior records')
await test('a carried prior record is validated like a candidate: its unit becomes a candidate owned by the verifier, with the verifier\'s check as its first, and the prior record is in its input', async () => {
  const refs = refsOf('carry', { subsystem: 'carry' })
  const carriedUnit = priorUnit('carry', 'candidate', { canonical_refs: refs, coverage_id: canonicalCoverageId(refs), result_fingerprints: ['fp-carry'] })
  const before = repo => priorRun(repo, [carriedUnit], [needsValidationRecord('fp-carry')])
  const run = toValidate([{ name: 'carry', candidates: [] }, { name: 'x', candidates: ['fp-x'] }], { before })
  const unit = unitByName(run.runDir).carry
  assert.deepEqual([unit.status, unit.agent_id, unit.prior_status, unit.local_checks], ['planned', null, 'prior_needs_validation', []])
  const res = await round(run.runDir, (label, c) => good(c))
  assert.equal(res.apply.status, 0, res.apply.stdout)
  assert.deepEqual(res.input.candidates.map(c => [c.agent_id, c.fingerprint]), [['v01', 'fp-carry'], ['v02', 'fp-x']])
  assert.deepEqual(res.input.candidates[0].priors.map(p => [p.run_id, p.record.verdict]), [['run-1', 'needs_validation']])
  assert.deepEqual(history(run.runDir).fingerprints['fp-carry'], [{ role: 'validator', id: 'v01' }], 'a carried record has no hunter')
  const after = unitByName(run.runDir).carry
  assert.deepEqual([after.status, after.agent_id, after.result_fingerprints, after.unresolved, after.local_checks.map(c => c.agent_id)], ['candidate', 'v01', ['fp-carry'], [], ['v01']])
  assert.deepEqual(after.reviewed_paths, ['src/app.js'])
  assert.equal(after.prior_status, 'prior_needs_validation')
  ok(run.runDir)
})

await test('a carried unit with two prior leads becomes one candidate holding both fingerprints, owned by the first verifier, with each verifier\'s check: no lead is linked from nowhere', async () => {
  const refs = refsOf('carry', { subsystem: 'carry' })
  const carriedUnit = priorUnit('carry', 'candidate', { canonical_refs: refs, coverage_id: canonicalCoverageId(refs), result_fingerprints: ['fp-c1', 'fp-c2'] })
  const before = repo => priorRun(repo, [carriedUnit], [needsValidationRecord('fp-c1'), needsValidationRecord('fp-c2')])
  const run = toValidate([{ name: 'carry', candidates: [] }, { name: 'x', candidates: ['fp-x'] }], { before })
  const res = await round(run.runDir, (label, c) => good(c))
  assert.equal(res.apply.status, 0, res.apply.stdout)
  assert.deepEqual(res.input.candidates.map(c => c.fingerprint), ['fp-c1', 'fp-c2', 'fp-x'])
  const after = unitByName(run.runDir).carry
  assert.deepEqual([after.status, after.agent_id, after.result_fingerprints, after.local_checks.map(c => c.agent_id)], ['candidate', 'v01', ['fp-c1', 'fp-c2'], ['v01', 'v02']])
  ok(run.runDir)
  assert.equal(writeFindings(run.runDir).summary.split(' ')[0], 'records=3', 'both leads are linked from the unit, so the link-check passes and findings.json is written')
})
await test('independence is asserted again at apply: a hunter ID written into the history after the plan makes apply refuse, and nothing changes', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const plan = stage(['plan', run.runDir])
  const dir = stageDirOf(plan, run.runDir)
  const input = readJsonFile(dir, 'input.json')
  const ran = await runScript(join(dir, 'run.js'), { 'audit-analyst': input.candidates.map(() => (p, opts) => good(input.candidates.find(c => c.agent_id === opts.label))) })
  const h = readJsonFile(run.runDir, 'agent-history.json')
  h.fingerprints['fp-a'] = h.fingerprints['fp-a'].filter(e => e.role !== 'validator').concat([{ role: 'hunter', id: 'v01' }])
  writeFileSync(join(run.runDir, 'agent-history.json'), JSON.stringify(h))
  const file = returnedFile(dir, ran.result)
  const before = snapshot(run.runDir)
  const r = stage(['apply', run.runDir, file])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL agent v01 already served as hunter of fp-a: it cannot also be its validator/)
  assert.deepEqual(snapshot(run.runDir), before)
})
console.log('== crash windows and mutation')
await test('a crash after the effects landed and before the step was saved is finished by applying the same result again: nothing is judged twice, the cost is recorded once, the ledger is the same', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const snap = snapshot(run.runDir)
  const plan = stage(['plan', run.runDir])
  const dir = stageDirOf(plan, run.runDir)
  const input = readJsonFile(dir, 'input.json')
  const ran = await runScript(join(dir, 'run.js'), { 'audit-analyst': input.candidates.map(() => (p, opts) => good(input.candidates.find(c => c.agent_id === opts.label))) })
  const file = returnedFile(dir, ran.result)
  assert.equal(stage(['apply', run.runDir, file]).status, 0)
  const afterLedger = ledgerBytes(run.runDir), afterDecisions = readFileSync(join(run.runDir, 'decisions.json'), 'utf8'), afterHistory = readFileSync(join(run.runDir, 'agent-history.json'), 'utf8')
  writeFileSync(join(run.runDir, 'stage-state.json'), snap.get('stage-state.json'))   // the step save never happened
  assert.equal(next(run.runDir), 'NEXT: validate run=workflow')
  const again = stage(['apply', run.runDir, file])
  assert.equal(again.status, 0, again.stdout)
  assert.equal(next(run.runDir), 'NEXT: write-findings run=helper')
  assert.equal(ledgerBytes(run.runDir), afterLedger)
  assert.equal(readFileSync(join(run.runDir, 'decisions.json'), 'utf8'), afterDecisions)
  assert.equal(readFileSync(join(run.runDir, 'agent-history.json'), 'utf8'), afterHistory)
  assert.equal(meta(run.runDir).agents_spent, 2)
  ok(run.runDir)
})
await test('a crash between a failed attempt and the step is finished by the same result again without counting the attempt twice', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const plan = stage(['plan', run.runDir])
  const dir = stageDirOf(plan, run.runDir)
  const input = readJsonFile(dir, 'input.json')
  const ran = await runScript(join(dir, 'run.js'), { 'audit-analyst': input.candidates.map(() => (p, opts) => (opts.label === 'v01' ? null : good(input.candidates.find(c => c.agent_id === opts.label)))) })
  const file = returnedFile(dir, ran.result)
  assert.equal(stage(['apply', run.runDir, file]).status, 0)
  assert.equal(stage(['apply', run.runDir, file]).status, 0, 'applying the same result again is harmless')
  assert.deepEqual(entry(run.runDir, 'fp-a').attempts.map(a => a.id), ['v01'], 'one attempt, not two')
  assert.equal(entry(run.runDir, 'fp-a').state, 'pending')
  assert.equal(meta(run.runDir).agents_spent, 2)
})
await test('a result for IDs the plan did not make, or with a verifier missing, is refused whole; a stale plan is refused; nothing changes', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const plan = stage(['plan', run.runDir])
  const dir = stageDirOf(plan, run.runDir)
  const input = readJsonFile(dir, 'input.json')
  const goodResult = (await runScript(join(dir, 'run.js'), { 'audit-analyst': input.candidates.map(() => (p, opts) => good(input.candidates.find(c => c.agent_id === opts.label))) })).result
  const shapes = [
    { ...goodResult, results: { part: 'validate', verifiers: { v01: good(input.candidates[0]) } } },
    { ...goodResult, results: { part: 'validate', verifiers: { v01: good(input.candidates[0]), v02: good(input.candidates[1]), v03: null } } },
    { ...goodResult, results: { part: 'validate', verifiers: { v01: good(input.candidates[0]), v09: good(input.candidates[1]) } } },
    { ...goodResult, results: { part: 'validate', verifiers: { v01: 'x', v02: 7 } } },
    { ...goodResult, results: { part: 'validate', verifiers: [null, null] } },
    { ...goodResult, results: { part: 'validate' } },
    { ...goodResult, results: { part: 'consolidate', verifiers: goodResult.results.verifiers } },
  ]
  for (const bad of shapes) {
    const file = returnedFile(dir, bad)
    const before = snapshot(run.runDir)
    const r = stage(['apply', run.runDir, file])
    assert.equal(r.status, 1, JSON.stringify(bad.results).slice(0, 80))
    assert.deepEqual(snapshot(run.runDir), before, 'not one byte changed')
  }
  const tampered = JSON.parse(JSON.stringify(input))
  tampered.candidates[0].agent_id = 'v05'
  writeFileSync(join(dir, 'input.json'), JSON.stringify(tampered))
  const r = stage(['apply', run.runDir, returnedFile(dir, { ...goodResult, results: { part: 'validate', verifiers: { v05: good(input.candidates[0]), v02: good(input.candidates[1]) } } })])
  assert.match(r.last, /^AUDIT: FAIL v05 is not the verifier planned for fp-a \(that is v01\): plan the stage again/)
  assert.equal(agentId('v', 1), 'v01')
})
await test('a good result with one field of any depth deleted or replaced by the wrong type is refused or applied, never a crash, and the run still passes check', async () => {
  const run = toValidate([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }])
  const plan = stage(['plan', run.runDir])
  const dir = stageDirOf(plan, run.runDir)
  const input = readJsonFile(dir, 'input.json')
  const goodResult = (await runScript(join(dir, 'run.js'), { 'audit-analyst': input.candidates.map(() => (p, opts) => good(input.candidates.find(c => c.agent_id === opts.label))) })).result
  const out = fuzzApply(run.runDir, goodResult, dir, 120)
  assert.equal(out.ok + out.refused, 120)
  assert.ok(out.refused > 0 && out.ok > 0, JSON.stringify(out))
})
