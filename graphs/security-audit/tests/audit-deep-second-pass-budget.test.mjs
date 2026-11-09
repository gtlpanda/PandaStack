// audit-deep-second-pass-budget.test.mjs - deep's second pass under a budget. The pass is the profile's own addition (SPEC M2), not something a critic asked for, so it is given only to
// units the next wave can fund a hunter for: apply-critic asks wavePlan (the one planWave plans with) which units that wave would hand to a hunter, and a unit it would not reach keeps
// the pass this run already gave it (covered) and gets a note. Before this, apply-critic reopened every covered prior_covered_same_source unit whatever the budget, planWave then deferred the
// reopened unit with budget_cannot_reserve_critics_and_validation, and a unit this run had covered ended deferred where standard under the same budget listed it covered.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { SECOND_PASS_REASON, applyCritic, applyCriticProblems, mergeWave, planWave, seed } from '../skills/security-audit/audit-ledger.mjs'
import { advanceState, loadRun, nextStep, waveAllowance } from '../skills/security-audit/audit-run.mjs'
import { canonicalCoverageId } from '../skills/security-audit/upstream.mjs'
import { FILES, meta as metaOf, mkRepo, newRun } from './audit-fixtures.mjs'
import { driveAudit } from './e2e-driver.mjs'
import { assignments, coverAll, ledgerValid, priorRun, priorUnit, readLedger, reconInput, refsOf, unitInput } from './ledger-fixtures.mjs'
import { TOY_FILES } from './toy-app.mjs'
import { deepAnswer } from './profile-e2e-support.mjs'
import { asProfile, byName, critic, gap } from './profile-support.mjs'

console.log('== deep: the second pass is given only where the next wave can fund it')

const OTHER = 'src/other.js'
const NOT_GIVEN = /^(\d+) unit\(s\) an earlier run covered on unchanged source were not given the deep profile's second pass: the next wave cannot fund a hunter for them \(--budget \d+, \d+ spent\); each keeps the pass this run gave it$/
const secondPassed = u => u.attempts.some(a => a.reassignment_reason === SECOND_PASS_REASON)

// An earlier run covered `keep` (subsystem src) and `moved` (subsystem other, so a different hunter's group). This run seeds both, takes wave 1 to a merged result with every unit
// covered, and is then given a budget with `remaining` agents left: apply-critic is next. A wave at 6 left funds one hunter, at 5 or fewer none (waveAllowance, read below).
function afterFirstWave(profile, { remaining, budget = 40, extraUnits = [] } = {}) {
  const movedRefs = refsOf('moved', { subsystem: 'other' })
  const before = repo => priorRun(repo, [
    priorUnit('keep', 'covered'),
    { ...priorUnit('moved', 'covered', { canonical_refs: movedRefs, starting_paths: [OTHER], reviewed_paths: [OTHER] }), coverage_id: canonicalCoverageId(movedRefs) },
  ])
  const run = newRun({ files: { ...FILES, [OTHER]: 'export const o = 1\n' }, before })
  seed(run.runDir, reconInput([unitInput('keep'), unitInput('moved', { canonical_refs: movedRefs, starting_paths: [OTHER] }), ...extraUnits]))
  asProfile(run.runDir, profile)
  planWave(run.runDir)
  advanceState(run.runDir, 'hunt')
  mergeWave(run.runDir, coverAll(assignments(run.runDir)))
  advanceState(run.runDir, 'critic', { critic_kind: 'post-wave' })
  advanceState(run.runDir, 'mint')
  const spent = budget - remaining
  asProfile(run.runDir, profile, { budget, agents_spent: spent, stage_spend: { earlier: spent } })
  return run
}

await test('the fixture: 6 agents left fund one hunter, 5 fund none (what the tests below rely on)', () => {
  assert.equal(waveAllowance('deep', 6).hunters, 1)
  assert.equal(waveAllowance('deep', 5).hunters, 0)
})

