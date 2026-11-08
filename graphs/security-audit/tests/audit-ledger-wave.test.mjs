// audit-ledger-wave.test.mjs - audit-ledger.mjs plan-wave and merge-wave: ranking, grouping and the budget; a hunter result
// folded into the ledger; a unit whose result failed returns to planned; the command line.
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { FAILED_TWICE, FINAL_CRITIC_RESERVE, MAX_UNIT_ATTEMPTS, applyCritic, commitLedger, criticBudgetExhausted, exhaustCriticBudget, groupIntoHunters, hunterId, isHunterWork, deferHunting, mergeWave, planWave, rankUnits, stopHunting } from '../skills/security-audit/audit-ledger.mjs'
import { REASONS, advanceState, recordSpend } from '../skills/security-audit/audit-run.mjs'
import { isSafeAgentId } from '../skills/security-audit/upstream.mjs'
import { audit, fresh, ledgerCli, newRun } from './audit-fixtures.mjs'
import { assignments, candidateOf, checkOf, coverAll, hunterResult, hunterUnit, ledgerBytes, ledgerValid, readJsonFile, readLedger, reconInput, refsOf, seeded, unitInput } from './ledger-fixtures.mjs'

const named = (name, over = {}) => unitInput(name, { canonical_refs: refsOf(name, { subsystem: over.subsystem ?? 'src' }), ...over })
const byName = runDir => Object.fromEntries(readLedger(runDir).map(u => [u.canonical_refs.surface.split('#')[1], u]))
// plan-wave then the session saving the hunt step: the point merge-wave starts from.
function hunting(units, opts) {
  const run = seeded(units, opts)
  planWave(run.runDir)
  advanceState(run.runDir, 'hunt')
  return { ...run, assigned: assignments(run.runDir) }
}
// What the critic, mint and apply-critic steps leave in stage-state.json (their own helpers come later): wave N is over.
const passCritic = runDir => { advanceState(runDir, 'critic', { critic_kind: 'post-wave' }); advanceState(runDir, 'mint'); advanceState(runDir, 'apply-critic') }
const withPrior = (runDir, prior) => commitLedger(runDir, readLedger(runDir).map(u => ({ ...u, prior_status: prior[u.canonical_refs.surface.split('#')[1]] ?? u.prior_status })))

console.log('== plan-wave: rank, group, assign')
await test('units are ranked by priority_class, then by id, grouped by subsystem at most max-units-per-hunter to a hunter, and set in_progress with their owner', () => {
  const { runDir } = seeded([
    named('P1a', { subsystem: 'api', priority_class: 3 }), named('P1b', { subsystem: 'api', priority_class: 1 }), named('P1c', { subsystem: 'api', priority_class: 2 }),
    named('Q1', { subsystem: 'web', priority_class: 1 }), named('R1', { subsystem: 'web', priority_class: 4 }),
  ], { args: ['--max-units-per-hunter', '2'] })
  const out = planWave(runDir)
  assert.equal(out.summary, 'wave=1 hunters=3 assigned=5 deferred=0')
  const units = byName(runDir)
  assert.deepEqual(Object.fromEntries(Object.entries(units).map(([k, u]) => [k, u.agent_id])), { P1b: 'h1-01', P1c: 'h1-01', Q1: 'h1-02', R1: 'h1-02', P1a: 'h1-03' })
  for (const u of Object.values(units)) assert.deepEqual([u.status, u.wave, u.reviewed_paths, u.local_checks, u.result_fingerprints, u.unresolved], ['in_progress', 1, [], [], [], []])
  assert.match(units.P1b.last_assignment, /^wave 1 h1-01: rank 1 of 5 \(priority_class 1, prior_status none\); 3 of 3 hunter\(s\) fit the budget$/)
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['next', runDir]).last, 'NEXT: hunt run=workflow wave=1')
  assert.equal(readJsonFile(runDir, 'stage-state.json').wave, 1)
  const event = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1)
  assert.deepEqual([event.cmd, event.counts, event.assignments.length], ['plan-wave', { hunters: 3, assigned: 5, deferred: 0, still_planned: 0 }, 3])
  assert.deepEqual(event.assignments[0], { agent_id: 'h1-01', coverage_ids: [units.P1b.coverage_id, units.P1c.coverage_id] })
})
await test('prior-run gaps and changed source come before new units, and same-source re-passes last; a unit a verifier owns is not hunter work', () => {
  const { runDir } = seeded(['gap', 'changed', 'fresh', 'same', 'carriedConfirmed', 'carriedNeedsValidation'].map(n => named(n, { priority_class: 2 })))
  withPrior(runDir, { gap: 'prior_blocked', changed: 'prior_covered_changed_source', same: 'prior_covered_same_source', carriedConfirmed: 'prior_confirmed_same_source', carriedNeedsValidation: 'prior_needs_validation' })
  const before = readLedger(runDir)
  assert.deepEqual(rankUnits(before.filter(isHunterWork)).map(u => u.canonical_refs.surface.split('#')[1]), ['changed', 'gap', 'fresh', 'same'])
  planWave(runDir)
  const units = byName(runDir)
  assert.deepEqual(['changed', 'gap', 'fresh', 'same'].map(n => units[n].agent_id), ['h1-01', 'h1-01', 'h1-01', 'h1-01'].slice(0, 4))
  assert.deepEqual([units.carriedConfirmed, units.carriedNeedsValidation].map(u => [u.status, u.agent_id]), [['planned', null], ['planned', null]])
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['next', runDir]).last, 'NEXT: hunt run=workflow wave=1', '`next` and plan-wave agree about which planned units are hunter work')
})
await test('a run whose only planned units are verifier-owned is not planned at all: next goes to the final critic and plan-wave refuses', () => {
  const { runDir } = seeded([named('only')])
  withPrior(runDir, { only: 'prior_needs_validation' })
  assert.equal(audit(['next', runDir]).last, 'NEXT: critic run=workflow kind=final-clean wave=1')
  assert.throws(() => planWave(runDir), /plan-wave is not the next step of this run: NEXT: critic/)
})
await test('rank ties break by coverage_id, so the same ledger plans the same wave every time', () => {
  const units = ['m', 'a', 'z', 'k'].map(n => named(n, { priority_class: 2, subsystem: n }))
  const first = seeded(units), second = seeded([...units].reverse())
  planWave(first.runDir); planWave(second.runDir)
  const shape = runDir => Object.entries(assignments(runDir)).map(([agent, ids]) => [agent, ids])
  assert.deepEqual(shape(first.runDir), shape(second.runDir))
  assert.deepEqual(shape(first.runDir).map(([, ids]) => ids[0]), [...first.ids])
})
await test('rankUnits and groupIntoHunters: equal ranks, one unit per hunter, a hunter larger than the list, and hunters ordered by their best unit', () => {
  const u = (name, subsystem, priority_class, prior_status = 'none') => ({ coverage_id: name, priority_class, prior_status, canonical_refs: { subsystem } })
  const units = [u('d', 'x', 1), u('c', 'y', 1), u('b', 'x', 2), u('a', 'y', 2), u('e', 'x', 3)]
  const ranked = rankUnits(units)
  assert.deepEqual(ranked.map(x => x.coverage_id), ['c', 'd', 'a', 'b', 'e'])
  assert.deepEqual(groupIntoHunters(ranked, 2).map(g => g.map(x => x.coverage_id)), [['c', 'a'], ['d', 'b'], ['e']])
  assert.deepEqual(groupIntoHunters(ranked, 1).map(g => g.map(x => x.coverage_id)), ['c', 'd', 'a', 'b', 'e'].map(x => [x]))
  assert.deepEqual(groupIntoHunters(ranked, 99).map(g => g.map(x => x.coverage_id)), [['c', 'a'], ['d', 'b', 'e']])
  assert.deepEqual(groupIntoHunters([], 4), [])
  assert.equal(rankUnits([{ coverage_id: 'x', prior_status: 'none', canonical_refs: {} }, { coverage_id: 'y', priority_class: 4, prior_status: 'none', canonical_refs: {} }])[0].coverage_id, 'x', 'a missing priority_class is the lowest, 4')
})
await test('hunter IDs match upstream\'s agent ID pattern and are unique across waves and hunters', () => {
  const seen = new Set()
  for (let wave = 1; wave <= 120; wave++) for (let n = 1; n <= 150; n++) { const id = hunterId(wave, n); assert.ok(isSafeAgentId(id), id); assert.ok(!seen.has(id), id); seen.add(id) }
  assert.equal(hunterId(2, 7), 'h2-07')
})

