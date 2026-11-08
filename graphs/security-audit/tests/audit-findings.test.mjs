// audit-findings.test.mjs - the rules of Phases 3-5 (audit-findings.mjs): agent IDs and the independence history, the verdict transitions, the
// materiality comparator (table-driven), and what a record must be before anything keeps it, judged by the real vendored validator.
// The stages are in audit-verdicts.test.mjs; write, link-check and complete-check in audit-findings-write.test.mjs.
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { MATERIAL_FIELDS, ROLES, VERDICTS, agentId, emptyHistory, historyOf, historyProblems, isMaterial, materialChanges, recordAgent, recordProblems, transitionProblem } from '../skills/security-audit/audit-findings.mjs'
import { isSafeAgentId } from '../skills/security-audit/upstream.mjs'
import { fresh } from './audit-fixtures.mjs'
import { confirmedRecord, needsValidationRecord, rejectedRecord } from './ledger-fixtures.mjs'
import { FILES, newInit } from './stage-fixtures.mjs'

const UNSAFE = ['con', 'nul', 'com1', '../x', 'a/b', 'A', 'V01', '', ' ', 'v 1', 'x'.repeat(65), '-v1', '_v1', 'v1\n', 'v1\0', null, undefined, 0, 7, {}, [], ['v01'], true]

console.log('== agent IDs')
await test('an ID is the kind, the candidate number to two digits, then -r<round> and -t<try> when they are past the first; every one is a safe agent ID', () => {
  assert.equal(agentId('v', 1), 'v01')
  assert.equal(agentId('r', 12), 'r12')
  assert.equal(agentId('x', 3), 'x03')
  assert.equal(agentId('v', 3, { attempt: 2 }), 'v03-t2')
  assert.equal(agentId('x', 3, { round: 2 }), 'x03-r2')
  assert.equal(agentId('x', 3, { round: 2, attempt: 2 }), 'x03-r2-t2')
  assert.equal(agentId('v', 123), 'v123', 'three digits past 99, never truncated')
  const all = new Set()
  for (const kind of ['v', 'r', 'x']) for (const n of [1, 9, 10, 99, 100, 5000]) for (const round of [1, 2, 3]) for (const attempt of [1, 2, 3]) {
    const id = agentId(kind, n, { round, attempt })
    assert.ok(isSafeAgentId(id), id)
    assert.ok(!all.has(id), `${id} is unique`)
    all.add(id)
  }
})
await test('a kind, number, round or try that is not what it says is a TypeError, never an ID', () => {
  for (const kind of ['', 'h', 'V', 'vv', null, 1, undefined, {}]) assert.throws(() => agentId(kind, 1), TypeError, String(kind))
  for (const n of [0, -1, 1.5, NaN, Infinity, '1', null, undefined, {}, [], 2 ** 53]) assert.throws(() => agentId('v', n), TypeError, String(n))
  for (const bad of [0, -1, 1.5, '2', null, NaN]) { assert.throws(() => agentId('v', 1, { round: bad }), TypeError); assert.throws(() => agentId('v', 1, { attempt: bad }), TypeError) }
})

