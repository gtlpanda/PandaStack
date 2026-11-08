// audit-verify.test.mjs - the verify stage (Phase 5, audit-verify.mjs wired in audit-stage.mjs): what a Phase 5 verifier is sent and what it is not, replace -> materiality -> a new
// independent verifier, every result judged by the real vendored validator, a record that cannot be settled removed with the run incomplete, the budget, the crash window, and the
// run ending complete only through complete-check. The workflow side is in security-audit-verdicts.test.mjs.
import { join } from 'node:path'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { MAX_VERIFY_BYTES, judgeVerifier, verifyInput } from '../skills/security-audit/audit-verify.mjs'
import { completeProblems, decisionsOf, linkCheck, readPool, writeFindings } from '../skills/security-audit/audit-findings.mjs'
import { loadRun, markIncomplete, recordSpend } from '../skills/security-audit/audit-run.mjs'
import { parts, resolve as block } from '../skills/security-audit/blocks.mjs'
import { audit, meta } from './audit-fixtures.mjs'
import { confirmedRecord, ledgerBytes, ledgerValid, readJsonFile, readLedger } from './ledger-fixtures.mjs'
import { MAX_SCRIPT_BYTES } from '../skills/security-audit/audit-stage.mjs'
import { fuzzApply, returnedFile, runScript, snapshot, stage, stageDirOf, stageDirs } from './stage-fixtures.mjs'
import { FILES } from './stage-fixtures.mjs'
import { validateFindingsFile, validateLedgerFile } from '../skills/security-audit/upstream.mjs'
import { atVerify, decisions, history, next, passed, replaced, round, toValidate, unitByName, verified, verifyRound } from './verdict-fixtures.mjs'

const P = parts()
const TWO = [{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }]
const entry = (runDir, fp) => decisions(runDir).entries.find(e => e.fingerprint === fp)
const found = runDir => JSON.parse(readFileSync(join(runDir, 'findings.json'), 'utf8'))
const ok = runDir => {
  assert.equal(validateFindingsFile(join(runDir, 'findings.json')).valid, true, 'upstream\'s findings validator passes')
  assert.equal(validateLedgerFile(join(runDir, 'coverage-ledger.json')).valid, true, 'upstream\'s ledger validator passes')
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
}
// Leaves `n` agents of a budget of `budget`: what the stages spent so far, plus a filler that takes the rest.
const leaveAgents = (runDir, budget, n, key = 'filler') => recordSpend(runDir, key, Math.max(0, budget - meta(runDir).agents_spent + (meta(runDir).stage_spend[key] ?? 0) - n))
const roles = (runDir, fp) => history(runDir).fingerprints[fp].map(h => `${h.role}:${h.id}`)

console.log('== what a Phase 5 verifier is sent')
await test('one item per retained confirmed or needs_validation record, with the decided record and nothing of how it was decided; a rejected record is not read', async () => {
  const run = await atVerify([...TWO, { name: 'c', candidates: ['fp-c'] }], undefined, (l, c) => (c.fingerprint === 'fp-b' ? { decision: 'rejected', record: { verdict: 'rejected', fingerprint: 'fp-b', title: 'T', description: 'd', claimed_root_cause: 'r', trace: [{ kind: 'sink', file: 'src/app.js', line: 1, scope: 'a', description: 'x' }], evidence: [{ file: 'src/app.js', line: 1, description: 'e' }], reason: 'refuted' } } : verified(c.fingerprint, { title: `Verified ${c.fingerprint} by ${l}` })))
  const input = verifyInput(run.runDir, loadRun(run.runDir))
  assert.deepEqual([input.stage, input.part, input.round, input.tree], ['verify', 'verify', 1, join(run.runDir, 'tree')])
  assert.deepEqual(input.items.map(i => [i.agent_id, i.fingerprint, i.kind, i.verdict]), [['r01', 'fp-a', 'phase5', 'needs_validation'], ['r03', 'fp-c', 'phase5', 'needs_validation']], 'r02 is the rejected one\'s, which is never read')
  assert.deepEqual(Object.keys(input.items[0]).sort(), ['agent_id', 'fingerprint', 'kind', 'record', 'verdict'])
  assert.equal(input.items[0].record.title, 'Verified fp-a by v01', 'the record the Phase 3 verifier left')
  const text = JSON.stringify(input)
  assert.ok(!/"v01"|"v03"|attempts|verifier_id|decided_in/.test(text.replace(input.items[0].record.title, '')), 'not the Phase 3 verifier\'s ID, attempts or decision')
  assert.ok(!text.includes(run.owners.a), 'no hunter ID')
  assert.equal(input.parts.phase5, block('VALIDATION-AND-REPORTING.md#Phase 5: Verify the final records with fresh eyes').text)
  assert.equal(input.parts.localBoundaries, block('HUNTING.md#Local validation boundaries').text)
  for (const k of ['recordContract', 'schema_confirmed', 'schema_needs_validation', 'schema_rejected']) assert.equal(input.parts[k], P[k].text)
  assert.deepEqual(entry(run.runDir, 'fp-a').phase5.state, 'pending')
  assert.deepEqual(roles(run.runDir, 'fp-a'), [`hunter:${run.owners.a}`, 'validator:v01', 'verifier:r01'])
  assert.deepEqual(verifyInput(run.runDir, loadRun(run.runDir)), input, 'the same state gives the same input and IDs')
})
await test('a hunter, a Phase 3 verifier or a reused ID cannot be a record\'s Phase 5 verifier: a history that already holds r01 in another role is refused at the plan', async () => {
  const run = await atVerify(TWO)
  const h = JSON.parse(readFileSync(join(run.runDir, 'agent-history.json'), 'utf8'))
  h.fingerprints['fp-a'].push({ role: 'hunter', id: 'r01' })
  writeFileSync(join(run.runDir, 'agent-history.json'), JSON.stringify(h))
  const r = stage(['plan', run.runDir])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL agent r01 already served as hunter of fp-a: it cannot also be its verifier/)
  assert.deepEqual(stageDirs(run.runDir).filter(d => d.includes('verify')), [], 'no verify stage was written')
})
await test('findings.json that is not the decided records is refused at the plan: it is written by write-findings and verify, never by hand', async () => {
  const run = await atVerify(TWO)
  writeFileSync(join(run.runDir, 'findings.json'), JSON.stringify(found(run.runDir).map(r => ({ ...r, title: 'edited' }))))
  assert.match(stage(['plan', run.runDir]).last, /^AUDIT: FAIL findings\.json is not the decided records/)
})