console.log('== plan-wave: the budget')
await test('a wave the reserves leave no room for launches no hunter and defers its planned units with upstream\'s reason', () => {
  const { runDir } = seeded([named('a'), named('b', { subsystem: 'other' })], { args: ['--budget', '10'] })
  recordSpend(runDir, 'earlier-stages', 7)   // 3 left: two critics and a verifier, no hunter
  const out = planWave(runDir)
  assert.match(out.summary, /^wave=1 hunters=0 assigned=0 deferred=2 reason=budget_cannot_reserve_critics_and_validation$/)
  assert.deepEqual(readLedger(runDir).map(u => [u.status, u.agent_id, u.unresolved, u.reviewed_paths]), Array(2).fill(['deferred', null, [REASONS.reserve], []]))
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['next', runDir]).last, 'NEXT: critic run=workflow kind=final-clean wave=1')
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
})
await test('a wave the budget only partly funds takes the best units first and leaves the rest planned for a later wave, never silently dropped', () => {
  const { runDir } = seeded(['a', 'b', 'c'].map((n, i) => named(n, { subsystem: n, priority_class: i + 1 })), { args: ['--budget', '10'] })
  recordSpend(runDir, 'earlier-stages', 6)   // 4 left: two critics, one verifier, one hunter
  assert.match(planWave(runDir).summary, /^wave=1 hunters=1 assigned=1 deferred=0$/)
  const units = byName(runDir)
  assert.deepEqual(['a', 'b', 'c'].map(n => units[n].status), ['in_progress', 'planned', 'planned'])
  assert.match(units.a.last_assignment, /1 of 3 hunter\(s\) fit the budget/)
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['next', runDir]).last, 'NEXT: hunt run=workflow wave=1')
})
await test('when the budget no longer covers the final critic, no hunter launches, every planned unit is deferred with upstream\'s reason, and the run is marked incomplete', () => {
  assert.equal(FINAL_CRITIC_RESERVE, 1)
  const { runDir } = seeded([named('a'), named('b', { subsystem: 'other' })], { args: ['--budget', '10'] })
  recordSpend(runDir, 'earlier-stages', 10)   // nothing left, not even the final-clean critic
  const out = planWave(runDir)
  assert.match(out.summary, /^wave=1 hunters=0 assigned=0 deferred=2 reason=critic_budget_exhausted$/)
  assert.deepEqual(readLedger(runDir).map(u => [u.status, u.agent_id, u.unresolved, u.reviewed_paths]), Array(2).fill(['deferred', null, [REASONS.critic], []]))
  assert.deepEqual([readJsonFile(runDir, 'run-metadata.json').run_status, readJsonFile(runDir, 'run-metadata.json').incomplete_reason], ['incomplete', 'critic_budget_exhausted'])
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
  assert.equal(audit(['next', runDir]).last, 'NEXT: write-findings run=helper', 'an incomplete run that was hunting stops there and goes on to what it found')
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual([events.at(-1).cmd, events.at(-1).reason], ['plan-wave', 'critic_budget_exhausted'])
})
await test('the final critic\'s reserve is the line: one agent left is the reserve reason, none left (or overspent) is the critic reason, and no budget is never either', () => {
  const at = (budget, spent) => {
    const { runDir } = seeded([named('a')], { args: budget === null ? [] : ['--budget', String(budget)] })
    recordSpend(runDir, 'earlier-stages', spent)
    return { runDir, out: planWave(runDir) }
  }
  const one = at(10, 9)
  assert.match(one.out.summary, /reason=budget_cannot_reserve_critics_and_validation$/)
  assert.equal(readJsonFile(one.runDir, 'run-metadata.json').run_status, 'in_progress', 'the final-clean critic still has its reserve: the run goes on to it')
  assert.equal(audit(['next', one.runDir]).last, 'NEXT: critic run=workflow kind=final-clean wave=1')
  assert.match(at(10, 10).out.summary, /reason=critic_budget_exhausted$/)
  assert.match(at(10, 14).out.summary, /reason=critic_budget_exhausted$/)
  assert.match(at(8, 8).out.summary, /reason=critic_budget_exhausted$/)
  assert.match(at(null, 500).out.summary, /^wave=1 hunters=1 assigned=1 deferred=0$/)
  assert.deepEqual([criticBudgetExhausted({ budget: null, agents_spent: 99 }), criticBudgetExhausted({ budget: 5, agents_spent: 4 }), criticBudgetExhausted({ budget: 5, agents_spent: 5 })], [false, false, true])
})
await test('exhaustCriticBudget outside plan-wave defers what is still planned, marks the run incomplete, saves no step, and is harmless twice; a unit a verifier owns is not deferred', () => {
  const { runDir } = seeded([named('a'), named('b', { subsystem: 'other' })], { args: ['--budget', '12', '--max-units-per-hunter', '1'] })
  recordSpend(runDir, 'earlier-stages', 8)   // 4 left: critics 2, validation 1, one hunter
  assert.match(planWave(runDir).summary, /^wave=1 hunters=1 assigned=1 deferred=0$/)
  advanceState(runDir, 'hunt')
  mergeWave(runDir, coverAll(assignments(runDir)))
  assert.deepEqual(readLedger(runDir).map(u => u.status).sort(), ['covered', 'planned'])
  const state = readFileSync(join(runDir, 'stage-state.json'), 'utf8')
  recordSpend(runDir, 'the-rest', 4)   // the hunter and the rest
  assert.equal(exhaustCriticBudget(runDir), 1)
  assert.deepEqual(readLedger(runDir).map(u => [u.status, u.unresolved]).sort((x, y) => (x[0] < y[0] ? -1 : 1)), [['covered', []], ['deferred', ['critic_budget_exhausted']]])
  assert.equal(readFileSync(join(runDir, 'stage-state.json'), 'utf8'), state, 'no step was saved')
  assert.equal(readJsonFile(runDir, 'run-metadata.json').incomplete_reason, 'critic_budget_exhausted')
  assert.equal(exhaustCriticBudget(runDir), 0, 'again: nothing left to defer, the reason unchanged')
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['next', runDir]).last, 'NEXT: write-findings run=helper')
})
await test('stopHunting defers the planned units with any reason it is given and marks the run incomplete with it; exhaustCriticBudget is that with upstream\'s reason', () => {
  const { runDir } = seeded([named('a'), named('b', { subsystem: 'other' })])
  assert.equal(stopHunting(runDir, 'ledger_validation_failed'), 2)
  assert.deepEqual(readLedger(runDir).map(u => [u.status, u.agent_id, u.unresolved]), Array(2).fill(['deferred', null, ['ledger_validation_failed']]))
  assert.deepEqual([readJsonFile(runDir, 'run-metadata.json').run_status, readJsonFile(runDir, 'run-metadata.json').incomplete_reason], ['incomplete', 'ledger_validation_failed'])
  assert.ok(ledgerValid(runDir))
  assert.equal(stopHunting(runDir, 'critic_budget_exhausted'), 0, 'nothing is left to defer, and the first reason stands')
  assert.equal(readJsonFile(runDir, 'run-metadata.json').incomplete_reason, 'ledger_validation_failed')
  assert.throws(() => stopHunting(runDir, ''), TypeError)
})
await test('deferHunting defers a wave that was planned and not run, in_progress units included, without ending the run; stopHunting does the same and marks the run incomplete', () => {
  const { runDir } = seeded([named('a'), named('b', { subsystem: 'other' }), named('c', { subsystem: 'third' })], { args: ['--max-parallel', '2'] })
  planWave(runDir)
  assert.deepEqual(readLedger(runDir).map(u => u.status), ['in_progress', 'in_progress', 'in_progress'])
  assert.equal(deferHunting(runDir, REASONS.reserve), 3)
  assert.deepEqual(readLedger(runDir).map(u => [u.status, u.agent_id, u.unresolved, u.reviewed_paths]), Array(3).fill(['deferred', null, [REASONS.reserve], []]))
  assert.equal(readJsonFile(runDir, 'run-metadata.json').run_status, 'in_progress')
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['next', runDir]).last, 'NEXT: critic run=workflow kind=final-clean wave=1', 'the retained final-clean critic records the gap')
  assert.equal(deferHunting(runDir, REASONS.reserve), 0, 'again: nothing left')
  const other = seeded([named('a')])
  planWave(other.runDir)
  assert.equal(stopHunting(other.runDir, REASONS.critic), 1)
  assert.equal(readJsonFile(other.runDir, 'run-metadata.json').run_status, 'incomplete')
})
await test('no budget set means no cap: every planned unit gets a hunter in the first wave', () => {
  const { runDir } = seeded(Array.from({ length: 9 }, (_, i) => named(`u${i}`, { subsystem: `s${i}` })))
  assert.match(planWave(runDir).summary, /^wave=1 hunters=9 assigned=9 deferred=0$/)
})
await test('plan-wave runs only as the next step: not before seed, not twice', () => {
  const { runDir } = seeded([named('a')])
  planWave(runDir)
  const before = ledgerBytes(runDir)
  assert.throws(() => planWave(runDir), /plan-wave is not the next step of this run: NEXT: hunt/)
  assert.equal(ledgerBytes(runDir), before)
  assert.throws(() => planWave(fresh('not-a-run')), /has no run-metadata\.json/)
})