console.log('== independence history')
await test('recording is pure, idempotent for the same agent, and keeps every role of a fingerprint apart', () => {
  const h0 = emptyHistory()
  const h1 = recordAgent(h0, 'fp-a', 'hunter', 'h1-01')
  assert.deepEqual(h0, emptyHistory(), 'the input is not changed')
  const h2 = recordAgent(recordAgent(recordAgent(h1, 'fp-a', 'validator', 'v01'), 'fp-a', 'verifier', 'r01'), 'fp-a', 'replacer', 'x01')
  assert.deepEqual(h2.fingerprints['fp-a'].map(e => [e.role, e.id]), [['hunter', 'h1-01'], ['validator', 'v01'], ['verifier', 'r01'], ['replacer', 'x01']])
  assert.deepEqual(recordAgent(h2, 'fp-a', 'validator', 'v01'), h2, 'planning the same verifier again after a crash changes nothing')
  assert.equal(new Set(h2.fingerprints['fp-a'].map(e => e.id)).size, 4, 'the four roles are four distinct IDs')
  assert.deepEqual(historyProblems(h2), [])
  assert.deepEqual(ROLES, ['hunter', 'validator', 'verifier', 'replacer'])
})
await test('an ID that already served a fingerprint in another role is refused, whichever pair of roles', () => {
  for (const [first, second] of [['hunter', 'validator'], ['hunter', 'verifier'], ['hunter', 'replacer'], ['validator', 'verifier'], ['validator', 'replacer'], ['verifier', 'replacer'], ['verifier', 'validator'], ['replacer', 'hunter']]) {
    const h = recordAgent(emptyHistory(), 'fp', first, 'v01')
    assert.throws(() => recordAgent(h, 'fp', second, 'v01'), /agent v01 already served as .* of fp: it cannot also be its/, `${first} then ${second}`)
  }
})
await test('a verifier\'s ID is one candidate\'s: it cannot serve a second fingerprint, in any role, but a hunter may hunt many', () => {
  const h = recordAgent(emptyHistory(), 'fp-a', 'validator', 'v01')
  assert.throws(() => recordAgent(h, 'fp-b', 'validator', 'v01'), /already served fp-a as validator: only a hunter may serve two fingerprints/)
  assert.throws(() => recordAgent(h, 'fp-b', 'hunter', 'v01'), /already served fp-a as validator/)
  const hunter = recordAgent(emptyHistory(), 'fp-a', 'hunter', 'h1-01')
  assert.throws(() => recordAgent(hunter, 'fp-b', 'validator', 'h1-01'), /already served fp-a as hunter/, 'a hunter never verifies')
  const both = recordAgent(hunter, 'fp-b', 'hunter', 'h1-01')
  assert.deepEqual(Object.keys(both.fingerprints), ['fp-a', 'fp-b'])
  assert.deepEqual(historyProblems(both), [])
})
await test('unsafe agent IDs are refused by name (con, ../x, a 65-character ID, an upper-case ID, null, numbers, objects) and a bad role or fingerprint is a TypeError', () => {
  for (const id of UNSAFE) assert.throws(() => recordAgent(emptyHistory(), 'fp', 'validator', id), /is not a safe agent ID/, JSON.stringify(id))
  for (const role of ['', 'Hunter', 'verifier ', null, 1, {}, undefined]) assert.throws(() => recordAgent(emptyHistory(), 'fp', role, 'v01'), TypeError)
  for (const fp of ['', '  ', null, 0, {}, [], undefined]) assert.throws(() => recordAgent(emptyHistory(), fp, 'validator', 'v01'), TypeError)
})
await test('fingerprints that are also object property names, or that look like a path and a line, are ordinary keys', () => {
  let h = emptyHistory()
  for (const fp of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'src/app.js:12', 'a/../b', 'fp.1', 'authz:users/update@v2']) {
    h = recordAgent(h, fp, 'hunter', 'h1-01')
    h = recordAgent(h, fp, 'validator', `v${String(Object.keys(h.fingerprints).length).padStart(2, '0')}`)
  }
  assert.equal(Object.keys(h.fingerprints).length, 8)
  assert.deepEqual(h.fingerprints.constructor.map(e => e.role), ['hunter', 'validator'])
  assert.deepEqual(historyProblems(h), [])
})
await test('historyProblems finds an ID in two roles of one fingerprint and a verifier under two fingerprints in a history nobody refused', () => {
  const bad = { version: 1, fingerprints: { a: [{ role: 'hunter', id: 'x1' }, { role: 'validator', id: 'x1' }], b: [{ role: 'validator', id: 'v1' }], c: [{ role: 'validator', id: 'v1' }], d: [{ role: 'hunter', id: 'h1-01' }], e: [{ role: 'hunter', id: 'h1-01' }] } }
  assert.deepEqual(historyProblems(bad), ['a: agent x1 is both hunter and validator', 'agent v1 is recorded under b and c'])
})
await test('historyOf reads no file as an empty history and refuses one that is not what the stages wrote', () => {
  const dir = fresh('hist')
  assert.deepEqual(historyOf(dir), emptyHistory())
  const bad = [null, [], 'x', 7, {}, { version: 2, fingerprints: {} }, { version: 1 }, { version: 1, fingerprints: [] }, { version: 1, fingerprints: { a: {} } }, { version: 1, fingerprints: { a: [null] } },
    { version: 1, fingerprints: { a: [{ role: 'boss', id: 'v1' }] } }, { version: 1, fingerprints: { a: [{ role: 'validator', id: '../x' }] } }, { version: 1, fingerprints: { a: [{ role: 'validator', id: 'con' }] } }]
  for (const content of bad) {
    writeFileSync(join(dir, 'agent-history.json'), JSON.stringify(content))
    assert.throws(() => historyOf(dir), /agent-history\.json is not what the stages wrote/, JSON.stringify(content))
  }
  writeFileSync(join(dir, 'agent-history.json'), '{')
  assert.throws(() => historyOf(dir), /not valid JSON/)
  const good = recordAgent(emptyHistory(), 'fp', 'validator', 'v01')
  writeFileSync(join(dir, 'agent-history.json'), JSON.stringify(good))
  assert.deepEqual(historyOf(dir), good)
})

