// audit-ledger-critic.test.mjs - audit-ledger.mjs apply-critic: minted units accepted, deduplicated or refused; a reopened unit
// archived into attempts with a fresh owner; resolved prior leads; and the refusals that leave the ledger as it was.
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { applyCritic, applyCriticProblems, commitLedger, criticResultProblems, mergeWave, planWave } from '../skills/security-audit/audit-ledger.mjs'
import { advanceState } from '../skills/security-audit/audit-run.mjs'
import { audit, fresh, ledgerCli } from './audit-fixtures.mjs'
import { assignments, candidateOf, checkOf, coverAll, hunterResult, hunterUnit, ledgerBytes, ledgerValid, readJsonFile, readLedger, refsOf, seeded, unitInput } from './ledger-fixtures.mjs'

const named = (name, over = {}) => unitInput(name, { canonical_refs: refsOf(name, { subsystem: over.subsystem ?? 'src' }), ...over })
const byName = runDir => Object.fromEntries(readLedger(runDir).map(u => [u.canonical_refs.surface.split('#')[1], u]))
// A hunter-reported gap sits in the queue until mint has seen it.
const queueGap = runDir => writeFileSync(join(runDir, 'uncovered.json'), JSON.stringify([{ ...gap('queued'), hunter_id: 'h1-01', wave: 1 }]))
const critic = (over = {}) => ({ missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: false, ...over })
const gap = (surface, over = {}) => ({ surface, boundary: 'b', subsystem: 's', attack_class: 'a', starting_paths: ['src/db.js'], reason: 'a parallel path nobody owns', ...over })
// A minted unit: recon's shape, as the synthesizer returns it.
const minted = (name, over = {}) => named(name, { reason: 'source-backed coverage gap', ...over })
// Seeded, planned, hunted and merged (every unit covered unless `results` says otherwise), with the critic result saved: apply-critic is next.
function afterWave(units, { results = coverAll, kind = 'post-wave', opts } = {}) {
  const run = seeded(units, opts)
  planWave(run.runDir)
  advanceState(run.runDir, 'hunt')
  mergeWave(run.runDir, results(assignments(run.runDir), run.runDir))
  advanceState(run.runDir, 'critic', { critic_kind: kind })
  advanceState(run.runDir, 'mint')
  return run
}
const snapshot = runDir => ({ ledger: ledgerBytes(runDir), state: readFileSync(join(runDir, 'stage-state.json'), 'utf8'), queue: existsSync(join(runDir, 'uncovered.json')) ? readFileSync(join(runDir, 'uncovered.json'), 'utf8') : null })
const refused = (runDir, c, m, pattern) => {
  const before = snapshot(runDir)
  assert.throws(() => applyCritic(runDir, c, m), e => pattern.test(`${e.message}\n${(e.problems ?? []).join('\n')}`), `expected a refusal matching ${pattern}`)
  assert.deepEqual(snapshot(runDir), before, 'a refused apply-critic changes nothing')
}

console.log('== criticResultProblems: upstream\'s critic JSON, and only that')
await test('criticResultProblems accepts the critic JSON and names every way a result is not it: prose, a missing or mistyped list, an empty ID, a stop that is not a boolean', () => {
  assert.deepEqual(criticResultProblems(critic()), [])
  assert.deepEqual(criticResultProblems(critic({ missing_units: [gap('x')], reassign_ids: ['id'], resolved_prior_leads: ['fp'], stop: false })), [])
  for (const bad of [null, 'prose', 7, [], undefined]) assert.deepEqual(criticResultProblems(bad), ['the critic result is not a JSON object (a critic result wrapped in prose is not one)'])
  assert.deepEqual(criticResultProblems({}), ['critic.missing_units must be an array', 'critic.reassign_ids must be an array', 'critic.resolved_prior_leads must be an array', 'critic.stop must be true or false'])
  assert.deepEqual(criticResultProblems(critic({ reassign_ids: [5, ''] })), ['critic.reassign_ids must hold non-empty strings'])
  assert.deepEqual(criticResultProblems(critic({ resolved_prior_leads: [null] })), ['critic.resolved_prior_leads must hold non-empty strings'])
  assert.deepEqual(criticResultProblems(critic({ stop: 1 })), ['critic.stop must be true or false'])
})

