// audit-quick-mint-duplicate.test.mjs - a quick gap on a unit the ledger already has. Quick pins every unit's subsystem reference, so a gap on an already-seeded
// surface x boundary x attack class gets that unit's coverage ID, and the minter, free to label it, words its labels differently (RECONNAISSANCE.md: the reference is
// the identity, "even if its display label changes"). That used to fail apply-critic with a coverage ID collision, twice, and end the run (ledger_validation_failed)
// though P-04 only ever records such a gap as deferred. In quick the same ID is a duplicate: counted, not added, with a note, as an identical one always was.
// Standard and deep keep upstream's rule: the same ID under different labels is a collision, and the run fails rather than merge.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { applyCritic, applyCriticProblems } from '../skills/security-audit/audit-ledger.mjs'
import { audit, meta, mkRepo } from './audit-fixtures.mjs'
import { driveAudit } from './e2e-driver.mjs'
import { ledgerValid, readLedger, refsOf } from './ledger-fixtures.mjs'
import { TOY_FILES } from './toy-app.mjs'
import { QUICK_UNITS, quickAnswer } from './profile-e2e-support.mjs'
import { afterWave, byName, critic, gap, quickUnit, QUICK_DEFERRED, QUICK_REF } from './profile-support.mjs'

console.log('== quick: a gap on a unit the ledger already has')