console.log('== merge-wave: a hunter result folded into the ledger')
await test('covered, candidate and blocked stay three different states, each with only its own evidence; the step is saved and nothing is left in_progress', () => {
  const { runDir, assigned } = hunting([named('cov'), named('cand'), named('blk')])
  const [agent] = Object.keys(assigned)
  const ids = Object.fromEntries(readLedger(runDir).map(u => [u.canonical_refs.surface.split('#')[1], u.coverage_id]))
  const out = mergeWave(runDir, { [agent]: hunterResult([
    hunterUnit(ids.cov, agent),
    hunterUnit(ids.cand, agent, { disposition: 'candidate', candidate_fingerprints: ['fp-owner-check'], unresolved: ['deployment config unknown'] }),
    hunterUnit(ids.blk, agent, { disposition: 'blocked', unresolved: ['the generated parser is absent'] }),
  ], { candidates: [candidateOf('fp-owner-check')], hardening: ['add a lint rule for requireOwner'] }) })
  assert.match(out.summary, /^wave=1 merged=3 failed=0 deferred=0 candidates=1 uncovered_queued=0$/)
  const units = byName(runDir)
  assert.deepEqual([units.cov.status, units.cand.status, units.blk.status], ['covered', 'candidate', 'blocked'])
  assert.deepEqual([units.cov.result_fingerprints, units.cand.result_fingerprints, units.blk.result_fingerprints], [[], ['fp-owner-check'], []])
  assert.deepEqual([units.cov.unresolved, units.cand.unresolved, units.blk.unresolved], [[], ['deployment config unknown'], ['the generated parser is absent']])
  for (const u of Object.values(units)) assert.deepEqual([u.agent_id, u.reviewed_paths, u.local_checks.map(c => [c.agent_id, c.method, c.artifact])], [agent, ['src/app.js'], [[agent, 'source', null]]])
  assert.ok(ledgerValid(runDir))
  assert.equal(readJsonFile(runDir, 'stage-state.json').last, 'merge-wave')
  assert.equal(audit(['next', runDir]).last, 'NEXT: critic run=workflow kind=post-wave wave=1')
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
  const [pool] = readJsonFile(runDir, 'candidates.json')
  assert.deepEqual([pool.fingerprint, pool.proposed_verdict, pool.hunter_ids, pool.units], ['fp-owner-check', 'needs_validation', [agent], [ids.cand]])
  assert.equal(pool.record.proposed_verdict, undefined, 'the record keeps no proposed_verdict: the verdict is the validate stage\'s')
  assert.equal(pool.record.title, 'Unchecked owner on update')
  const hardened = Object.values(units).filter(u => u.hardening)
  assert.equal(hardened.length, 1, 'a hunter\'s hardening notes are kept once, on its first merged unit')
  assert.deepEqual(hardened[0].hardening, ['add a lint rule for requireOwner'])
})
await test('reviewed_paths are the union of the checks\' paths and a unit with two checks of two paths merges', () => {
  const { runDir, assigned } = hunting([named('a', { starting_paths: ['src/app.js', 'src/db.js'] })])
  const [[agent, [id]]] = Object.entries(assigned)
  mergeWave(runDir, { [agent]: hunterResult([hunterUnit(id, agent, { reviewed_paths: ['src/app.js', 'src/db.js'], checks: [checkOf(agent, ['src/app.js']), checkOf(agent, ['src/db.js'], { invariant: 'the query is parameterized' })] })]) })
  assert.deepEqual(readLedger(runDir)[0].local_checks.length, 2)
  assert.ok(ledgerValid(runDir))
})