console.log('== applyCriticProblems: what apply-critic would refuse as a whole, without writing')
await test('applyCriticProblems lists each reason apply-critic would refuse the whole apply for, writes nothing, and agrees with apply-critic', () => {
  const { runDir } = afterWave([named('a'), named('b', { subsystem: 'other' })])
  const before = snapshot(runDir)
  const ids = readLedger(runDir).map(u => u.coverage_id)
  const ok = { units: [minted('good')] }
  assert.deepEqual(applyCriticProblems(runDir, critic({ missing_units: [gap('g')] }), ok), [])
  const cases = [
    ['more units than proposals', critic({ missing_units: [gap('g')] }), { units: [minted('x'), minted('y')] }, /mint returned 2 unit\(s\) for 1 proposal\(s\)/],
    ['a collision with different semantic fields', critic({ missing_units: [gap('g')] }), { units: [named('a', { surface: 'Another display label', reason: 'r' })] }, /coverage ID collision: minted unit 0/],
    ['a critic result that is not the critic JSON', 'prose wrapped in text', ok, /the critic result is not a JSON object/],
    ['a critic with a missing list', { missing_units: [], stop: true }, ok, /critic\.reassign_ids must be an array/],
    ['a critic with a non-boolean stop', critic({ stop: 'yes' }), ok, /critic\.stop must be true or false/],
    ['a mint that is not { units }', critic(), { unit: [] }, /mint\.json must be an object/],
  ]
  for (const [what, c, m, pattern] of cases) {
    const problems = applyCriticProblems(runDir, c, m)
    assert.ok(problems.length > 0 && problems.some(p => pattern.test(p)), `${what}: ${JSON.stringify(problems).slice(0, 240)}`)
    assert.throws(() => applyCritic(runDir, c, m), e => pattern.test(`${e.message}\n${(e.problems ?? []).join('\n')}`), `${what}: apply-critic refuses it too`)
  }
  assert.deepEqual(snapshot(runDir), before, 'neither check changed a file')
  assert.deepEqual(readLedger(runDir).map(u => u.coverage_id), ids)
  applyCritic(runDir, critic({ missing_units: [gap('g')] }), ok)
  assert.ok(ledgerValid(runDir))
})
await test('applyCriticProblems also reports a minted unit apply-critic would reject one by one, so a gap the critic found is sent back instead of dropped; a duplicate or an out-of-scope unit is not a problem', () => {
  const { runDir } = afterWave([named('a')])
  const c = critic({ missing_units: [gap('g')] })
  for (const [what, unit, pattern] of [
    ['a starting path outside tree/', minted('x', { starting_paths: ['src/gone.js'] }), /minted unit 0: starting path src\/gone\.js is not in tree\/.*rejected/],
    ['a block that does not resolve', minted('x', { ordinary_attack_class_block: 'ATTACK-CLASSES.md#Made up' }), /minted unit 0: ordinary_attack_class_block: unknown block ATTACK-CLASSES\.md#Made up.*rejected/],
    ['a status a minted unit may not carry', minted('x', { status: 'covered' }), /minted unit 0: status "covered": a minted unit is planned work.*rejected/],
    ['canonical refs upstream refuses', minted('x', { canonical_refs: refsOf('x', { subsystem: 'e\u0301' }) }), /minted unit 0: .*canonical_refs\.subsystem: invalid canonical reference.*rejected/],
  ]) {
    const problems = applyCriticProblems(runDir, c, { units: [unit] })
    assert.ok(problems.some(p => pattern.test(p)), `${what}: ${JSON.stringify(problems).slice(0, 240)}`)
  }
  const existing = readLedger(runDir)[0]
  assert.deepEqual(applyCriticProblems(runDir, c, { units: [named('a', { reason: 'r' })] }), [], 'a unit already in the ledger is a note, not a problem')
  assert.deepEqual(applyCriticProblems(runDir, c, { units: [] }), [], 'a minter that returns nothing for a proposal is not a problem here')
  assert.ok(existing)
})
await test('applyCriticProblems also runs upstream\'s validator on the ledger apply-critic would write, and does not need apply-critic to be next', () => {
  const { runDir } = afterWave([named('a')])
  advanceState(runDir, 'critic', { critic_kind: 'post-wave' })   // as when the critic result is saved and mint has not run
  assert.deepEqual(applyCriticProblems(runDir, critic({ missing_units: [gap('g')] }), { units: [minted('good')] }), [])
  const tuple = name => minted(name, { surface: 'One surface', boundary: 'One boundary', subsystem: 'src', attack_class: 'One class' })
  const problems = applyCriticProblems(runDir, critic({ missing_units: [gap('p'), gap('q')] }), { units: [tuple('p'), tuple('q')] })
  assert.ok(problems.some(p => /semantic tuple|coverage ID/.test(p)), JSON.stringify(problems))
  assert.throws(() => applyCriticProblems(fresh('not-a-run'), critic(), { units: [] }), /has no run-metadata\.json/)
})

console.log('== apply-critic: minted units')
await test('a minted unit is added planned at wave 1 beside the evidence-bearing ones, the queue is drained, the step saved, and `next` plans the next wave', () => {
  const { runDir } = afterWave([named('a')])
  queueGap(runDir)
  const out = applyCritic(runDir, critic({ missing_units: [gap('consumer')] }), { units: [minted('consumer', { priority_class: 1 })] })
  assert.match(out.summary, /^wave=1 kind=post-wave units_added=1 out_of_scope=0 reassigned=0 resolved=0 rejected=0$/)
  const units = byName(runDir)
  assert.deepEqual([units.a.status, units.consumer.status, units.consumer.wave, units.consumer.prior_status, units.consumer.agent_id, units.consumer.priority_class], ['covered', 'planned', 1, 'none', null, 1])
  assert.ok(ledgerValid(runDir))
  assert.deepEqual(readJsonFile(runDir, 'uncovered.json'), [])
  assert.equal(readJsonFile(runDir, 'stage-state.json').last, 'apply-critic')
  assert.equal(audit(['next', runDir]).last, 'NEXT: plan-wave run=helper wave=2')
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
  const event = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1)
  assert.deepEqual([event.cmd, event.critic_kind, event.critic_stop, event.counts.units_added], ['apply-critic', 'post-wave', false, 1])
})
await test('a unit minted from a queued gap is accepted and the queue is emptied, even when the critic proposed nothing', () => {
  const { runDir } = afterWave([named('a')])
  queueGap(runDir)
  applyCritic(runDir, critic(), { units: [minted('queued')] })
  assert.equal(byName(runDir).queued.status, 'planned')
  assert.deepEqual(readJsonFile(runDir, 'uncovered.json'), [])
})
await test('a minted unit already in the ledger is not added twice; one with the same ID and other semantic fields is a collision and refuses the whole apply', () => {
  const { runDir } = afterWave([named('a')])
  const out = applyCritic(runDir, critic({ missing_units: [gap('a')] }), { units: [named('a', { reason: 'again' })] })
  assert.match(out.notes.join('\n'), /minted unit 0: .* is already in the ledger; not added again/)
  assert.equal(readLedger(runDir).length, 1)
  const run2 = afterWave([named('a')])
  const before = ledgerBytes(run2.runDir)
  refused(run2.runDir, critic({ missing_units: [gap('x')], reassign_ids: [readLedger(run2.runDir)[0].coverage_id] }), { units: [named('a', { surface: 'Another display label', reason: 'r' })] }, /coverage ID collision: minted unit 0 .*different semantic fields/)
  assert.equal(ledgerBytes(run2.runDir), before, 'the reassignment in the same call was not applied either')
})
await test('one semantic tuple under a second ID is refused by the validator, whatever the call also does', () => {
  const { runDir } = afterWave([named('a')])
  refused(runDir, critic({ missing_units: [gap('x')] }), { units: [minted('other', { surface: 'Route a' })] }, /semantic tuple already uses coverage ID/)
})
await test('a minted unit that is not valid is rejected and named while the others are applied: bad refs, a path outside tree/, a status it may not carry', () => {
  const { runDir } = afterWave([named('a')])
  const bad = [
    minted('nfd', { canonical_refs: refsOf('nfd', { subsystem: 'é' }) }), minted('nowhere', { starting_paths: ['src/gone.js'] }),
    minted('covered', { status: 'covered' }), minted('deferred', { status: 'deferred' }), 'prose', null, 7, minted('good'),
  ]
  const out = applyCritic(runDir, critic({ missing_units: bad.map((_, i) => gap(`m${i}`)) }), { units: bad })
  assert.match(out.summary, /units_added=1 .*rejected=7$/)
  assert.deepEqual(Object.keys(byName(runDir)).sort(), ['a', 'good'])
  assert.match(out.notes.join('\n'), /minted unit 0: .*canonical_refs\.subsystem: invalid canonical reference; rejected/)
  assert.match(out.notes.join('\n'), /minted unit 1: starting path src\/gone\.js is not in tree\/.*rejected/)
  assert.match(out.notes.join('\n'), /minted unit 2: status "covered": a minted unit is planned work/)
  assert.ok(ledgerValid(runDir))
})
await test('a minted unit that names a block that does not exist is rejected and named; the units beside it are applied', () => {
  const { runDir } = afterWave([named('a')])
  const bad = [
    minted('ghost', { selected_companion_blocks: ['WEB-PROTOCOL-AND-AUTH.md#Cache behavior'] }),
    minted('short', { ordinary_attack_class_block: 'ATTACK-CLASSES.md#Chained vulnerabilities' }),
    minted('good'),
  ]
  const out = applyCritic(runDir, critic({ missing_units: bad.map((_, i) => gap(`m${i}`)) }), { units: bad })
  assert.deepEqual(Object.keys(byName(runDir)).sort(), ['a', 'good'])
  assert.match(out.notes.join('\n'), /minted unit 0: selected_companion_blocks\[0\]: unknown block WEB-PROTOCOL-AND-AUTH\.md#Cache behavior.*; rejected/)
  assert.match(out.notes.join('\n'), /minted unit 1: ordinary_attack_class_block: unknown block ATTACK-CLASSES\.md#Chained vulnerabilities:.*; rejected/)
  assert.ok(ledgerValid(runDir))
})
await test('in a scoped run a gap outside the scope is recorded out_of_scope with the critic\'s reason, not assigned', () => {
  const files = { 'src/app.js': 'a\n', 'src/db.js': 'b\n', 'docs/guide.md': 'c\n' }
  const { runDir } = afterWave([named('a')], { opts: { files, args: ['--scope', 'src'] } })
  const out = applyCritic(runDir, critic({ missing_units: [gap('d1'), gap('d2')] }), { units: [minted('inside', { starting_paths: ['src/db.js'] }), minted('outside', { starting_paths: ['docs/guide.md'], reason: 'the guide describes an unscanned flow' })] })
  const units = byName(runDir)
  assert.deepEqual([units.inside.status, units.outside.status, units.outside.unresolved, units.outside.agent_id], ['planned', 'out_of_scope', ['the guide describes an unscanned flow'], null])
  assert.match(out.summary, /units_added=1 out_of_scope=1/)
  assert.ok(ledgerValid(runDir))
})
await test('a mint that returns more units than there were proposals is refused; fewer is allowed and said', () => {
  const { runDir } = afterWave([named('a')])
  refused(runDir, critic({ missing_units: [gap('one')] }), { units: [minted('x'), minted('y')] }, /mint returned 2 unit\(s\) for 1 proposal\(s\)/)
  const out = applyCritic(runDir, critic({ missing_units: [gap('one'), gap('two')] }), { units: [minted('x')] })
  assert.match(out.notes.join('\n'), /1 proposal\(s\) .* were not minted into a unit; they are dropped/)
  assert.deepEqual(Object.keys(byName(runDir)).sort(), ['a', 'x'])
})

console.log('== apply-critic: reassignment archives attempts and gives a fresh owner')
const EVIDENCE = u => ({ wave: u.wave, status: u.status, agent_id: u.agent_id, reviewed_paths: u.reviewed_paths, local_checks: u.local_checks, result_fingerprints: u.result_fingerprints, unresolved: u.unresolved })
await test('a covered, a candidate and a blocked unit are each archived exactly, then return to planned at wave 2 with empty live evidence', () => {
  const { runDir } = afterWave([named('cov'), named('cand'), named('blk')], { results: (assigned, dir) => {
    const [[agent]] = Object.entries(assigned)
    const ids = Object.fromEntries(readLedger(dir).map(u => [u.canonical_refs.surface.split('#')[1], u.coverage_id]))
    return { [agent]: hunterResult([hunterUnit(ids.cov, agent), hunterUnit(ids.cand, agent, { disposition: 'candidate', candidate_fingerprints: ['fp-1'] }), hunterUnit(ids.blk, agent, { disposition: 'blocked', unresolved: ['the parser is absent'] })], { candidates: [candidateOf('fp-1')] }) }
  } })
  const before = byName(runDir)
  assert.deepEqual([before.cov.status, before.cand.status, before.blk.status], ['covered', 'candidate', 'blocked'])
  const out = applyCritic(runDir, critic({ reassign_ids: [before.cov, before.cand, before.blk].map(u => u.coverage_id) }), { units: [] })
  assert.match(out.summary, /reassigned=3/)
  const after = byName(runDir)
  for (const name of ['cov', 'cand', 'blk']) {
    const u = after[name]
    assert.deepEqual(u.attempts.map(a => { const { reassignment_reason, ...rest } = a; return rest }), [EVIDENCE(before[name])], name)
    assert.match(u.attempts[0].reassignment_reason, /^the post-wave critic of wave 1 listed this unit in reassign_ids/)
    assert.deepEqual([u.status, u.wave, u.agent_id, u.reviewed_paths, u.local_checks, u.result_fingerprints, u.unresolved], ['planned', 2, null, [], [], [], []], name)
  }
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['next', runDir]).last, 'NEXT: plan-wave run=helper wave=2')
  assert.deepEqual(readJsonFile(runDir, 'candidates.json').map(c => c.fingerprint), ['fp-1'], 'the candidate stays in the pool: reassigning its unit does not unfind it')
})
await test('the next assignment is a fresh hunter, the archive is untouched by what that hunter writes, and a second reassignment appends', () => {
  const run = seeded([named('a')])
  const { runDir } = run
  const wave = results => { planWave(runDir); advanceState(runDir, 'hunt'); mergeWave(runDir, results(assignments(runDir))); advanceState(runDir, 'critic', { critic_kind: 'post-wave' }); advanceState(runDir, 'mint') }
  wave(coverAll)
  const first = readLedger(runDir)[0]
  assert.deepEqual([first.agent_id, first.wave], ['h1-01', 1])
  applyCritic(runDir, critic({ reassign_ids: [first.coverage_id] }), { units: [] })
  const archived = JSON.stringify(readLedger(runDir)[0].attempts[0])
  wave(assigned => { const [[agent, [id]]] = Object.entries(assigned); return { [agent]: hunterResult([hunterUnit(id, agent, { disposition: 'candidate', candidate_fingerprints: ['fp-2'], reviewed_paths: ['src/db.js'], checks: [checkOf(agent, ['src/db.js'], { invariant: 'second look' })] })], { candidates: [candidateOf('fp-2')] }) } })
  const second = readLedger(runDir)[0]
  assert.deepEqual([second.agent_id, second.status, second.wave, second.reviewed_paths, second.result_fingerprints], ['h2-01', 'candidate', 2, ['src/db.js'], ['fp-2']])
  assert.equal(JSON.stringify(second.attempts[0]), archived, 'the archive is append-only')
  assert.ok(second.local_checks.every(c => c.agent_id === 'h2-01'), 'a live check never carries the archived owner')
  applyCritic(runDir, critic({ reassign_ids: [second.coverage_id] }), { units: [] })
  const third = readLedger(runDir)[0]
  assert.deepEqual(third.attempts.map(a => [a.wave, a.agent_id, a.status]), [[1, 'h1-01', 'covered'], [2, 'h2-01', 'candidate']])
  assert.deepEqual([third.wave, third.status], [3, 'planned'])
  assert.ok(ledgerValid(runDir))
  assert.ok(new Set(third.attempts.map(a => a.agent_id)).size === 2)
})
await test('a unit that is not covered, candidate or blocked cannot be reassigned: it is named and left alone, while a legitimate id in the same call applies', () => {
  const files = { 'src/app.js': 'a\n', 'src/db.js': 'b\n' }
  const { runDir } = afterWave([named('cov'), named('wait', { status: 'deferred', reason: 'budget_cannot_reserve_critics_and_validation' }), named('na', { status: 'not_applicable', reason: 'no uploads' })], { opts: { files } })
  const units = byName(runDir)
  const out = applyCritic(runDir, critic({ reassign_ids: [units.cov.coverage_id, units.wait.coverage_id, units.na.coverage_id, 'no-such-unit', units.cov.coverage_id] }), { units: [] })
  assert.match(out.summary, /reassigned=1 .*rejected=3$/)
  assert.match(out.notes.join('\n'), /status deferred has no live evidence to archive; not applied/)
  assert.match(out.notes.join('\n'), /status not_applicable has no live evidence/)
  assert.match(out.notes.join('\n'), /reassign no-such-unit: no such unit/)
  const after = byName(runDir)
  assert.deepEqual([after.cov.status, after.cov.attempts.length, after.wait.status, after.wait.attempts, after.na.status], ['planned', 1, 'deferred', [], 'not_applicable'])
  assert.deepEqual(after.wait.unresolved, ['budget_cannot_reserve_critics_and_validation'], 'deferred is never collapsed into planned')
  assert.ok(ledgerValid(runDir))
})
await test('a reopened unit forgets its failure count, so one more failed result does not defer a unit that failed once before', () => {
  const { runDir } = afterWave([named('a')], { results: assigned => ({ [Object.keys(assigned)[0]]: null }) })
  assert.equal(readLedger(runDir)[0].failed_attempts, 1)
  applyCritic(runDir, critic(), { units: [] })
  planWave(runDir); advanceState(runDir, 'hunt')
  mergeWave(runDir, coverAll(assignments(runDir)))
  advanceState(runDir, 'critic', { critic_kind: 'post-wave' }); advanceState(runDir, 'mint')
  assert.equal(readLedger(runDir)[0].failed_attempts, 1, 'a success keeps the history')
  applyCritic(runDir, critic({ reassign_ids: [readLedger(runDir)[0].coverage_id] }), { units: [] })
  assert.equal(readLedger(runDir)[0].failed_attempts, undefined)
  assert.equal(readLedger(runDir)[0].last_failure, undefined)
  planWave(runDir); advanceState(runDir, 'hunt')
  mergeWave(runDir, { 'h3-01': null })
  const [u] = readLedger(runDir)
  assert.deepEqual([u.status, u.failed_attempts, u.attempts.length], ['planned', 1, 1], 'one failure of the new assignment is the first, not the second')
})
await test('the validator is the backstop for fresh owners: a live unit or check that reuses an archived owner, or an archive that is out of order, is refused', () => {
  const { runDir } = afterWave([named('a')])
  const [u] = readLedger(runDir)
  applyCritic(runDir, critic({ reassign_ids: [u.coverage_id] }), { units: [] })
  const [archived] = readLedger(runDir)
  const before = ledgerBytes(runDir)
  const evidence = { reviewed_paths: ['src/app.js'], local_checks: [checkOf('h1-01')] }
  const bad = {
    'the live owner is the archived owner': { ...archived, status: 'covered', agent_id: 'h1-01', ...evidence },
    'a live check is the archived owner\'s': { ...archived, status: 'covered', agent_id: 'h2-01', ...evidence },
    'the archive is not before the live wave': { ...archived, wave: 1 },
    'the archive repeats a wave': { ...archived, attempts: [archived.attempts[0], archived.attempts[0]], wave: 3 },
    'the archive holds a planned state': { ...archived, attempts: [{ ...archived.attempts[0], status: 'planned' }] },
    'the archive has no reason': { ...archived, attempts: [{ ...archived.attempts[0], reassignment_reason: '' }] },
  }
  for (const [what, unit] of Object.entries(bad)) {
    assert.throws(() => commitLedger(runDir, [unit]), /unchanged/, what)
    assert.equal(ledgerBytes(runDir), before, what)
  }
})