const readJson = f => JSON.parse(readFileSync(f, 'utf8'))
const lastEvent = runDir => JSON.parse(readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').at(-1))

// ---------- the real path: a whole quick audit whose minter relabels a unit the seed already has ----------
// The toy's first proposal (the critic's routing gap) comes back as the notes unit the synthesizer seeded: the same references, new labels. The second proposal is minted as usual.
const NOTES = QUICK_UNITS[0]
const relabelled = { ...NOTES, surface: 'DELETE /notes/:id', boundary: 'the notes handler', subsystem: 'notes deletion' }
const relabelling = (label, ctx) => {
  const answer = quickAnswer(label, ctx)
  return /^synth-mintf?\d+$/.test(label) ? { units: [relabelled, ...answer.units.slice(1)] } : answer
}

// The drive itself is the first thing the fix changes (it refused the mint twice), so it is awaited inside the tests: a refusal fails them, and the unit tests below still run.
const driven = driveAudit({ repo: mkRepo(TOY_FILES, 'toy'), answer: relabelling, initArgs: ['--profile', 'quick', '--max-parallel', '2'] })
driven.catch(() => {})
const run = async () => driven
const kindsOf = trace => trace.map(s => `${s.step}${s.next.match(/kind=(\S+)/) ? `:${s.next.match(/kind=(\S+)/)[1]}` : ''}`)

await test('the quick run does not end: the minter\'s relabelled unit is a duplicate, the other gap is deferred, and the run completes on quick\'s own path', async () => {
  const { RUN, trace } = await run()
  assert.deepEqual(kindsOf(trace), ['recon', 'recon', 'seed', 'plan-wave', 'hunt', 'merge-wave', 'critic:post-wave', 'mint', 'apply-critic', 'consolidate', 'validate', 'write-findings', 'report', 'done'])
  const m = meta(RUN)
  assert.deepEqual([m.run_status, m.incomplete_reason], ['complete', null])
  assert.equal(audit(['check', RUN]).last, `AUDIT: OK ${RUN} passes check`)
  assert.ok(ledgerValid(RUN))
})
await test('the ledger keeps the seeded unit as it was (its own labels), adds the one real gap as deferred, and counts the relabelled one as a duplicate', async () => {
  const { RUN } = await run()
  const ledger = readJson(join(RUN, 'coverage-ledger.json'))
  assert.equal(ledger.length, QUICK_UNITS.length + 1, 'four seeded units and one gap')
  const notes = ledger.filter(u => u.canonical_refs.surface === NOTES.canonical_refs.surface && u.canonical_refs.boundary === NOTES.canonical_refs.boundary)
  assert.equal(notes.length, 1, 'one unit under that ID')
  assert.deepEqual([notes[0].surface, notes[0].subsystem], [NOTES.surface, NOTES.subsystem], 'the seeded labels, not the minter\'s')
  assert.deepEqual(ledger.filter(u => u.status === 'deferred').map(u => [u.surface, u.unresolved]), [['caller identity', [QUICK_DEFERRED]]])
  const applied = readFileSync(join(RUN, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(e => e.cmd === 'apply-critic')
  assert.deepEqual([applied.counts.duplicates, applied.counts.units_added, applied.counts.minted_rejected], [1, 1, 0])
})

// ---------- the same decision, unit by unit ----------
// A quick ledger of two quick-shaped units, past its first wave; `mint` is what the minter returned for one proposal.
const quickRun = () => afterWave([quickUnit('a'), quickUnit('b')], { profile: 'quick' })
const reworded = (name, over = {}) => quickUnit(name, { surface: `reworded ${name}`, boundary: `reworded boundary of ${name}`, subsystem: 'reworded subsystem', ...over })
const oneGap = { missing_units: [gap('g')] }

await test('quick: a minted unit with an existing unit\'s ID is a duplicate whatever its labels: the dry run passes, apply-critic adds nothing, and the unit keeps its labels', () => {
  const { runDir } = quickRun()
  const before = byName(readLedger(runDir)).a
  assert.deepEqual(applyCriticProblems(runDir, critic(oneGap), { units: [reworded('a')] }), [], 'the dry run, which the mint stage asks before it saves a minter result, accepts it')
  const out = applyCritic(runDir, critic(oneGap), { units: [reworded('a')] })
  assert.match(out.summary, / units_added=0 /, out.summary)
  assert.ok(out.notes.some(n => /minted unit 0: .* is already in the ledger; not added again/.test(n)), out.notes.join('\n'))
  const after = readLedger(runDir)
  assert.equal(after.length, 2)
  const a = byName(after).a
  assert.deepEqual([a.surface, a.boundary, a.subsystem, a.coverage_id], [before.surface, before.boundary, before.subsystem, before.coverage_id])
  assert.equal(lastEvent(runDir).counts.duplicates, 1)
  assert.ok(ledgerValid(runDir))
})
await test('quick: two minted units in one application with one new ID are one unit and one duplicate, whatever their labels', () => {
  const { runDir } = quickRun()
  const first = quickUnit('c', { surface: 'first wording' }), second = quickUnit('c', { surface: 'second wording', subsystem: 'another label' })
  const out = applyCritic(runDir, critic({ missing_units: [gap('g'), gap('h')] }), { units: [first, second] })
  assert.match(out.summary, / units_added=1 /, out.summary)
  const c = readLedger(runDir).filter(u => u.canonical_refs.surface.endsWith('#c'))
  assert.deepEqual(c.map(u => [u.surface, u.status, u.unresolved]), [['first wording', 'deferred', [QUICK_DEFERRED]]])
})
await test('quick: a unit with a new ID is still added when it only looks like an existing one (same labels, other surface reference), and one with a lifecycle is still refused', () => {
  const { runDir } = quickRun()
  const twin = quickUnit('a', { canonical_refs: refsOf('twin', { subsystem: QUICK_REF }), surface: byName(readLedger(runDir)).a.surface, subsystem: 'x' })
  const out = applyCritic(runDir, critic(oneGap), { units: [twin] })
  assert.match(out.summary, / units_added=1 /, out.summary)
  assert.equal(readLedger(runDir).length, 3)
  const { runDir: other } = quickRun()
  const bad = applyCriticProblems(other, critic(oneGap), { units: [quickUnit('a', { lifecycle: 'delete', canonical_refs: refsOf('a', { subsystem: QUICK_REF, lifecycle: 'delete' }) })] })
  assert.ok(bad.some(p => /does not split units by lifecycle mode/.test(p)), bad.join('\n'))
})

for (const profile of ['standard', 'deep']) {
  await test(`${profile}: the same ID under different labels is still a coverage ID collision, which upstream never merges: the dry run says so and apply-critic fails, changing nothing`, () => {
    const { runDir } = afterWave([quickUnit('a'), quickUnit('b')], { profile })
    const ledgerBefore = readFileSync(join(runDir, 'coverage-ledger.json'), 'utf8')
    const problems = applyCriticProblems(runDir, critic(oneGap), { units: [reworded('a')] })
    assert.ok(problems.some(p => /coverage ID collision: minted unit 0 has the ID of a unit with different semantic fields/.test(p)), problems.join('\n'))
    assert.throws(() => applyCritic(runDir, critic(oneGap), { units: [reworded('a')] }), /coverage ID collision/)
    assert.equal(readFileSync(join(runDir, 'coverage-ledger.json'), 'utf8'), ledgerBefore)
  })
}