console.log('== a record every verifier verified')
await test('every record verified: the step is saved, complete-check passes, the run is complete, and next goes to the report', async () => {
  const run = await atVerify(TWO)
  const res = await verifyRound(run.runDir, (l, item) => passed(item))
  assert.equal(res.apply.status, 0, res.apply.stdout)
  assert.match(res.apply.last, /^AUDIT: OK apply verify round=1 items=2 verified=2 replaced=0 queued=0 retried=0 removed=0 pending=0 agents=2$/)
  assert.match(res.apply.stdout, /^note: every candidate has an independent final disposition and every retained record passed Phase 5: the run is complete$/m)
  assert.deepEqual(Object.values(res.types), ['audit-researcher', 'audit-researcher'])
  assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['complete', null])
  assert.equal(next(run.runDir), 'NEXT: report run=helper')
  assert.deepEqual(decisions(run.runDir).entries.map(e => [e.fingerprint, e.phase5.state, e.phase5.verifier_id]), [['fp-a', 'verified', 'r01'], ['fp-b', 'verified', 'r02']])
  assert.deepEqual(roles(run.runDir, 'fp-a'), [`hunter:${run.owners.a}`, 'validator:v01', 'verifier:r01'], 'four roles, four distinct agents')
  assert.deepEqual(completeProblems(run.runDir).problems, [])
  assert.equal(meta(run.runDir).agents_spent, 2 + 2)
  ok(run.runDir)
})
await test('a non-material replacement (wording, a line) is applied directly: findings.json holds it, the verifier that proposed it passed the record, and nothing else was asked', async () => {
  const run = await atVerify(TWO, { files: FILES }, (l, c) => verified(c.fingerprint, { trace: [{ kind: 'sink', file: 'src/lines.js', line: 1, scope: 'a', description: 'The write happens.' }] }))
  const res = await verifyRound(run.runDir, (l, item) => (item.fingerprint === 'fp-a'
    ? replaced(item, { title: 'A better title', description: 'Reworded.', trace: [{ kind: 'sink', file: 'src/lines.js', line: 3, scope: 'a', description: 'Described again.' }] })
    : passed(item)))
  assert.equal(res.apply.status, 0, res.apply.stdout)
  assert.match(res.apply.last, /verified=1 replaced=1 queued=0 retried=0 removed=0 pending=0 agents=2$/)
  const a = found(run.runDir).find(r => r.fingerprint === 'fp-a')
  assert.deepEqual([a.title, a.trace[0].line], ['A better title', 3])
  assert.deepEqual(decisions(run.runDir).entries[0].record, a, 'the decided record is the file\'s record')
  assert.equal(stageDirs(run.runDir).filter(d => d.includes('verify')).length, 1, 'one round: no new verifier for a wording change')
  assert.equal(meta(run.runDir).run_status, 'complete')
  ok(run.runDir)
})