await test('a candidate whose unit was reopened is still a record to validate: `next` counts the fingerprint from the archive, not only from live candidate units', () => {
  // The unit is reopened and the second hunter closes it with no candidate. The lead lives in attempts and candidates.json only.
  const run = seeded([named('a')])
  const { runDir } = run
  const wave = results => { planWave(runDir); advanceState(runDir, 'hunt'); mergeWave(runDir, results(assignments(runDir))); advanceState(runDir, 'critic', { critic_kind: 'post-wave' }); advanceState(runDir, 'mint') }
  wave(assigned => { const [[agent, [id]]] = Object.entries(assigned); return { [agent]: hunterResult([hunterUnit(id, agent, { disposition: 'candidate', candidate_fingerprints: ['fp-lead'] })], { candidates: [candidateOf('fp-lead')] }) } })
  applyCritic(runDir, critic({ reassign_ids: [readLedger(runDir)[0].coverage_id] }), { units: [] })
  wave(coverAll)
  applyCritic(runDir, critic({ stop: true }), { units: [] })
  advanceState(runDir, 'critic', { critic_kind: 'final-clean' }); advanceState(runDir, 'mint')
  applyCritic(runDir, critic({ stop: true }), { units: [] })
  const [u] = readLedger(runDir)
  assert.deepEqual([u.status, u.result_fingerprints, u.attempts[0].result_fingerprints], ['covered', [], ['fp-lead']])
  assert.deepEqual(readJsonFile(runDir, 'candidates.json').map(c => c.fingerprint), ['fp-lead'])
  assert.equal(audit(['next', runDir]).last, 'NEXT: validate run=workflow', 'the lead in candidates.json must still go to a verifier')
})