const FAILURES = {
  'no result at all (the hunter died)': () => null,
  'a number': () => 42, 'prose': () => 'The hunter explained itself instead of returning JSON.', 'an array': () => [], 'true': () => true,
  'units missing': (r) => { delete r.units; return r }, 'candidates missing': (r) => { delete r.candidates; return r },
  'hardening missing': (r) => { delete r.hardening; return r }, 'uncovered missing': (r) => { delete r.uncovered; return r },
  'units not an array': (r) => ({ ...r, units: { 0: r.units[0] } }), 'uncovered not an array': (r) => ({ ...r, uncovered: 'none' }),
  'no entry for the unit': (r) => ({ ...r, units: [] }),
  'the unit listed twice': (r) => ({ ...r, units: [r.units[0], r.units[0]] }),
  'an entry that is not an object': (r) => ({ ...r, units: [7, null, 'x'] }),
  ...Object.fromEntries(['planned', 'in_progress', 'deferred', 'done', 'COVERED', 42, null, undefined].map(d => [`disposition ${String(d)}`, (r) => { r.units[0].disposition = d; return r }])),
  'a check owned by another agent': (r) => { r.units[0].checks[0].agent_id = 'h9-09'; return r },
  ...Object.fromEntries(['con', 'A', 'x'.repeat(65), '../x', '', 7].map(id => [`a check owner ${JSON.stringify(id)}`, (r) => { r.units[0].checks[0].agent_id = id; return r }])),
  'a local check with an artifact': (r, a) => { Object.assign(r.units[0].checks[0], { method: 'local', artifact: `agents/${a}/artifacts/out.txt` }); return r },
  'a source check with an artifact': (r, a) => { r.units[0].checks[0].artifact = `agents/${a}/artifacts/out.txt`; return r },
  'an unknown method': (r) => { r.units[0].checks[0].method = 'guess'; return r },
  'a covered unit with a fingerprint': (r) => { r.units[0].candidate_fingerprints = ['fp-x']; r.candidates = [candidateOf('fp-x')]; return r },
  'a candidate with no fingerprint': (r) => { r.units[0].disposition = 'candidate'; return r },
  'a candidate whose fingerprint has no entry': (r) => { Object.assign(r.units[0], { disposition: 'candidate', candidate_fingerprints: ['fp-missing'] }); return r },
  'a candidate entry using verdict': (r) => { Object.assign(r.units[0], { disposition: 'candidate', candidate_fingerprints: ['fp-v'] }); r.candidates = [{ ...candidateOf('fp-v'), verdict: 'needs_validation' }]; return r },
  'a candidate entry proposing rejected': (r) => { Object.assign(r.units[0], { disposition: 'candidate', candidate_fingerprints: ['fp-r'] }); r.candidates = [candidateOf('fp-r', { proposed_verdict: 'rejected' })]; return r },
  'a fingerprint with a space': (r) => { Object.assign(r.units[0], { disposition: 'candidate', candidate_fingerprints: ['fp bad'] }); r.candidates = [candidateOf('fp bad')]; return r },
  'a blocked unit with nothing unresolved': (r) => { r.units[0].disposition = 'blocked'; return r },
  'a covered unit with something unresolved': (r) => { r.units[0].unresolved = ['still unknown']; return r },
  'reviewed_paths that are not the checks\' union': (r) => { r.units[0].reviewed_paths = ['src/app.js', 'src/db.js']; return r },
  'a check path the unit does not list': (r) => { r.units[0].checks[0].reviewed_paths = ['src/db.js']; return r },
  'no reviewed_paths': (r) => { delete r.units[0].reviewed_paths; return r },
  'no checks': (r) => { r.units[0].checks = []; return r }, 'checks not an array': (r) => { r.units[0].checks = 'source'; return r },
  'a check that is not an object': (r) => { r.units[0].checks = [null]; return r },
  'a check with an empty invariant': (r) => { r.units[0].checks[0].invariant = ' '; return r },
  ...Object.fromEntries(['../x', '/etc/passwd', 'src/aux.ts', 'src\\app.js', 'src/app.js '].map(p => [`the unsafe path ${JSON.stringify(p)}`, (r) => { r.units[0].reviewed_paths = [p]; r.units[0].checks[0].reviewed_paths = [p]; return r }])),
  'a reviewed path that is not in the snapshot': (r) => { r.units[0].reviewed_paths = ['does/not/exist.js']; r.units[0].checks[0].reviewed_paths = ['does/not/exist.js']; return r },
  'a result over a thousand reviewed paths': (r) => { const p = Array.from({ length: 1001 }, (_, i) => `src/f${i}.js`); r.units[0].reviewed_paths = p; r.units[0].checks[0].reviewed_paths = p; return r },
}
await test('a unit whose result failed returns to planned with no owner, no evidence and a recorded reason; the ledger passes the validator', () => {
  for (const [what, mutate] of Object.entries(FAILURES)) {
    const { runDir, assigned } = hunting([named('a')])
    const [[agent, [id]]] = Object.entries(assigned)
    const good = hunterResult([hunterUnit(id, agent)])
    const out = mergeWave(runDir, { [agent]: mutate(good, agent) })
    const [u] = readLedger(runDir)
    assert.deepEqual([u.status, u.agent_id, u.reviewed_paths, u.local_checks, u.result_fingerprints, u.unresolved, u.failed_attempts], ['planned', null, [], [], [], [], 1], what)
    assert.equal(typeof u.last_failure, 'string', what)
    assert.match(out.summary, /merged=0 failed=1 deferred=0 candidates=0/, what)
    assert.ok(ledgerValid(runDir), what)
    assert.ok(!existsSync(join(runDir, 'candidates.json')) || readJsonFile(runDir, 'candidates.json').length === 0, `${what}: a failed unit adds no candidate`)
    assert.equal(audit(['next', runDir]).last, 'NEXT: critic run=workflow kind=post-wave wave=1', what)
  }
})
await test('a bad unit does not cost its hunter\'s good units, and a dead hunter does not cost another hunter\'s', () => {
  const { runDir, assigned } = hunting([named('g1', { subsystem: 'a' }), named('g2', { subsystem: 'a' }), named('bad', { subsystem: 'a' }), named('dead', { subsystem: 'b', priority_class: 4 })])
  const ids = Object.fromEntries(readLedger(runDir).map(u => [u.canonical_refs.surface.split('#')[1], u.coverage_id]))
  const [alive, dead] = [byName(runDir).g1.agent_id, byName(runDir).dead.agent_id]
  assert.notEqual(alive, dead)
  const out = mergeWave(runDir, { [alive]: hunterResult([hunterUnit(ids.g1, alive), hunterUnit(ids.g2, alive), hunterUnit(ids.bad, alive, { disposition: 'maybe' })]), [dead]: null })
  assert.match(out.summary, /merged=2 failed=2/)
  assert.deepEqual(Object.entries(byName(runDir)).map(([k, u]) => [k, u.status]).sort(), [['bad', 'planned'], ['dead', 'planned'], ['g1', 'covered'], ['g2', 'covered']])
  assert.equal(out.notes.length, 2)
  assert.match(out.notes.join('\n'), /disposition "maybe" is not covered, candidate, blocked; planned/)
  assert.ok(ledgerValid(runDir))
  assert.ok(assigned[alive].length === 3)
})
await test('a hunter that is missing from the results fails its units; entries for units it was not given are ignored and said so', () => {
  const { runDir, assigned } = hunting([named('mine', { subsystem: 'a' }), named('theirs', { subsystem: 'b' })])
  const ids = Object.fromEntries(readLedger(runDir).map(u => [u.canonical_refs.surface.split('#')[1], u.coverage_id]))
  const [first, second] = Object.keys(assigned)
  const mine = byName(runDir).mine.agent_id
  const out = mergeWave(runDir, { [mine]: hunterResult([hunterUnit(ids.mine, mine), hunterUnit(ids.theirs, mine), hunterUnit('not-a-unit-at-all', mine)]) })
  const units = byName(runDir)
  assert.deepEqual([units.mine.status, units.theirs.status, units.theirs.failed_attempts], ['covered', 'planned', 1])
  assert.match(out.notes.join('\n'), new RegExp(`${mine}: 2 result entries for units it was not assigned, ignored`))
  assert.ok(first && second)
})
await test('a second failed result defers the unit with a stated reason of PandaStack\'s own, and a retried unit gets a fresh owner', () => {
  assert.equal(MAX_UNIT_ATTEMPTS, 2)
  assert.equal(FAILED_TWICE, 'hunter_result_invalid_twice')
  assert.ok(!Object.values(REASONS).includes(FAILED_TWICE), 'upstream\'s reason strings are exactly upstream\'s')
  const { runDir, assigned } = hunting([named('a'), named('b', { subsystem: 'b' })])
  const first = Object.keys(assigned)
  mergeWave(runDir, Object.fromEntries(first.map(a => [a, null])))
  assert.deepEqual(readLedger(runDir).map(u => [u.status, u.failed_attempts]), [['planned', 1], ['planned', 1]])
  passCritic(runDir)
  assert.equal(audit(['next', runDir]).last, 'NEXT: plan-wave run=helper wave=2')
  planWave(runDir)
  const second = Object.keys(assignments(runDir))
  assert.deepEqual(second, ['h2-01', 'h2-02'])
  assert.ok(second.every(id => !first.includes(id)), 'a unit that failed is reassigned to a new hunter ID')
  advanceState(runDir, 'hunt')
  const [ida, idb] = readLedger(runDir).map(u => u.coverage_id)
  const owners = Object.fromEntries(readLedger(runDir).map(u => [u.coverage_id, u.agent_id]))
  mergeWave(runDir, { [owners[ida]]: null, [owners[idb]]: hunterResult([hunterUnit(idb, owners[idb])]) })
  const [a, b] = readLedger(runDir)
  assert.deepEqual([a.status, a.agent_id, a.unresolved, a.failed_attempts, b.status, b.failed_attempts], ['deferred', null, [FAILED_TWICE], 2, 'covered', 1])
  assert.equal(typeof a.last_failure, 'string')
  assert.ok(ledgerValid(runDir))
  passCritic(runDir)
  assert.equal(audit(['next', runDir]).last, 'NEXT: critic run=workflow kind=final-clean wave=2', 'a deferred unit is settled: nothing loops')
})