console.log('== a material replacement goes to a new independent verifier')
await test('a replacement that changes the root cause waits: findings.json keeps the record until a new verifier that did not hunt, validate or propose it verified the replacement; it is then applied', async () => {
  const run = await atVerify(TWO)
  const original = found(run.runDir).find(r => r.fingerprint === 'fp-a')
  const r1 = await verifyRound(run.runDir, (l, item) => (item.fingerprint === 'fp-a' ? replaced(item, { claimed_root_cause: 'REPLACEMENT-ROOT-CAUSE', title: 'REPLACEMENT-TITLE' }, 'REASON-OF-THE-PROPOSER') : passed(item)))
  assert.equal(r1.apply.status, 0, r1.apply.stdout)
  assert.match(r1.apply.last, /verified=1 replaced=0 queued=1 retried=0 removed=0 pending=1 agents=2$/)
  assert.match(r1.apply.stdout, /^note: fp-a: a material replacement \(claimed_root_cause\) goes to a new independent verifier, round 1$/m)
  assert.deepEqual(found(run.runDir).find(r => r.fingerprint === 'fp-a'), original, 'the replacement is not applied before it is verified')
  assert.equal(next(run.runDir), 'NEXT: verify run=workflow')
  assert.equal(meta(run.runDir).run_status, 'in_progress')
  // round 2: the replacement alone, to a new agent of another type, sent the replacement and nothing about how it came to be
  const r2 = await verifyRound(run.runDir, (l, item) => passed(item))
  assert.deepEqual(r2.input.items.map(i => [i.agent_id, i.kind, i.fingerprint]), [['x01', 'replacement', 'fp-a']])
  assert.deepEqual(r2.types, { x01: 'audit-analyst' })
  assert.ok(r2.dir.endsWith('verify-r2'))
  const prompt = r2.prompts.x01
  assert.ok(prompt.includes('REPLACEMENT-ROOT-CAUSE') && prompt.includes('REPLACEMENT-TITLE'), 'the complete replacement')
  assert.ok(!prompt.includes('REASON-OF-THE-PROPOSER') && !prompt.includes(original.claimed_root_cause) && !prompt.includes('r01') && !prompt.includes('v01'), 'not its proposer\'s reason, not the record it replaces, not any verifier')
  assert.match(prompt, /a replacement that an earlier Phase 5 verifier proposed/)
  assert.equal(r2.apply.status, 0, r2.apply.stdout)
  const a = found(run.runDir).find(r => r.fingerprint === 'fp-a')
  assert.deepEqual([a.title, a.claimed_root_cause], ['REPLACEMENT-TITLE', 'REPLACEMENT-ROOT-CAUSE'])
  assert.deepEqual(roles(run.runDir, 'fp-a'), [`hunter:${run.owners.a}`, 'validator:v01', 'verifier:r01', 'replacer:x01'])
  assert.equal(entry(run.runDir, 'fp-a').phase5.verifier_id, 'x01')
  assert.deepEqual([meta(run.runDir).run_status, next(run.runDir)], ['complete', 'NEXT: report run=helper'])
  assert.deepEqual(completeProblems(run.runDir).problems, [])
  ok(run.runDir)
})
await test('a replacement that changes the verdict is material in either direction, and a rejected one is applied after its verification: the record leaves the leads', async () => {
  const run = await atVerify(TWO)
  const reject = item => ({ decision: 'replace', reason: 'the source refutes it', record: { verdict: 'rejected', fingerprint: item.fingerprint, title: item.record.title, description: item.record.description, claimed_root_cause: item.record.claimed_root_cause, trace: item.record.trace, evidence: item.record.evidence, reason: 'Every route passes the wrapper first.' } })
  await verifyRound(run.runDir, (l, item) => (item.fingerprint === 'fp-a' ? reject(item) : passed(item)))
  assert.equal(found(run.runDir).find(r => r.fingerprint === 'fp-a').verdict, 'needs_validation', 'not before the new verifier agrees')
  const r2 = await verifyRound(run.runDir, (l, item) => passed(item))
  assert.equal(r2.apply.status, 0, r2.apply.stdout)
  assert.deepEqual(found(run.runDir).map(r => [r.fingerprint, r.verdict]), [['fp-a', 'rejected'], ['fp-b', 'needs_validation']])
  assert.equal(meta(run.runDir).run_status, 'complete')
  ok(run.runDir)
})
await test('a second material replacement from the new verifier goes to another fresh one (x01-r2), and the third is not asked for: the record is removed, the unit stays unresolved, the run is incomplete', async () => {
  const run = await atVerify(TWO)
  const bump = n => item => replaced(item, { claimed_root_cause: `ROOT-${n}` })
  await verifyRound(run.runDir, (l, item) => (item.fingerprint === 'fp-a' ? bump(1)(item) : passed(item)))
  const r2 = await verifyRound(run.runDir, (l, item) => bump(2)(item))
  assert.deepEqual(r2.input.items.map(i => i.agent_id), ['x01'])
  assert.equal(r2.apply.status, 0, r2.apply.stdout)
  assert.match(r2.apply.stdout, /round 2/)
  assert.equal(found(run.runDir).find(r => r.fingerprint === 'fp-a').claimed_root_cause, entry(run.runDir, 'fp-b').record.claimed_root_cause.replace('fp-b', 'fp-a'), 'still the original record')
  const r3 = await verifyRound(run.runDir, (l, item) => bump(3)(item))
  assert.deepEqual(r3.input.items.map(i => i.agent_id), ['x01-r2'], 'a fresh verifier, not x01 again')
  assert.ok(!r3.prompts['x01-r2'].includes('ROOT-1') && r3.prompts['x01-r2'].includes('ROOT-2'))
  assert.equal(r3.apply.status, 0, r3.apply.stdout)
  assert.match(r3.apply.last, /removed=1 pending=0/)
  assert.deepEqual(found(run.runDir).map(r => r.fingerprint), ['fp-b'], 'the disputed record is out of findings.json')
  const e = entry(run.runDir, 'fp-a')
  assert.deepEqual([e.phase5.state, e.phase5.reason], ['removed', 'record_verification_unresolved'])
  assert.match(e.phase5.note, /proposed again after 2 independent verification\(s\): claimed_root_cause/)
  assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['incomplete', 'record_verification_unresolved'])
  assert.equal(next(run.runDir), 'NEXT: report run=helper reason=record_verification_unresolved')
  assert.deepEqual(unitByName(run.runDir).a.unresolved, ['record_verification_unresolved'], 'its unit stays an unresolved candidate')
  assert.equal(unitByName(run.runDir).a.status, 'candidate')
  const link = linkCheck({ runDir: run.runDir, records: found(run.runDir), ledger: readLedger(run.runDir), decisions: decisionsOf(run.runDir), pool: readPool(run.runDir), meta: loadRun(run.runDir).meta })
  assert.deepEqual([link.problems, link.unresolved.map(u => [u.fingerprint, u.reason])], [[], [['fp-a', 'record_verification_unresolved']]])
  assert.deepEqual(roles(run.runDir, 'fp-a').slice(2), ['verifier:r01', 'replacer:x01', 'replacer:x01-r2'], 'every verifier of the fingerprint is a different agent')
  ok(run.runDir)
})
await test('a replacement that promotes a record to confirmed is never applied and never reaches a verifier: it is discarded, retried, and then the record is removed', async () => {
  const run = await atVerify(TWO)
  const promote = item => ({ decision: 'replace', reason: 'I reproduced it', record: confirmedRecord(item.fingerprint) })
  const r1 = await verifyRound(run.runDir, (l, item) => (item.fingerprint === 'fp-a' ? promote(item) : passed(item)))
  assert.equal(r1.apply.status, 0, r1.apply.stdout)
  const e1 = entry(run.runDir, 'fp-a')
  assert.deepEqual([e1.phase5.state, e1.phase5.replacement, e1.phase5.attempts.map(a => [a.id, a.kind])], ['pending', null, [['r01', 'confirmed']]])
  assert.match(e1.phase5.attempts[0].problems[0], /needs_validation to confirmed is not possible here/)
  const r2 = await verifyRound(run.runDir, (l, item) => promote(item))
  assert.deepEqual(r2.input.items.map(i => i.agent_id), ['r01-t2'])
  assert.match(r2.apply.last, /removed=1 pending=0/)
  assert.ok(found(run.runDir).every(r => r.verdict !== 'confirmed'))
  assert.equal(entry(run.runDir, 'fp-a').phase5.reason, 'record_verification_unresolved')
  assert.equal(meta(run.runDir).incomplete_reason, 'record_verification_unresolved')
})