console.log('== verdict transitions')
await test('the transition table: needs_validation and confirmed may be kept as needs_validation or rejected, and nothing ends in confirmed', () => {
  const odd = ['bogus', null, 7, {}]
  const table = []
  for (const from of [...VERDICTS, ...odd]) for (const to of [...VERDICTS, ...odd]) table.push([from, to, transitionProblem(from, to)])
  const verdict = (from, to) => table.find(r => r[0] === from && r[1] === to)[2]
  assert.equal(verdict('needs_validation', 'needs_validation'), null)
  assert.equal(verdict('needs_validation', 'rejected'), null)
  assert.equal(verdict('confirmed', 'needs_validation'), null, 'demotion')
  assert.equal(verdict('confirmed', 'rejected'), null)
  assert.match(verdict('needs_validation', 'confirmed'), /needs_validation to confirmed is not possible here: it needs an independently established bounded observed local result/)
  assert.match(verdict('confirmed', 'confirmed'), /confirmed to confirmed is not possible here/)
  for (const from of ['rejected', ...odd]) for (const to of VERDICTS) assert.match(verdict(from, to), /record is not verified: only a proposed confirmed or needs_validation is/, `${from} -> ${to}`)
  for (const to of odd) for (const from of VERDICTS) assert.match(verdict(from, to), /is not a verdict/, `${from} -> ${to}`)
  assert.equal(table.filter(([from, to, p]) => to === 'confirmed' && p === null).length, 0, 'no pair reaches confirmed')
})