await test('an apply-critic that died after the ledger and the queue were written, before its step was saved, is finished by running it again', () => {
  const { runDir } = afterWave([named('a')])
  queueGap(runDir)
  const c = critic(), m = { units: [minted('queued')] }
  applyCritic(runDir, c, m)
  const done = ledgerBytes(runDir)
  writeFileSync(join(runDir, 'stage-state.json'), JSON.stringify({ version: 1, last: 'mint', wave: 1, critic_kind: 'post-wave', updated: 'x' }))   // the crash: the queue is already empty
  const again = applyCritic(runDir, c, m)
  assert.equal(ledgerBytes(runDir), done)
  assert.match(again.notes.join('\n'), /already in the ledger/)
  assert.ok(!/dropped/.test(again.notes.join('\n')), 'an empty queue is not a proposal the mint dropped')
  assert.equal(readJsonFile(runDir, 'stage-state.json').last, 'apply-critic')
})
await test('the queue of hunter gaps is cleared only once the ledger holds what was made of it: a refused apply keeps every queued gap', () => {
  const { runDir } = afterWave([named('a')])
  queueGap(runDir)
  const queued = readFileSync(join(runDir, 'uncovered.json'), 'utf8')
  refused(runDir, critic({ missing_units: [gap('x')] }), { units: [minted('a', { surface: 'Another display label' })] }, /coverage ID collision/)
  assert.equal(readFileSync(join(runDir, 'uncovered.json'), 'utf8'), queued)
})