console.log('== the verifier\'s result is judged, never repaired')
const BAD = [
  ['no result', () => null, 'no_result', /returned no result/],
  ['prose', () => 'verified: fp-a', 'no_result', /returned no result/],
  ['an array', () => [], 'no_result', /returned no result/],
  ['an unknown decision', () => ({ decision: 'maybe' }), 'malformed', /decision is "maybe"/],
  ['verified with an extra key', item => ({ ...passed(item), notes: 'also checked X' }), 'malformed', /a verified result is exactly \{decision, fingerprint\}/],
  ['verified with another fingerprint', () => ({ decision: 'verified', fingerprint: 'fp-other' }), 'malformed', /verified names fingerprint "fp-other"/],
  ['verified with no fingerprint', () => ({ decision: 'verified' }), 'malformed', /a verified result is exactly/],
  ['replace with no reason', item => { const { reason, ...r } = replaced(item, { title: 'x' }); return r }, 'malformed', /a replace result is exactly \{decision, reason, record\}/],
  ['replace with a blank reason', item => replaced(item, { title: 'x' }, '  '), 'malformed', /a replace result needs a reason/],
  ['replace with an extra key', item => ({ ...replaced(item, { title: 'x' }), more: 1 }), 'malformed', /a replace result is exactly/],
  ['replace with a record that is not an object', () => ({ decision: 'replace', reason: 'x', record: 'the record' }), 'malformed', /the record is not an object/],
  ['replace with a severity on a needs_validation record', item => replaced(item, { severity: { overall_severity: 'high' } }), 'malformed', /needs_validation finding must not contain "severity"/],
  ['replace with a trace file that is not in the snapshot', item => replaced(item, { trace: [{ kind: 'sink', file: 'src/ghost.js', line: 1, scope: 'a', description: 'x' }] }), 'malformed', /"src\/ghost\.js" is not in tree\//],
  ['replace with a line past the end', item => replaced(item, { evidence: [{ file: 'src/app.js', line: 99, description: 'x' }] }), 'malformed', /has 1 line\(s\)/],
  ['replace with a different fingerprint (a separate root cause)', item => replaced(item, { fingerprint: 'fp-new-root-cause' }), 'other_fingerprint', /a separate root cause is not applied here/],
  ['replace with the fingerprint and a line number', item => replaced(item, { fingerprint: `${item.fingerprint}:12` }), 'other_fingerprint', /not "fp-a"/],
]
await test('every kind of bad Phase 5 result is discarded, the record is retried once with a fresh ID, and a second failure removes it from findings.json with the run incomplete', async () => {
  for (const [name, make, kind, re] of BAD) {
    const run = await atVerify(TWO)
    const r1 = await verifyRound(run.runDir, (l, item) => (item.fingerprint === 'fp-a' ? make(item) : passed(item)))
    assert.equal(r1.apply.status, 0, `${name}: ${r1.apply.stdout}`)
    assert.match(r1.apply.stdout, /^note: discarded, never repaired: r01: /m, name)
    assert.match(r1.apply.last, /verified=1 replaced=0 queued=0 retried=1 removed=0 pending=1 /, name)
    const e1 = entry(run.runDir, 'fp-a')
    assert.deepEqual([e1.phase5.state, e1.phase5.attempts.map(a => [a.id, a.kind])], ['pending', [['r01', kind]]], name)
    assert.match(e1.phase5.attempts[0].problems.join(' '), re, name)
    assert.equal(found(run.runDir).length, 2, `${name}: findings.json is untouched while the retry is pending`)
    assert.equal(next(run.runDir), 'NEXT: verify run=workflow', name)
    const r2 = await verifyRound(run.runDir, (l, item) => make(item))
    assert.deepEqual(r2.input.items.map(i => i.agent_id), ['r01-t2'], name)
    assert.equal(r2.apply.status, 0, `${name}: ${r2.apply.stdout}`)
    assert.match(r2.apply.last, /removed=1 pending=0 /, name)
    assert.deepEqual(found(run.runDir).map(r => r.fingerprint), ['fp-b'], name)
    const e2 = entry(run.runDir, 'fp-a')
    assert.deepEqual([e2.phase5.state, e2.phase5.reason, e2.phase5.attempts.map(a => a.id)], ['removed', 'record_verification_unresolved', ['r01', 'r01-t2']], name)
    assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['incomplete', 'record_verification_unresolved'], name)
    assert.deepEqual(unitByName(run.runDir).a.unresolved, ['record_verification_unresolved'], name)
    assert.equal(next(run.runDir), 'NEXT: report run=helper reason=record_verification_unresolved', name)
    assert.equal(entry(run.runDir, 'fp-b').phase5.state, 'verified', `${name}: the other record is kept`)
    ok(run.runDir)
  }
})
await test('a retry that succeeds settles the record under the fresh verifier\'s ID', async () => {
  const run = await atVerify(TWO)
  await verifyRound(run.runDir, (l, item) => (item.fingerprint === 'fp-a' ? BAD[4][1](item) : passed(item)))
  const r2 = await verifyRound(run.runDir, (l, item) => passed(item))
  assert.equal(r2.apply.status, 0, r2.apply.stdout)
  const e = entry(run.runDir, 'fp-a')
  assert.deepEqual([e.phase5.state, e.phase5.verifier_id, e.phase5.attempts.map(a => a.id)], ['verified', 'r01-t2', ['r01']])
  assert.deepEqual(roles(run.runDir, 'fp-a').slice(2), ['verifier:r01', 'verifier:r01-t2'])
  assert.equal(meta(run.runDir).run_status, 'complete')
  assert.ok(!r2.prompts['r01-t2'].includes('also checked X'), 'nothing of the discarded result reaches the fresh verifier')
  ok(run.runDir)
})
await test('judgeVerifier: verified, a non-material and a material replacement are told apart; null, numbers, arrays, prose and a record in prose are discarded', async () => {
  const run = await atVerify(TWO)
  const e = decisions(run.runDir).entries[0]
  const e2 = { ...e, phase5: { ...e.phase5 ?? {}, replacement: null } }
  const item = { fingerprint: 'fp-a', record: e.record }
  assert.deepEqual(judgeVerifier(run.runDir, e2, passed(item), new Map()), { verified: true })
  const mat = judgeVerifier(run.runDir, e2, replaced(item, { claimed_root_cause: 'y' }), new Map())
  assert.deepEqual([mat.material, typeof mat.reason, mat.replace.claimed_root_cause], [['claimed_root_cause'], 'string', 'y'])
  assert.deepEqual(judgeVerifier(run.runDir, e2, replaced(item, { title: 'new' }), new Map()).material, [])
  for (const bad of [null, undefined, 0, 7, 'x', true, [], [passed(item)], {}, { decision: null }, { decision: ['verified'] }, { decision: 'replace' }, { decision: 'replace', reason: 'r', record: null }, { decision: 'replace', reason: 'r', record: [] }]) {
    const r = judgeVerifier(run.runDir, e2, bad, new Map())
    assert.ok(r.kind && !r.verified && !r.replace, JSON.stringify(bad))
    assert.ok(r.problems.every(p => typeof p === 'string' && p.length <= 300))
  }
})