console.log('== materiality')
const NV = () => needsValidationRecord('fp-m')
const CF = () => confirmedRecord('fp-m')
const edit = (r, f) => { const c = JSON.parse(JSON.stringify(r)); f(c); return c }
const traceOf = file => [{ kind: 'entrypoint', file, line: 1, scope: 'handler', description: 'A request arrives.' }, { kind: 'propagation', file, line: 1, scope: 'helper', description: 'It is passed on.' }, { kind: 'sink', file, line: 1, scope: 'write', description: 'The write happens.' }]
await test('wording and line edits are not material: title, descriptions, evidence, conditions, remediation, confidence, blockers, plans, a trace step\'s line or description', () => {
  const nonMaterial = [
    ['title', r => { r.title = 'A different title' }],
    ['description', r => { r.description = 'Entirely new wording of the same thing.' }],
    ['evidence description', r => { r.evidence[0].description = 'worded again' }],
    ['evidence line and file', r => { r.evidence[0].line = 9; r.evidence[0].file = 'src/db.js' }],
    ['a trace step line', r => { r.trace[0].line = 77 }],
    ['a trace step description', r => { r.trace[0].description = 'worded again' }],
    ['both at once', r => { r.trace[0].line = 5; r.trace[0].description = 'x'; r.title = 'y' }],
  ]
  for (const make of [NV, CF]) for (const [name, f] of nonMaterial) assert.deepEqual(materialChanges(make(), edit(make(), f)), [], `${make().verdict}: ${name}`)
  const nvOnly = [['blockers', r => { r.blockers = ['another blocker'] }], ['validation_plan', r => { r.validation_plan = { local: 'a different fixture', deployment: 'ask the owner' } }]]
  for (const [name, f] of nvOnly) assert.equal(isMaterial(NV(), edit(NV(), f)), false, name)
  const cfOnly = [['conditions', r => { r.conditions = [{ kind: 'data_state', description: 'x' }] }], ['remediation', r => { r.remediation = { strategy: 'check ownership differently', code_changes: [{ file_name: 'src/app.js', fixed_code: 'x' }] } }],
    ['confidence', r => { r.confidence = { score: 'low', reason: 'less sure' } }], ['intended_behavior', r => { r.intended_behavior = 'worded again' }], ['likelihood reason', r => { r.severity.likelihood.reason = 'worded again' }],
    ['execution.attacker_perspective', r => { r.execution.attacker_perspective = 'worded again' }]]
  for (const [name, f] of cfOnly) assert.equal(isMaterial(CF(), edit(CF(), f)), false, name)
  assert.equal(isMaterial(NV(), NV()), false)
  assert.equal(isMaterial(CF(), JSON.parse(JSON.stringify(CF()))), false)
})
await test('a change of verdict, in any direction, is material', () => {
  const [nv, cf, rj] = [NV(), CF(), rejectedRecord('fp-m')]
  for (const [a, b] of [[nv, cf], [cf, nv], [nv, rj], [rj, nv], [cf, rj], [rj, cf]]) assert.deepEqual(materialChanges(a, b), ['verdict', ...materialChanges(a, b).filter(f => f !== 'verdict')], `${a.verdict} -> ${b.verdict}`)
  for (const [a, b] of [[nv, cf], [cf, nv], [nv, rj], [rj, nv], [cf, rj], [rj, cf]]) assert.ok(isMaterial(a, b), `${a.verdict} -> ${b.verdict}`)
})
await test('a changed root cause, trace shape, execution input or result, impact or severity is material; each field is the one named', () => {
  const material = [
    ['root_cause', CF, r => { r.root_cause = 'another root cause' }],
    ['claimed_root_cause', NV, r => { r.claimed_root_cause = 'another claimed root cause' }],
    ['trace (a file)', NV, r => { r.trace[0].file = 'src/db.js' }],
    ['trace (a kind)', NV, r => { r.trace[0].kind = 'entrypoint' }],
    ['trace (a scope)', NV, r => { r.trace[0].scope = 'elsewhere' }],
    ['trace (a step added)', NV, r => { r.trace = traceOf('src/app.js') }],
    ['trace (the order)', NV, r => { r.trace = traceOf('src/app.js'); r.trace.reverse() }],
    ['trace (a step removed)', CF, r => { r.trace = []; }],
    ['execution.payloads', CF, r => { r.execution.payloads = ['another payload'] }],
    ['execution.instructions', CF, r => { r.execution.instructions = ['another step'] }],
    ['execution.observed_result', CF, r => { r.execution.observed_result = 'a different result' }],
    ['severity.impact (the score)', CF, r => { r.severity.impact.score = 'high' }],
    ['severity.impact (the reason)', CF, r => { r.severity.impact.reason = 'a different reason' }],
    ['severity.overall_severity', CF, r => { r.severity.overall_severity = 'low' }],
    ['severity.likelihood.score', CF, r => { r.severity.likelihood.score = 'high' }],
  ]
  assert.deepEqual(material.map(m => m[0].replace(/ \(.*\)/, '')).filter((v, i, a) => a.indexOf(v) === i).sort(), ['claimed_root_cause', 'execution.instructions', 'execution.observed_result', 'execution.payloads', 'root_cause', 'severity.impact', 'severity.likelihood.score', 'severity.overall_severity', 'trace'])
  for (const [name, make, f] of material) {
    const changes = materialChanges(make(), edit(make(), f))
    assert.deepEqual(changes, [name.replace(/ \(.*\)/, '')], name)
  }
  assert.deepEqual(Object.keys(MATERIAL_FIELDS), ['verdict', 'root_cause', 'claimed_root_cause', 'trace', 'execution.payloads', 'execution.instructions', 'execution.observed_result', 'severity.impact', 'severity.overall_severity', 'severity.likelihood.score'], 'the one table, in this order')
})
await test('anything that is not a record is material, and a missing field on both sides is not a difference', () => {
  for (const bad of [null, undefined, 0, 7, 'x', [], [NV()], true]) { assert.deepEqual(materialChanges(bad, NV()), ['record']); assert.deepEqual(materialChanges(NV(), bad), ['record']); assert.ok(isMaterial(bad, bad)) }
  assert.deepEqual(materialChanges({}, {}), [])
  assert.deepEqual(materialChanges({ trace: 'x' }, { trace: 'x' }), [])
  assert.deepEqual(materialChanges({ trace: [null, 7] }, { trace: [null, 8] }), ['trace'], 'a malformed step compares as itself, it never throws')
})