console.log('== merge-wave: candidates and uncovered')
await test('one fingerprint from two hunters is one candidate with both units and both hunters; re-merging adds nothing; an unlinked candidate is dropped', () => {
  const { runDir, assigned } = hunting([named('a', { subsystem: 'a' }), named('b', { subsystem: 'b' })])
  const [h1, h2] = Object.keys(assigned)
  const [ida, idb] = [assigned[h1][0], assigned[h2][0]]
  const link = (id, agent, extra = []) => hunterResult([hunterUnit(id, agent, { disposition: 'candidate', candidate_fingerprints: ['fp-same-root'] })], { candidates: [candidateOf('fp-same-root', { title: `from ${agent}` }), ...extra] })
  mergeWave(runDir, { [h1]: link(ida, h1), [h2]: link(idb, h2, [candidateOf('fp-orphan')]) })
  const pool = readJsonFile(runDir, 'candidates.json')
  assert.equal(pool.length, 1)
  assert.deepEqual([pool[0].fingerprint, pool[0].hunter_ids, pool[0].units, pool[0].record.title], ['fp-same-root', [h1, h2], [ida, idb].sort(), `from ${h1}`])
  assert.deepEqual(readLedger(runDir).map(u => u.result_fingerprints), [['fp-same-root'], ['fp-same-root']])
  const event = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1)
  assert.equal(event.counts.orphan_candidates, 1)
  assert.ok(ledgerValid(runDir))
})
await test('uncovered boundaries from a hunter whose units merged are queued once, malformed ones are counted and dropped, and a failed hunter queues none', () => {
  const gap = (surface, over = {}) => ({ surface, boundary: 'b', subsystem: 's', attack_class: 'a', starting_paths: ['src/db.js'], reason: 'a parallel path nobody owns', ...over })
  const { runDir, assigned } = hunting([named('a', { subsystem: 'a' }), named('b', { subsystem: 'b' })])
  const [h1, h2] = Object.keys(assigned)
  mergeWave(runDir, {
    [h1]: hunterResult([hunterUnit(assigned[h1][0], h1)], { uncovered: [gap('queue consumer'), gap('queue consumer'), gap('no reason', { reason: '' }), gap('bad paths', { starting_paths: 'x' }), 'nonsense', null] }),
    [h2]: hunterResult([hunterUnit(assigned[h2][0], h2, { disposition: 'nope' })], { uncovered: [gap('from a failed hunter')] }),
  })
  const queue = readJsonFile(runDir, 'uncovered.json')
  assert.deepEqual(queue.map(q => [q.surface, q.hunter_id, q.wave]), [['queue consumer', h1, 1]])
  const event = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1)
  assert.deepEqual([event.counts.dropped_uncovered, event.counts.uncovered_queued], [4, 1])
})