console.log('== the size of a round')
await test('records go to Phase 5 in batches that fit one script: the first round takes what fits, the rest wait pending and run next round, and no script is over the ceiling', async () => {
  const defs = Array.from({ length: 12 }, (_, i) => ({ name: `n${i}`, candidates: [`fp-${String(i).padStart(2, '0')}`] }))
  const run = await atVerify(defs, undefined, (l, c) => verified(c.fingerprint, { description: 'd'.repeat(60_000) }))
  const sizes = []
  while (next(run.runDir) === 'NEXT: verify run=workflow') {
    const res = await verifyRound(run.runDir, (l, item) => passed(item))
    assert.equal(res.apply.status, 0, res.apply.stdout)
    sizes.push([res.input.items.length, statSync(join(res.dir, 'run.js')).size])
    assert.ok(sizes.length <= 6)
  }
  assert.ok(sizes.length >= 2, `more than one round: ${JSON.stringify(sizes)}`)
  assert.equal(sizes.reduce((n, [c]) => n + c, 0), 12)
  for (const [, bytes] of sizes) assert.ok(bytes < MAX_SCRIPT_BYTES, `${bytes} is under the guard`)
  assert.ok(MAX_VERIFY_BYTES < MAX_SCRIPT_BYTES)
  assert.deepEqual(decisions(run.runDir).entries.map(e => e.phase5.state), Array(12).fill('verified'))
  assert.equal(meta(run.runDir).run_status, 'complete')
  ok(run.runDir)
})
await test('a replacement of megabytes is discarded like any malformed result, so it is never applied and never written', async () => {
  const run = await atVerify(TWO)
  const r1 = await verifyRound(run.runDir, (l, item) => (item.fingerprint === 'fp-a' ? replaced(item, { description: 'd'.repeat(6_000_000) }) : passed(item)))
  assert.equal(r1.apply.status, 0, r1.apply.stdout)
  const e = entry(run.runDir, 'fp-a')
  assert.deepEqual([e.phase5.state, e.phase5.attempts.map(a => a.kind), e.phase5.replacement], ['pending', ['malformed'], null])
  assert.match(e.phase5.attempts[0].problems[0], /over the 65536 a record may hold/)
})
console.log('== the budget')
await test('records the budget cannot fund a Phase 5 verifier for are removed in fingerprint order with upstream\'s reason, the run is incomplete, and findings.json says so', async () => {
  const run = await atVerify([...TWO, { name: 'c', candidates: ['fp-c'] }], { args: ['--budget', '40'] })
  leaveAgents(run.runDir, 40, 2)
  const res = await verifyRound(run.runDir, (l, item) => passed(item))
  assert.deepEqual(res.input.items.map(i => i.fingerprint), ['fp-a', 'fp-b'])
  assert.equal(res.apply.status, 0, res.apply.stdout)
  assert.deepEqual(found(run.runDir).map(r => r.fingerprint), ['fp-a', 'fp-b'], 'fp-c has no verifier: it is not kept')
  const c = entry(run.runDir, 'fp-c')
  assert.deepEqual([c.phase5.state, c.phase5.reason], ['removed', 'validation_budget_exhausted'])
  assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['incomplete', 'validation_budget_exhausted'])
  assert.deepEqual(unitByName(run.runDir).c.unresolved, ['validation_budget_exhausted'])
  assert.equal(next(run.runDir), 'NEXT: report run=helper reason=validation_budget_exhausted')
  ok(run.runDir)
})
await test('with no agent left every record is removed at the plan: nobody is launched, the step is closed, findings.json is empty, and the run is incomplete', async () => {
  const run = await atVerify(TWO, { args: ['--budget', '40'] })
  leaveAgents(run.runDir, 40, 0)
  const r = stage(['plan', run.runDir])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL validation_budget_exhausted: 0 agent\(s\) are left of the budget \(--budget 40, 40 spent\) and 2 record\(s\) need a verifier; none was launched, they are removed from findings\.json, stay unresolved candidates in the ledger, and the run is marked incomplete/)
  assert.deepEqual(found(run.runDir), [])
  assert.deepEqual(stageDirs(run.runDir).filter(d => d.includes('verify')), [], 'no verify stage was written')
  assert.equal(next(run.runDir), 'NEXT: report run=helper reason=validation_budget_exhausted')
  ok(run.runDir)
})
await test('a replacement the budget cannot fund a new verifier for is removed with the record, not applied', async () => {
  const run = await atVerify(TWO, { args: ['--budget', '40'] })
  leaveAgents(run.runDir, 40, 2)
  await verifyRound(run.runDir, (l, item) => (item.fingerprint === 'fp-a' ? replaced(item, { claimed_root_cause: 'NEW' }) : passed(item)))
  assert.equal(meta(run.runDir).agents_spent, 40, 'the two verifiers were the last agents')
  const r = stage(['plan', run.runDir])
  assert.match(r.last, /^AUDIT: FAIL validation_budget_exhausted: 0 agent\(s\) are left/)
  assert.deepEqual(found(run.runDir).map(x => x.fingerprint), ['fp-b'])
  assert.ok(!JSON.stringify(found(run.runDir)).includes('NEW'))
  assert.equal(next(run.runDir), 'NEXT: report run=helper reason=validation_budget_exhausted')
})
await test('a round of first tries that every verifier failed is refused without using a try; a round of retries that all fail uses it', async () => {
  const run = await atVerify(TWO)
  const r1 = await verifyRound(run.runDir, () => null)
  assert.equal(r1.apply.status, 1)
  assert.match(r1.apply.last, /^AUDIT: FAIL every verifier of the round returned nothing .*no try was used \(2 agent\(s\) spent\): plan the stage again to retry it/)
  assert.deepEqual(decisions(run.runDir).entries.map(e => [e.phase5.state, e.phase5.attempts.length]), [['pending', 0], ['pending', 0]])
  const r2 = await verifyRound(run.runDir, (l, item) => (item.fingerprint === 'fp-a' ? passed(item) : null))   // one succeeds: now a failure counts
  assert.equal(r2.apply.status, 0, r2.apply.stdout)
  const b = entry(run.runDir, 'fp-b')
  assert.deepEqual([b.phase5.state, b.phase5.attempts.map(a => [a.id, a.kind])], ['pending', [['r02', 'no_result']]], 'one try used')
  const r3 = await verifyRound(run.runDir, () => null)   // a round of retries that all fail: the second try is used, and that ends the loop
  assert.deepEqual(r3.input.items.map(i => i.agent_id), ['r02-t2'])
  assert.equal(r3.apply.status, 0, r3.apply.stdout)
  assert.match(r3.apply.last, /removed=1 pending=0/)
  assert.equal(meta(run.runDir).incomplete_reason, 'record_verification_unresolved')
})