console.log('== a record must be what the vendored validator and the snapshot say')
const { runDir } = newInit()
const nv = (over = {}) => ({ ...needsValidationRecord('fp-r'), ...over })
await test('a good needs_validation record has no problem, and a severity on it fails the vendored validator', () => {
  assert.deepEqual(recordProblems(runDir, nv()), [])
  assert.deepEqual(recordProblems(runDir, nv(), { fingerprint: 'fp-r', verdict: 'needs_validation' }), [])
  const problems = recordProblems(runDir, nv({ severity: { overall_severity: 'high' } }))
  assert.ok(problems.some(p => /needs_validation finding must not contain "severity"/.test(p)), problems.join('; '))
  assert.ok(recordProblems(runDir, nv({ execution: {} })).some(p => /must not contain "execution"/.test(p)))
  assert.ok(recordProblems(runDir, nv({ reason: 'x' })).length > 0)
})
await test('shape problems come from the real validator: a missing field, an unknown field, a wrong trace order, an empty blockers list, a path that is not repository-relative', () => {
  const cases = [
    [{ title: undefined }, /missing required field "title"/], [{ surprise: 1 }, /unexpected field "surprise"/], [{ blockers: [] }, /blockers/],
    [{ trace: [{ kind: 'sink', file: 'src/app.js', line: 1, scope: 'a', description: 'x' }, { kind: 'entrypoint', file: 'src/app.js', line: 1, scope: 'b', description: 'y' }] }, /trace/],
    [{ trace: [{ kind: 'sink', file: '/etc/passwd', line: 1, scope: 'a', description: 'x' }] }, /file|path/], [{ trace: [{ kind: 'sink', file: '../x', line: 1, scope: 'a', description: 'x' }] }, /file|path/],
    [{ trace: [{ kind: 'sink', file: 'src/app.js', line: 0, scope: 'a', description: 'x' }] }, /line/], [{ fingerprint: '-bad' }, /fingerprint/], [{ validation_plan: {} }, /validation_plan|plan/],
  ]
  for (const [over, re] of cases) {
    const rec = nv(over)
    for (const k of Object.keys(over)) if (over[k] === undefined) delete rec[k]
    const problems = recordProblems(runDir, rec)
    assert.ok(problems.length > 0 && problems.some(p => re.test(p)), `${JSON.stringify(over)}: ${problems.join('; ')}`)
  }
})
await test('anything that is not an object is a problem, never an exception: null, numbers, arrays, strings, a result wrapped in prose', () => {
  for (const bad of [null, undefined, 0, 7, 'x', [], [nv()], true, 'Here is the record: ' + JSON.stringify(nv()), { decision: 'needs_validation', record: nv() }]) {
    const problems = recordProblems(runDir, bad)
    assert.ok(problems.length > 0, JSON.stringify(bad)?.slice(0, 60))
  }
})
await test('the fingerprint and the verdict the record must have are checked, and a schema-valid confirmed record is still refused in v1', () => {
  assert.deepEqual(recordProblems(runDir, nv(), { fingerprint: 'other' }), ['the fingerprint is "fp-r", not "other"'])
  assert.deepEqual(recordProblems(runDir, nv(), { verdict: 'rejected' }), ['the record\'s verdict is "needs_validation", not "rejected"'])
  const confirmed = confirmedRecord('fp-r')
  assert.deepEqual(recordProblems(runDir, confirmed), ['the record is confirmed, and no bounded observed local result can exist in this audit'])
  assert.deepEqual(recordProblems(runDir, rejectedRecord('fp-r'), { fingerprint: 'fp-r', verdict: 'rejected' }), [])
})
await test('a record is bounded to what a candidate may be: one over 64 KiB is refused before the validator reads it, so no verifier can write megabytes into decisions.json and findings.json', () => {
  assert.deepEqual(recordProblems(runDir, nv({ description: 'd'.repeat(30_000) })), [], 'a large record under the bound is fine')
  const huge = recordProblems(runDir, nv({ description: 'd'.repeat(6_000_000) }))
  assert.match(huge[0], /^the record is \d+ bytes, over the 65536 a record may hold$/)
  assert.equal(huge.length, 1)
  assert.match(recordProblems(runDir, nv({ blockers: Array.from({ length: 2000 }, (_, i) => `blocker ${i} ${'b'.repeat(40)}`) }))[0], /over the 65536 a record may hold/)
})
await test('every trace and evidence file must be a regular file of the snapshot and every line within it; a directory, a missing file and a line past the end are named', () => {
  const at = (file, line) => nv({ trace: [{ kind: 'sink', file, line, scope: 'a', description: 'x' }], evidence: [{ file: 'src/app.js', line: 1, description: 'e' }] })
  assert.deepEqual(recordProblems(runDir, at('src/app.js', 1)), [])
  assert.deepEqual(recordProblems(runDir, at('src/lines.js', 5)), [], 'the last line of a five-line file')
  assert.match(recordProblems(runDir, at('src/lines.js', 6))[0], /"src\/lines.js" has 5 line\(s\)/)
  assert.match(recordProblems(runDir, at('src/app.js', 2))[0], /has 1 line\(s\)/)
  assert.match(recordProblems(runDir, at('src/nope.js', 1))[0], /"src\/nope.js" is not in tree\/ \(the audited snapshot\)/)
  assert.match(recordProblems(runDir, at('src', 1))[0], /is a directory, not a file/)
  assert.match(recordProblems(runDir, at('src/empty.txt', 1))[0], /has 0 line\(s\)/)
  const ev = nv({ evidence: [{ file: 'src/gone.js', line: 1, description: 'e' }] })
  assert.match(recordProblems(runDir, ev)[0], /not in tree\//, 'evidence is checked like the trace')
  assert.ok(Object.keys(FILES).includes('src/lines.js'))
})