console.log('== merge-wave: refusals leave every file as it was')
const snapshot = runDir => ({ ledger: ledgerBytes(runDir), state: readFileSync(join(runDir, 'stage-state.json'), 'utf8'), candidates: existsSync(join(runDir, 'candidates.json')), uncovered: existsSync(join(runDir, 'uncovered.json')) })
await test('results that are not an object, or name a hunter nobody planned, are refused and nothing changes', () => {
  const { runDir, assigned } = hunting([named('a')])
  const [agent] = Object.keys(assigned)
  const before = snapshot(runDir)
  for (const bad of [null, 42, 'x', [], true, undefined]) assert.throws(() => mergeWave(runDir, bad), /must be a JSON object keyed by hunter agent ID/)
  assert.throws(() => mergeWave(runDir, { [agent]: hunterResult([hunterUnit(assigned[agent][0], agent)]), 'h9-99': null }), /results for hunter\(s\) this wave did not plan: h9-99/)
  assert.throws(() => mergeWave(runDir, JSON.parse('{"__proto__": null}')), /did not plan: __proto__/)
  assert.deepEqual(snapshot(runDir), before)
  assert.equal(readLedger(runDir)[0].status, 'in_progress')
})
await test('merge-wave runs only after a hunt is saved: before plan-wave, and after it is merged, it is refused', () => {
  const { runDir } = seeded([named('a')])
  assert.throws(() => mergeWave(runDir, {}), /merge-wave is not the next step of this run: NEXT: plan-wave/)
  planWave(runDir)
  assert.throws(() => mergeWave(runDir, {}), /merge-wave is not the next step of this run: NEXT: hunt/)
})
await test('one unit\'s evidence is bounded, so no hunter result can fill the ledger to upstream\'s 5 MiB read limit and freeze the run', () => {
  const { runDir, assigned } = hunting([named('a'), named('b', { subsystem: 'b' })])
  const [[agent, [id]], [other, [idB]]] = Object.entries(assigned)
  const checks = Array.from({ length: 900 }, (_, i) => checkOf(agent, ['src/app.js'], { invariant: `control ${i} ${'i'.repeat(3000)}`, result: 'r'.repeat(4000) }))
  const out = mergeWave(runDir, { [agent]: hunterResult([hunterUnit(id, agent, { checks })]), [other]: hunterResult([hunterUnit(idB, other)]) })
  assert.match(out.summary, /merged=1 failed=1/)
  const [u, v] = readLedger(runDir)
  const [bloated, fine] = u.coverage_id === id ? [u, v] : [v, u]
  assert.deepEqual([bloated.status, fine.status], ['planned', 'covered'])
  assert.match(bloated.last_failure, /evidence is \d+ bytes, over the \d+ a unit may hold/)
  assert.ok(ledgerBytes(runDir).length < 100_000)
  // the run is not stuck: the next steps still write
  advanceState(runDir, 'critic', { critic_kind: 'post-wave' }); advanceState(runDir, 'mint')
  applyCritic(runDir, { missing_units: [], reassign_ids: [fine.coverage_id], resolved_prior_leads: [], stop: false }, { units: [] })
  assert.ok(ledgerValid(runDir))
})
await test('a merge that saved the ledger and died before saving its step is finished by running it again; nothing is applied twice', () => {
  const { runDir, assigned } = hunting([named('a')])
  const [[agent, [id]]] = Object.entries(assigned)
  const results = { [agent]: hunterResult([hunterUnit(id, agent, { disposition: 'candidate', candidate_fingerprints: ['fp-1'] })], { candidates: [candidateOf('fp-1')] }) }
  mergeWave(runDir, results)
  const merged = snapshot(runDir), pool = readFileSync(join(runDir, 'candidates.json'), 'utf8')
  writeFileSync(join(runDir, 'stage-state.json'), JSON.stringify({ version: 1, last: 'hunt', wave: 1, critic_kind: null, updated: 'x' }))   // the crash
  assert.equal(audit(['next', runDir]).last, 'NEXT: merge-wave run=helper wave=1')
  const out = mergeWave(runDir, results)
  assert.match(out.summary, /already merged/)
  assert.equal(ledgerBytes(runDir), merged.ledger)
  assert.equal(readFileSync(join(runDir, 'candidates.json'), 'utf8'), pool)
  assert.equal(readJsonFile(runDir, 'stage-state.json').last, 'merge-wave')
})
await test('re-merging a wave\'s results into a ledger that is still in_progress (the merge died before writing it) gives the same files', () => {
  const { runDir, assigned } = hunting([named('a')])
  const [[agent, [id]]] = Object.entries(assigned)
  const results = { [agent]: hunterResult([hunterUnit(id, agent, { disposition: 'candidate', candidate_fingerprints: ['fp-1'] })], { candidates: [candidateOf('fp-1')], uncovered: [{ surface: 's', boundary: 'b', subsystem: 's', attack_class: 'a', starting_paths: ['src/db.js'], reason: 'r' }] }) }
  const bytes = ledgerBytes(runDir)
  mergeWave(runDir, results)
  const done = { pool: readFileSync(join(runDir, 'candidates.json'), 'utf8'), queue: readFileSync(join(runDir, 'uncovered.json'), 'utf8') }
  writeFileSync(join(runDir, 'coverage-ledger.json'), bytes)   // the ledger rename never happened; the side files did
  writeFileSync(join(runDir, 'stage-state.json'), JSON.stringify({ version: 1, last: 'hunt', wave: 1, critic_kind: null, updated: 'x' }))
  mergeWave(runDir, results)
  assert.equal(readFileSync(join(runDir, 'candidates.json'), 'utf8'), done.pool)
  assert.equal(readFileSync(join(runDir, 'uncovered.json'), 'utf8'), done.queue)
})