console.log('== records Phase 5 does not read, and the end of the run')
await test('a run whose records are all rejected never plans verify: write ended it complete, and next goes to the report', async () => {
  const run = toValidate(TWO)
  const refute = c => ({ decision: 'rejected', record: { verdict: 'rejected', fingerprint: c.fingerprint, title: 'T', description: 'd', claimed_root_cause: 'r', trace: [{ kind: 'sink', file: 'src/app.js', line: 1, scope: 'a', description: 'x' }], evidence: [{ file: 'src/app.js', line: 1, description: 'e' }], reason: 'refuted' } })
  assert.equal((await round(run.runDir, (l, c) => refute(c))).apply.status, 0)
  writeFindings(run.runDir)
  assert.equal(next(run.runDir), 'NEXT: report run=helper')
  assert.equal(meta(run.runDir).run_status, 'complete')
  assert.match(stage(['plan', run.runDir]).last, /^AUDIT: FAIL the next step is not a Workflow stage: NEXT: report/)
  assert.ok(decisions(run.runDir).entries.every(e => e.phase5 === null), 'Phase 5 never read a rejected record')
  ok(run.runDir)
})
await test('an incomplete run still verifies the records it keeps, and ends incomplete: the budget stop of an earlier stage is not lost when Phase 5 passes', async () => {
  const run = await atVerify(TWO)
  markIncomplete(run.runDir, 'critic_budget_exhausted')
  const res = await verifyRound(run.runDir, (l, item) => passed(item))
  assert.equal(res.apply.status, 0, res.apply.stdout)
  assert.match(res.apply.stdout, /^note: the run is incomplete \(critic_budget_exhausted\): it stays so, and the report discloses why$/m)
  assert.deepEqual([meta(run.runDir).run_status, meta(run.runDir).incomplete_reason], ['incomplete', 'critic_budget_exhausted'], 'the first reason stands')
  assert.equal(next(run.runDir), 'NEXT: report run=helper reason=critic_budget_exhausted')
  ok(run.runDir)
})
await test('verify runs only as the next step, and a stage applied against a plan that went stale is refused', async () => {
  const run = await atVerify(TWO)
  const res = await verifyRound(run.runDir, (l, item) => passed(item))
  assert.equal(res.apply.status, 0)
  assert.match(stage(['plan', run.runDir]).last, /^AUDIT: FAIL the next step is not a Workflow stage: NEXT: report/)
})

