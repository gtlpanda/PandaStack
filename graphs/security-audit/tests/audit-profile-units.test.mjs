// audit-profile-units.test.mjs - the edges of the quick profile's unit gate (audit-ledger.mjs unitFromInput) and of the profile text the coverage
// agents get (audit-inputs.mjs profilePart), beyond what the acceptance test (profile-granularity.test.mjs) pins: a malformed unit is told, never
// thrown on; only an exact profile name gates; the minter is held to the same gate as the seed; the text is upstream's, for quick and deep only.
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { applyCritic, applyCriticProblems, unitFromInput } from '../skills/security-audit/audit-ledger.mjs'
import { profilePart } from '../skills/security-audit/audit-inputs.mjs'
import { resolve as resolveBlock } from '../skills/security-audit/blocks.mjs'
import { newRun } from './audit-fixtures.mjs'
import { readLedger, unitInput } from './ledger-fixtures.mjs'
import { afterWave, critic, gap, quickUnit } from './profile-support.mjs'

const COARSEN = /the quick profile coarsens every unit to one subsystem/
const problemsOf = (input, profile) => {
  const { runDir } = newRun()
  return unitFromInput(input, { runDir, scope: [], priorStatus: 'none', profile }).problems ?? []
}

await test('a quick unit with no canonical_refs, or refs that are not an object, gets problems (quick\'s among them), not a TypeError', () => {
  for (const refs of [undefined, null, 'src', ['src']]) {
    const input = { ...unitInput('x'), canonical_refs: refs }
    let problems
    assert.doesNotThrow(() => { problems = problemsOf(input, 'quick') }, String(JSON.stringify(refs)))
    assert.ok(problems.some(p => COARSEN.test(p)), `quick's message for canonical_refs ${JSON.stringify(refs)}`)
  }
  assert.ok(problemsOf({ ...unitInput('x'), canonical_refs: undefined }, 'quick').some(p => p.endsWith(', not undefined')), 'a missing reference is named, not printed as an empty string')
})

await test('only an exact profile name gates: a near miss or a non-string profile in ctx judges as standard, and the subsystem label alone never satisfies quick', () => {
  for (const profile of ['Quick', 'quick ', 'fast', null, 0, ['quick']]) assert.deepEqual(problemsOf(unitInput('x'), profile), [], String(JSON.stringify(profile)))
  const labelOnly = unitInput('x', { subsystem: 'profile/quick/all-in-scope-subsystems' })   // the label, not canonical_refs.subsystem
  assert.ok(problemsOf(labelOnly, 'quick').some(p => COARSEN.test(p) && p.endsWith('not "src"')))
})

await test('a quick minter is held to the seed\'s gate: a unit that is not coarsened is a rejection (the minter is told), a coarsened one is added', () => {
  const run = afterWave([quickUnit('a')], { profile: 'quick' })
  const crit = critic({ missing_units: [gap('g'), gap('h')] })
  const mint = { units: [unitInput('g'), quickUnit('h')] }
  const problems = applyCriticProblems(run.runDir, crit, mint)
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /^minted unit 0: .*the quick profile coarsens every unit to one subsystem.*; rejected$/)
  const out = applyCritic(run.runDir, crit, mint)
  assert.match(out.summary, /units_added=1 .*rejected=1/)
  assert.deepEqual(readLedger(run.runDir).map(u => u.canonical_refs.subsystem), ['profile/quick/all-in-scope-subsystems', 'profile/quick/all-in-scope-subsystems'])
})

await test('profilePart: upstream\'s "Run profiles and scope" text for quick and deep; nothing for standard, a missing profile or an unknown one', () => {
  const text = resolveBlock('SKILL.md#Run profiles and scope').text
  for (const profile of ['quick', 'deep']) assert.deepEqual(profilePart({ profile }), { profile: text }, profile)
  for (const meta of [{ profile: 'standard' }, {}, { profile: 'fast' }, null, undefined]) assert.deepEqual(profilePart(meta), {}, String(JSON.stringify(meta)))
})