console.log('== the command line')
const inputFile = (name, value) => { const file = join(fresh('inputs'), name); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file }
await test('seed, plan-wave and merge-wave on the command line each end in AUDIT: OK, and the run then passes audit-run check', () => {
  const { runDir } = newRun()
  const seedRun = ledgerCli(['seed', runDir, inputFile('recon.json', reconInput([named('a')]))])
  assert.deepEqual([seedRun.status, seedRun.last], [0, 'AUDIT: OK seed units=1 planned=1'])
  const plan = ledgerCli(['plan-wave', runDir])
  assert.deepEqual([plan.status, plan.last], [0, 'AUDIT: OK plan-wave wave=1 hunters=1 assigned=1 deferred=0'])
  advanceState(runDir, 'hunt')
  const merge = ledgerCli(['merge-wave', runDir, inputFile('results.json', coverAll(assignments(runDir)))])
  assert.deepEqual([merge.status, merge.last], [0, 'AUDIT: OK merge-wave wave=1 merged=1 failed=0 deferred=0 candidates=0 uncovered_queued=0'])
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
  assert.equal(audit(['next', runDir]).last, 'NEXT: critic run=workflow kind=post-wave wave=1')
})
await test('a refused seed prints one ledger: line per problem, then AUDIT: FAIL, exits 1 and writes nothing; so does a step out of order', () => {
  const { runDir } = newRun()
  const bad = inputFile('bad.json', reconInput([unitInput('p', { priority_class: 9 }), unitInput('q', { status: 'covered', reason: 'r' })]))
  const r = ledgerCli(['seed', runDir, bad])
  assert.equal(r.status, 1)
  assert.deepEqual(r.lines.slice(0, 2), ['ledger: unit 0 ("Route p"): priority_class must be an integer from 1 to 4', 'ledger: unit 1 ("Route q"): status "covered" is not one of planned, not_applicable, out_of_scope, deferred: a unit starts untouched'])
  assert.equal(r.last, 'AUDIT: FAIL seed refused: 2 problem(s); nothing was written')
  assert.ok(!existsSync(join(runDir, 'coverage-ledger.json')))
  const early = ledgerCli(['merge-wave', runDir, inputFile('r.json', {})])
  assert.deepEqual([early.status, early.last], [1, `AUDIT: FAIL merge-wave is not the next step of this run: NEXT: seed run=helper`])
})
await test('usage errors are exit 2 on stderr: an unknown command, a missing run directory, a wrong number of files; a missing or non-regular input file is a FAIL', () => {
  const { runDir } = seeded([named('a')])
  for (const args of [[], ['nope', runDir], ['seed'], ['seed', runDir], ['plan-wave'], ['plan-wave', runDir, 'extra'], ['merge-wave', runDir], ['merge-wave', runDir, 'a', 'b'], ['__proto__', runDir], ['toString', runDir]]) {
    const r = ledgerCli(args)
    assert.equal(r.status, 2, args.join(' '))
    assert.match(r.stderr, /^usage: audit-ledger\.mjs seed/)
  }
  const missing = ledgerCli(['merge-wave', runDir, join(runDir, 'no-such.json')])
  assert.deepEqual([missing.status, /^AUDIT: FAIL .*no-such\.json does not exist/.test(missing.last)], [1, true])
  assert.equal(ledgerCli(['merge-wave', runDir, runDir]).status, 1)
  assert.match(ledgerCli(['merge-wave', runDir, inputFile('prose.json', 'prose, not JSON')]).last, /^AUDIT: FAIL .*is not valid JSON/)
})