console.log('== crash windows and mutation')
await test('a crash after the effects landed and before the step was saved is finished by applying the same result again: nothing is judged twice, the cost is recorded once, findings.json is the same', async () => {
  const run = await atVerify(TWO)
  const snap = snapshot(run.runDir)
  const plan = stage(['plan', run.runDir])
  const dir = stageDirOf(plan, run.runDir)
  const input = readJsonFile(dir, 'input.json')
  const ran = await runScript(join(dir, 'run.js'), { 'audit-researcher': input.items.map(() => (p, opts) => (opts.label === 'r01' ? replaced(input.items[0], { title: 'Reworded' }) : passed(input.items[1]))) })
  const file = returnedFile(dir, ran.result)
  assert.equal(stage(['apply', run.runDir, file]).status, 0)
  const after = [readFileSync(join(run.runDir, 'findings.json'), 'utf8'), readFileSync(join(run.runDir, 'decisions.json'), 'utf8'), readFileSync(join(run.runDir, 'agent-history.json'), 'utf8'), ledgerBytes(run.runDir)]
  writeFileSync(join(run.runDir, 'stage-state.json'), snap.get('stage-state.json'))   // the step save never happened
  assert.equal(next(run.runDir), 'NEXT: verify run=workflow')
  const again = stage(['apply', run.runDir, file])
  assert.equal(again.status, 0, again.stdout)
  assert.deepEqual([readFileSync(join(run.runDir, 'findings.json'), 'utf8'), readFileSync(join(run.runDir, 'decisions.json'), 'utf8'), readFileSync(join(run.runDir, 'agent-history.json'), 'utf8'), ledgerBytes(run.runDir)], after)
  assert.equal(next(run.runDir), 'NEXT: report run=helper')
  assert.equal(meta(run.runDir).agents_spent, 2 + 2, 'recorded once per stage key')
  ok(run.runDir)
})
await test('independence is asserted again at apply: a hunter ID written into the history after the plan makes apply refuse, and nothing changes', async () => {
  const run = await atVerify(TWO)
  const plan = stage(['plan', run.runDir])
  const dir = stageDirOf(plan, run.runDir)
  const input = readJsonFile(dir, 'input.json')
  const ran = await runScript(join(dir, 'run.js'), { 'audit-researcher': input.items.map(() => (p, opts) => passed(input.items.find(i => i.agent_id === opts.label))) })
  const h = readJsonFile(run.runDir, 'agent-history.json')
  h.fingerprints['fp-a'] = h.fingerprints['fp-a'].filter(e => e.role !== 'verifier').concat([{ role: 'hunter', id: 'r01' }])
  writeFileSync(join(run.runDir, 'agent-history.json'), JSON.stringify(h))
  const file = returnedFile(dir, ran.result)
  const before = snapshot(run.runDir)
  const r = stage(['apply', run.runDir, file])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL agent r01 already served as hunter of fp-a: it cannot also be its verifier/)
  assert.deepEqual(snapshot(run.runDir), before)
})
await test('a crash after a record was removed and before findings.json was rewritten is finished by applying the same result again: the file loses the record, the ledger and the run say why, and verify is not wedged', async () => {
  for (const withReplacement of [false, true]) {
    const name = withReplacement ? 'beside a replacement applied in the same round' : 'alone'
    const run = await atVerify([...TWO, { name: 'c', candidates: ['fp-c'] }])
    // round 1: fp-a's result is unusable (a second try is due); fp-b proposes a material replacement when the case wants one
    await verifyRound(run.runDir, (l, item) => (item.fingerprint === 'fp-a' ? null : item.fingerprint === 'fp-b' && withReplacement ? replaced(item, { claimed_root_cause: 'NEW ROOT' }) : passed(item)))
    // round 2 is the one whose effects a crash cuts in half: fp-a is removed, and fp-b's replacement is verified and applied
    const snap = snapshot(run.runDir)
    const plan = stage(['plan', run.runDir])
    const dir = stageDirOf(plan, run.runDir)
    const input = readJsonFile(dir, 'input.json')
    assert.deepEqual(input.items.map(i => i.agent_id), withReplacement ? ['r01-t2', 'x02'] : ['r01-t2'], name)
    const ran = await runScript(join(dir, 'run.js'), { 'audit-researcher': input.items.filter(i => i.kind === 'phase5').map(() => () => null), 'audit-analyst': input.items.filter(i => i.kind === 'replacement').map(i => () => passed(i)) })
    const file = returnedFile(dir, ran.result)
    const stale = readFileSync(join(run.runDir, 'findings.json'), 'utf8')
    assert.equal(stage(['apply', run.runDir, file]).status, 0, name)
    const done = found(run.runDir)
    assert.deepEqual(done.map(r => r.fingerprint), ['fp-b', 'fp-c'], name)
    // the crash: decisions, history, spend and the incomplete mark were written; the ledger, findings.json and the step were not
    writeFileSync(join(run.runDir, 'findings.json'), stale)
    writeFileSync(join(run.runDir, 'stage-state.json'), snap.get('stage-state.json'))
    writeFileSync(join(run.runDir, 'coverage-ledger.json'), snap.get('coverage-ledger.json'))
    const again = stage(['apply', run.runDir, file])
    assert.equal(again.status, 0, `${name}: ${again.stdout}`)
    assert.deepEqual(found(run.runDir), done, `${name}: the removed record is out of findings.json and the applied replacement is in it`)
    assert.deepEqual(unitByName(run.runDir).a.unresolved, ['record_verification_unresolved'], `${name}: the ledger says why`)
    assert.equal(next(run.runDir), 'NEXT: report run=helper reason=record_verification_unresolved', name)
    assert.deepEqual(completeProblems(run.runDir).problems.filter(p => /not the decided records/.test(p)), [], `${name}: the file is the decided records`)
    ok(run.runDir)
  }
})
await test('complete-check finds a findings.json that holds a record Phase 5 removed, or lacks one it kept: the file is the decided records, exactly', async () => {
  const run = await atVerify(TWO)
  assert.equal((await verifyRound(run.runDir, (l, item) => passed(item))).apply.status, 0)
  assert.deepEqual(completeProblems(run.runDir).problems, [])
  const d = decisions(run.runDir)
  writeFileSync(join(run.runDir, 'decisions.json'), JSON.stringify({ ...d, entries: d.entries.map(e => (e.fingerprint === 'fp-a' ? { ...e, phase5: { ...e.phase5, state: 'removed', reason: 'record_verification_unresolved' } } : e)) }))
  assert.ok(completeProblems(run.runDir).problems.some(p => /findings\.json is not the decided records/.test(p)), 'a removed record is still in the file')
  writeFileSync(join(run.runDir, 'decisions.json'), JSON.stringify(d))
  writeFileSync(join(run.runDir, 'findings.json'), JSON.stringify(found(run.runDir).filter(r => r.fingerprint !== 'fp-b')))
  assert.ok(completeProblems(run.runDir).problems.some(p => /findings\.json is not the decided records/.test(p)), 'a kept record is missing from the file')
})
await test('a result with a verifier missing, an ID the plan did not make, or the wrong shape is refused whole, and a tampered plan is refused; nothing changes', async () => {
  const run = await atVerify(TWO)
  const plan = stage(['plan', run.runDir])
  const dir = stageDirOf(plan, run.runDir)
  const input = readJsonFile(dir, 'input.json')
  const goodResult = (await runScript(join(dir, 'run.js'), { 'audit-researcher': input.items.map(() => (p, opts) => passed(input.items.find(i => i.agent_id === opts.label))) })).result
  const shapes = [
    { ...goodResult, results: { part: 'verify', verifiers: { r01: passed(input.items[0]) } } },
    { ...goodResult, results: { part: 'verify', verifiers: { r01: passed(input.items[0]), r02: passed(input.items[1]), r03: null } } },
    { ...goodResult, results: { part: 'verify', verifiers: { r01: passed(input.items[0]), r09: passed(input.items[1]) } } },
    { ...goodResult, results: { part: 'verify', verifiers: { r01: 'x', r02: 7 } } },
    { ...goodResult, results: { part: 'verify', verifiers: [null, null] } },
    { ...goodResult, results: { part: 'verify' } },
    { ...goodResult, results: { part: 'validate', verifiers: goodResult.results.verifiers } },
  ]
  for (const bad of shapes) {
    const file = returnedFile(dir, bad)
    const before = snapshot(run.runDir)
    assert.equal(stage(['apply', run.runDir, file]).status, 1, JSON.stringify(bad.results).slice(0, 80))
    assert.deepEqual(snapshot(run.runDir), before, 'not one byte changed')
  }
  const tampered = JSON.parse(JSON.stringify(input))
  tampered.items[0].agent_id = 'r05'
  writeFileSync(join(dir, 'input.json'), JSON.stringify(tampered))
  const r = stage(['apply', run.runDir, returnedFile(dir, { ...goodResult, results: { part: 'verify', verifiers: { r05: passed(input.items[0]), r02: passed(input.items[1]) } } })])
  assert.match(r.last, /^AUDIT: FAIL r05 is not the verifier planned for fp-a \(that is r01\): plan the stage again/)
})
await test('a good result with one field of any depth deleted or replaced by the wrong type is refused or applied, never a crash, and the run still passes check', async () => {
  const run = await atVerify(TWO)
  const plan = stage(['plan', run.runDir])
  const dir = stageDirOf(plan, run.runDir)
  const input = readJsonFile(dir, 'input.json')
  const goodResult = (await runScript(join(dir, 'run.js'), { 'audit-researcher': input.items.map(() => (p, opts) => (opts.label === 'r01' ? replaced(input.items[0], { title: 'Reworded' }) : passed(input.items[1]))) })).result
  const out = fuzzApply(run.runDir, goodResult, dir, 120)
  assert.equal(out.ok + out.refused, 120)
  assert.ok(out.refused > 0 && out.ok > 0, JSON.stringify(out))
  assert.ok(ledgerValid(run.runDir))
})