console.log('== apply-critic: prior leads')
await test('a prior lead named by the critic is marked resolved on its unit with who resolved it; an unknown fingerprint is said, not applied', () => {
  const { runDir } = afterWave([named('a'), named('b')])
  commitLedger(runDir, readLedger(runDir).map(u => (u.canonical_refs.surface.endsWith('#a') ? { ...u, prior_leads: [{ fingerprint: 'fp-old', verdict: 'needs_validation', carried: false }, { fingerprint: 'fp-keep', verdict: 'confirmed', carried: false }] } : u)))
  const out = applyCritic(runDir, critic({ resolved_prior_leads: ['fp-old', 'fp-unknown', 'fp-old'] }), { units: [] })
  assert.match(out.summary, /resolved=1/)
  assert.match(out.notes.join('\n'), /resolved_prior_leads fp-unknown: not a prior lead of any unit; not applied/)
  const leads = byName(runDir).a.prior_leads
  assert.deepEqual(leads.map(l => [l.fingerprint, l.resolved ?? null]), [['fp-old', { by: 'post-wave critic of wave 1', wave: 1 }], ['fp-keep', null]])
  assert.ok(ledgerValid(runDir))
})

console.log('== apply-critic: refusals leave every file as it was')
await test('a critic result that is not the upstream JSON is refused: prose, null, numbers, missing fields, wrong types', () => {
  const { runDir } = afterWave([named('a')])
  for (const bad of ['{"missing_units": []}', null, 7, [], true, undefined]) refused(runDir, bad, { units: [] }, /critic result is not a JSON object/)
  for (const [what, c, pattern] of [
    ['no missing_units', { reassign_ids: [], resolved_prior_leads: [], stop: false }, /critic\.missing_units must be an array/],
    ['reassign_ids not an array', critic({ reassign_ids: 'x' }), /critic\.reassign_ids must be an array/],
    ['stop not a boolean', critic({ stop: 'false' }), /critic\.stop must be true or false/],
    ['an id that is not text', critic({ reassign_ids: [7] }), /reassign_ids must hold non-empty strings/],
    ['an empty id', critic({ resolved_prior_leads: [''] }), /resolved_prior_leads must hold non-empty strings/],
  ]) refused(runDir, c, { units: [] }, pattern)
  for (const bad of [null, [], { units: 'x' }, {}, 'mint']) refused(runDir, critic(), bad, /mint\.json must be an object/)
})
await test('apply-critic needs a critic_kind and the right step: without one, before the critic or after it is applied, it is refused', () => {
  const { runDir } = afterWave([named('a')])
  writeFileSync(join(runDir, 'stage-state.json'), JSON.stringify({ version: 1, last: 'mint', wave: 1, critic_kind: null, updated: 'x' }))
  refused(runDir, critic(), { units: [] }, /no critic_kind/)
  const early = seeded([named('a')])
  assert.throws(() => applyCritic(early.runDir, critic(), { units: [] }), /apply-critic is not the next step of this run: NEXT: plan-wave/)
  const { runDir: done } = afterWave([named('a')])
  applyCritic(done, critic(), { units: [] })
  assert.throws(() => applyCritic(done, critic(), { units: [] }), /apply-critic is not the next step of this run/)
})
await test('an apply-critic that died after writing the ledger and before saving its step is finished by running it again, without a second archive', () => {
  const { runDir } = afterWave([named('a')])
  const [u] = readLedger(runDir)
  const c = critic({ reassign_ids: [u.coverage_id], missing_units: [gap('x')] }), m = { units: [minted('x')] }
  applyCritic(runDir, c, m)
  const done = ledgerBytes(runDir)
  writeFileSync(join(runDir, 'stage-state.json'), JSON.stringify({ version: 1, last: 'mint', wave: 1, critic_kind: 'post-wave', updated: 'x' }))   // the crash
  const again = applyCritic(runDir, c, m)
  assert.equal(ledgerBytes(runDir), done)
  assert.match(again.summary, /reassigned=0 .*rejected=1/)
  assert.equal(byName(runDir).a.attempts.length, 1)
})
await test('the final-clean critic: when it accepts nothing and no unit is planned, next moves on to validation; accepted work loops back to plan-wave', () => {
  const quiet = afterWave([named('a')], { kind: 'final-clean', results: assigned => { const [[agent, [id]]] = Object.entries(assigned); return { [agent]: hunterResult([hunterUnit(id, agent, { disposition: 'candidate', candidate_fingerprints: ['fp-1'] })], { candidates: [candidateOf('fp-1')] }) } } })
  applyCritic(quiet.runDir, critic({ stop: true }), { units: [] })
  assert.equal(audit(['next', quiet.runDir]).last, 'NEXT: validate run=workflow')
  const busy = afterWave([named('a')], { kind: 'final-clean' })
  applyCritic(busy.runDir, critic({ missing_units: [gap('x')] }), { units: [minted('x')] })
  assert.equal(audit(['next', busy.runDir]).last, 'NEXT: plan-wave run=helper wave=2')
})

