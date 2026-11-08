// profile-granularity.test.mjs - P-03: the units a profile asks for. quick coarsens every unit to upstream's one subsystem reference (seed and mint refuse any other);
// deep and quick's text is upstream's "Run profiles and scope" block, carried into the synthesizer's, the critic's and the minter's prompts; standard is untouched. Acceptance
// test of .autobuild/contracts/profiles.md, section P-03. Frozen.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { RECON_IDS } from '../skills/security-audit/audit-facts.mjs'
import { seed, seedProblems, unitFromInput } from '../skills/security-audit/audit-ledger.mjs'
import { advanceState } from '../skills/security-audit/audit-run.mjs'
import { mergeWave, planWave } from '../skills/security-audit/audit-ledger.mjs'
import { audit, newRun } from './audit-fixtures.mjs'
import { assignments, coverAll, ledgerValid, priorUnit, priorRun, reconInput, readJsonFile, readLedger, refsOf, seeded, unitInput } from './ledger-fixtures.mjs'
import { RESEARCH, SYNTH, newInit, returnedFile, runScript, runStage, stage, stageDirOf } from './stage-fixtures.mjs'
import { QUICK_REF, asProfile, critic, gap, lifecycleUnit, profilesBlock, quickUnit } from './profile-support.mjs'

console.log('== P-03: seed and mint hold quick to upstream\'s one subsystem reference')
const quickRun = opts => { const run = newRun(opts); asProfile(run.runDir, 'quick'); return run }
const refused = (fn, pattern) => assert.throws(fn, e => pattern.test(`${e.message}\n${(e.problems ?? []).join('\n')}`), `expected a refusal matching ${pattern}`)

await test('a quick seed takes units whose subsystem reference is the fixed one (their labels are free), and the ledger passes upstream\'s validator', () => {
  const { runDir } = quickRun()
  seed(runDir, reconInput([quickUnit('a'), quickUnit('b', { subsystem: 'Anything I like' })]))
  const ledger = readLedger(runDir)
  assert.equal(ledger.length, 2)
  assert.ok(ledger.every(u => u.canonical_refs.subsystem === QUICK_REF && u.status === 'planned'))
  assert.ok(ledger.every(u => u.coverage_id.includes('profile%2Fquick%2Fall-in-scope-subsystems')), 'the ID encodes the fixed reference')
  assert.ok(ledgerValid(runDir))
})
await test('a quick seed refuses a unit with any other subsystem reference, naming the fixed one and the unit, and writes nothing (the synthesizer is told once, as for any seed problem)', () => {
  const { runDir } = quickRun()
  const input = reconInput([quickUnit('a'), unitInput('b')])
  const pattern = /unit 1 .*the quick profile coarsens every unit to one subsystem: canonical_refs\.subsystem must be "profile\/quick\/all-in-scope-subsystems", not "src"/
  refused(() => seed(runDir, input), pattern)
  assert.ok(!existsSync(join(runDir, 'coverage-ledger.json')), 'no ledger')
  assert.equal(readJsonFile(runDir, 'stage-state.json').last, 'recon', 'the step is not saved')
  assert.ok(seedProblems(runDir, input).some(p => pattern.test(p)), 'seedProblems, which audit-stage.mjs asks before it saves a synthesizer result, says the same')
})
await test('a quick seed refuses a lifecycle dimension, in the reference and the label, in the label alone, or in the reference alone: each time with quick\'s own message', () => {
  const { runDir } = quickRun()
  const both = quickUnit('a', { canonical_refs: refsOf('a', { subsystem: QUICK_REF, lifecycle: 'create' }), lifecycle: 'create' })
  const label = quickUnit('b', { lifecycle: 'create' })
  const reference = quickUnit('c', { canonical_refs: refsOf('c', { subsystem: QUICK_REF, lifecycle: 'create' }) })
  for (const [what, unit] of [['the reference and the label', both], ['the label alone', label], ['the reference alone', reference]]) {
    assert.throws(() => seed(runDir, reconInput([unit])), e => (e.problems ?? []).some(p => /the quick profile does not split units by lifecycle mode: leave out lifecycle and canonical_refs\.lifecycle/.test(p)), what)
  }
  assert.ok(!existsSync(join(runDir, 'coverage-ledger.json')))
})
await test('unitFromInput judges by ctx.profile: quick refuses a unit that is not coarsened, and a ctx with no profile (an existing caller) judges as before', () => {
  const { runDir } = newRun()
  const ctx = { runDir, scope: [], priorStatus: 'none' }
  assert.ok(unitFromInput(unitInput('x'), ctx).unit, 'no profile in ctx: accepted, as before')
  assert.ok(unitFromInput(unitInput('x'), { ...ctx, profile: 'standard' }).unit)
  assert.ok(unitFromInput(lifecycleUnit('x', 'create'), { ...ctx, profile: 'deep' }).unit)
  assert.ok(unitFromInput(quickUnit('x'), { ...ctx, profile: 'quick' }).unit)
  assert.match((unitFromInput(unitInput('x'), { ...ctx, profile: 'quick' }).problems ?? []).join('\n'), /the quick profile coarsens every unit/)
  assert.match((unitFromInput(lifecycleUnit('x', 'create', { canonical_refs: refsOf('x', { subsystem: QUICK_REF, lifecycle: 'create' }) }), { ...ctx, profile: 'quick' }).problems ?? []).join('\n'), /does not split units by lifecycle mode/)
})
await test('standard and deep keep what they took: any subsystem reference, and a lifecycle mode only adds a dimension (two units that differ only by lifecycle are two units, the ID ends in it)', () => {
  for (const profile of ['standard', 'deep']) {
    const { runDir } = newRun()
    asProfile(runDir, profile)
    seed(runDir, reconInput([unitInput('a'), lifecycleUnit('a', 'create', { surface: 'Route a (create)' }), lifecycleUnit('a', 'revoke', { surface: 'Route a (revoke)' })]))
    const ledger = readLedger(runDir)
    assert.equal(ledger.length, 3, profile)
    assert.deepEqual(ledger.filter(u => u.lifecycle).map(u => u.lifecycle).sort(), ['create', 'revoke'], profile)
    assert.ok(ledger.filter(u => u.lifecycle).every(u => u.coverage_id.endsWith(`::${u.lifecycle}`) && u.canonical_refs.lifecycle === u.lifecycle), profile)
    assert.ok(ledgerValid(runDir), profile)
  }
})
await test('a prior unit the quick seed did not produce is still added back with its own references (an earlier run\'s evidence is not coarsened, and no prior lead vanishes)', () => {
  const { runDir } = newRun({ before: repo => priorRun(repo, [priorUnit('old', 'covered')]) })
  asProfile(runDir, 'quick')
  const out = seed(runDir, reconInput([quickUnit('new')]))
  assert.doesNotMatch(out.notes.join('\n'), /could not be added/)
  const ledger = readLedger(runDir)
  assert.deepEqual(ledger.map(u => u.canonical_refs.subsystem).sort(), [QUICK_REF, 'src'].sort())
  assert.ok(ledgerValid(runDir))
})