await test('a budget that cannot fund a hunter: neither unit is given the second pass, both keep their covered pass with no attempt, and the note says why; the ledger is valid and a final-clean critic is next', () => {
  const { runDir } = afterFirstWave('deep', { remaining: 5 })
  assert.deepEqual(applyCriticProblems(runDir, critic(), { units: [] }), [])
  const out = applyCritic(runDir, critic(), { units: [] })
  assert.match(out.summary, / second_pass=0$/, out.summary)
  assert.ok(out.notes.some(n => NOT_GIVEN.exec(n)?.[1] === '2'), out.notes.join('\n'))
  const by = byName(readLedger(runDir))
  for (const name of ['keep', 'moved']) assert.deepEqual([by[name].status, by[name].wave, by[name].attempts.length, /^h1-\d+$/.test(by[name].agent_id)], ['covered', 1, 0, true], name)
  assert.ok(ledgerValid(runDir))
  assert.deepEqual([nextStep(loadRun(runDir)).step, nextStep(loadRun(runDir)).kind], ['critic', 'final-clean'], 'nothing is planned, so the next wave is not asked for')
})
await test('a budget that funds one hunter: the unit that ranks first (and so would get it) is given the pass, the other keeps its covered pass, and the count and the note say so', () => {
  const { runDir } = afterFirstWave('deep', { remaining: 6 })
  const out = applyCritic(runDir, critic(), { units: [] })
  assert.match(out.summary, / second_pass=1$/, out.summary)
  assert.ok(out.notes.some(n => NOT_GIVEN.exec(n)?.[1] === '1'), out.notes.join('\n'))
  const by = byName(readLedger(runDir))
  assert.deepEqual([by.keep.status, by.keep.wave, by.keep.attempts.map(a => a.reassignment_reason)], ['planned', 2, [SECOND_PASS_REASON]])
  assert.deepEqual([by.moved.status, by.moved.wave, by.moved.attempts.length], ['covered', 1, 0])
  assert.ok(ledgerValid(runDir))
})
await test('the one hunter goes to the work that ranks first: a unit the critic found missing (planned, first in the order) takes it, so neither second pass is given', () => {
  const { runDir } = afterFirstWave('deep', { remaining: 6 })
  const fresh = unitInput('found', { canonical_refs: refsOf('found', { subsystem: 'third' }), priority_class: 1 })
  const out = applyCritic(runDir, critic({ missing_units: [gap('g')] }), { units: [fresh] })
  assert.match(out.summary, / units_added=1 .* second_pass=0$/, out.summary)
  assert.ok(out.notes.some(n => NOT_GIVEN.exec(n)?.[1] === '2'), out.notes.join('\n'))
  const by = byName(readLedger(runDir))
  assert.deepEqual([by.found.status, by.keep.status, by.moved.status, by.keep.attempts.length, by.moved.attempts.length], ['planned', 'covered', 'covered', 0, 0])
})
await test('a budget with room for both units gives both the pass, as before, and no note', () => {
  const { runDir } = afterFirstWave('deep', { remaining: 30 })
  const out = applyCritic(runDir, critic(), { units: [] })
  assert.match(out.summary, / second_pass=2$/, out.summary)
  assert.ok(!out.notes.some(n => NOT_GIVEN.test(n)), out.notes.join('\n'))
  assert.ok(readLedger(runDir).filter(secondPassed).length === 2 && ledgerValid(runDir))
})
await test('no budget at all gives both units the pass, as before, and no note', () => {
  const { runDir } = afterFirstWave('deep', { remaining: 5 })
  asProfile(runDir, 'deep', { budget: null, agents_spent: 0, stage_spend: {} })
  const out = applyCritic(runDir, critic(), { units: [] })
  assert.match(out.summary, / second_pass=2$/, out.summary)
  assert.ok(!out.notes.some(n => NOT_GIVEN.test(n)), out.notes.join('\n'))
  assert.ok(readLedger(runDir).filter(secondPassed).length === 2 && ledgerValid(runDir))
})
await test('standard and quick are not touched: a budget that funds no hunter gives them no second pass and no note about one', () => {
  for (const profile of ['standard', 'quick']) {
    const { runDir } = afterFirstWave(profile, { remaining: 5 })
    const out = applyCritic(runDir, critic(), { units: [] })
    assert.ok(!/second_pass/.test(out.summary) && !out.notes.some(n => NOT_GIVEN.test(n)), `${profile}: ${out.summary}`)
  }
})

// ---------- the real path: a second audit of the same commit under a budget ----------
// The first audit is unbudgeted; the second finds it as its earlier run and has `budget` agents. Both units the first run covered (src/auth.js#currentUser, src/server.js#server) come back as
// prior_covered_same_source units, hunted in wave 1 by every profile. The budget is the only thing that changes.
const SP = ['src/auth.js#currentUser', 'src/server.js#server']
async function secondAudit(profile, budget) {
  const repo = mkRepo(TOY_FILES, `toy-${profile}`)
  const initArgs = ['--profile', profile, '--max-parallel', '2']
  await driveAudit({ repo, answer: deepAnswer, initArgs })
  const d = await driveAudit({ repo, answer: deepAnswer, initArgs: [...initArgs, '--budget', String(budget)], tolerateRefusals: true })
  const ledger = JSON.parse(readFileSync(join(d.RUN, 'coverage-ledger.json'), 'utf8'))
  return { m: metaOf(d.RUN), sp: ledger.filter(u => SP.includes(u.canonical_refs.surface)).sort((a, b) => (a.canonical_refs.surface < b.canonical_refs.surface ? -1 : 1)), ledger }
}
const row = u => [u.status, u.wave, u.attempts.length]

for (const budget of [14, 15]) {   // wave 1 funds both units at 14 and 15 (standard lists both covered); below, standard defers one itself
  await test(`deep's second audit at --budget ${budget}: the units this run covered are listed covered, as standard lists them, not deferred for a second pass nobody could hunt`, async () => {
    const deep = await secondAudit('deep', budget)
    const standard = await secondAudit('standard', budget)
    assert.deepEqual(standard.sp.map(row), [['covered', 1, 0], ['covered', 1, 0]], 'standard: the fixture')
    assert.deepEqual(deep.sp.map(row), standard.sp.map(row))
    assert.ok(!deep.ledger.some(u => u.unresolved.includes('budget_cannot_reserve_critics_and_validation') && u.attempts.some(secondPassed)), 'no unit was reopened and then deferred')
    assert.ok(deep.m.agents_spent <= budget, `${deep.m.agents_spent} agents spent`)
  })
}
await test('deep\'s second audit at --budget 16, which funds one of the two hunters: one unit is given the pass and covered again, the other keeps its covered pass; none is deferred', async () => {
  const { sp } = await secondAudit('deep', 16)
  assert.deepEqual(sp.map(row).sort(), [['covered', 1, 0], ['covered', 2, 1]])
})
await test('deep\'s second audit at --budget 18, which funds both: both are given the pass (as before)', async () => {
  const { sp } = await secondAudit('deep', 18)
  assert.deepEqual(sp.map(row), [['covered', 2, 1], ['covered', 2, 1]])
})

await test('SKILL.md and the graph README say that, under a budget, the second pass is given only where the next wave can fund a hunter', () => {
  for (const file of ['../skills/security-audit/SKILL.md', '../README.md']) {
    assert.match(readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\s+/g, ' '), /under a `--budget`,? (a unit gets that pass )?only if the next wave can fund a hunter for it/, file)
  }
})