console.log('== the command line')
await test('apply-critic on the command line: AUDIT: OK, a refusal listing its problems, and exit 2 for bad usage', () => {
  const { runDir } = afterWave([named('a')])
  const inputs = fresh('inputs')
  const file = (name, value) => { const f = join(inputs, name); writeFileSync(f, JSON.stringify(value)); return f }
  const bad = ledgerCli(['apply-critic', runDir, file('bad-critic.json', { missing_units: 1 }), file('mint0.json', { units: [] })])
  assert.equal(bad.status, 1)
  assert.match(bad.lines[0], /^ledger: critic\.missing_units must be an array/)
  assert.match(bad.last, /^AUDIT: FAIL apply-critic refused: \d+ problem\(s\); nothing was changed$/)
  const ok = ledgerCli(['apply-critic', runDir, file('critic.json', critic({ missing_units: [gap('x')] })), file('mint.json', { units: [minted('x')] })])
  assert.deepEqual([ok.status, ok.last], [0, 'AUDIT: OK apply-critic wave=1 kind=post-wave units_added=1 out_of_scope=0 reassigned=0 resolved=0 rejected=0'])
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
  for (const args of [['apply-critic', runDir], ['apply-critic', runDir, 'a'], ['apply-critic', runDir, 'a', 'b', 'c']]) assert.equal(ledgerCli(args).status, 2, args.join(' '))
})