console.log('== P-03: the profile\'s upstream text reaches the agents that decide coverage')
const parts = input => input.parts ?? {}
const NOT_QUICK_BULLET = '- **`quick`** — a bounded pass'

// recon synthesize part: the stage input and the synthesizer's prompt, for a run recorded as `profile`.
async function synthesizer(profile) {
  const { runDir } = newInit()
  asProfile(runDir, profile)
  const facts = await runStage(runDir, { 'audit-researcher': RECON_IDS.map(id => RESEARCH(id)) })
  assert.equal(facts.apply.status, 0, facts.apply.stdout)
  const plan = stage(['plan', runDir])
  assert.equal(plan.status, 0, plan.stdout)
  const dir = stageDirOf(plan, runDir)
  let prompt = null
  await runScript(join(dir, 'run.js'), { 'audit-synthesizer': [p => { prompt = p; return SYNTH() }] })
  return { input: readJsonFile(dir, 'input.json'), prompt }
}
// critic and mint stages after a first wave: [{ input, prompt }, { input, prompt }].
async function criticAndMinter(profile) {
  const run = seeded([unitInput('a'), unitInput('b', { canonical_refs: refsOf('b', { subsystem: 'other' }) })])
  asProfile(run.runDir, profile)
  planWave(run.runDir)
  advanceState(run.runDir, 'hunt')
  mergeWave(run.runDir, coverAll(assignments(run.runDir)))
  const out = []
  const stages = [['audit-researcher', critic({ missing_units: [gap('g')] })], ['audit-synthesizer', { units: [] }]]
  for (const [agent, answer] of stages) {
    const plan = stage(['plan', run.runDir])
    assert.equal(plan.status, 0, plan.stdout)
    const dir = stageDirOf(plan, run.runDir)
    let prompt = null
    const ran = await runScript(join(dir, 'run.js'), { [agent]: [p => { prompt = p; return answer }] })
    out.push({ input: readJsonFile(dir, 'input.json'), prompt })
    if (agent === 'audit-researcher') assert.equal(stage(['apply', run.runDir, returnedFile(dir, ran.result)]).status, 0)
  }
  return out
}

for (const profile of ['quick', 'deep']) {
  await test(`${profile}: the synthesizer's input carries upstream's "Run profiles and scope" block as parts.profile, and its prompt carries that text verbatim`, async () => {
    const { input, prompt } = await synthesizer(profile)
    assert.ok(parts(input).profile === profilesBlock(), 'input.parts.profile is upstream\'s "Run profiles and scope" block, byte for byte')
    assert.ok(prompt.includes(profilesBlock()), 'the synthesizer\'s prompt has the block, byte for byte')
    assert.ok(prompt.includes('--- The run profile, upstream text verbatim ---'), 'under its heading')
  })
  await test(`${profile}: the critic's and the minter's inputs and prompts carry it too`, async () => {
    const [c, m] = await criticAndMinter(profile)
    for (const [who, { input, prompt }] of [['critic', c], ['minter', m]]) {
      assert.ok(parts(input).profile === profilesBlock(), `${who}'s input.parts.profile is upstream's "Run profiles and scope" block, byte for byte`)
      assert.ok(prompt.includes(profilesBlock()) && prompt.includes('--- The run profile, upstream text verbatim ---'), `${who}'s prompt has the block, byte for byte, under its heading`)
    }
  })
}
await test('standard: nothing changes for it: no parts.profile in any input and none of upstream\'s profile text in any prompt', async () => {
  const { input, prompt } = await synthesizer('standard')
  assert.ok(!('profile' in parts(input)) && !prompt.includes(NOT_QUICK_BULLET) && !prompt.includes('The run profile, upstream text verbatim'))
  const [c, m] = await criticAndMinter('standard')
  for (const { input: i, prompt: p } of [c, m]) assert.ok(!('profile' in parts(i)) && !p.includes(NOT_QUICK_BULLET) && !p.includes('The run profile, upstream text verbatim'))
})
