// audit-critic-profile.test.mjs - the coverage critic is told which profile the run is. The synthesizer's and the minter's inputs carry `profile` and their prompts print a
// `Run profile:` line; the critic's did not, so a quick or deep critic got upstream's whole "Run profiles and scope" section (all three bullets) and could not tell which one applied.
// Quick and deep get the key and the line; standard's critic input and prompt are what they were.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from '../../../scripts/workflow-harness.mjs'
import { mergeWave, planWave } from '../skills/security-audit/audit-ledger.mjs'
import { advanceState } from '../skills/security-audit/audit-run.mjs'
import { assignments, coverAll, readJsonFile, refsOf, seeded, unitInput } from './ledger-fixtures.mjs'
import { runScript, stage, stageDirOf } from './stage-fixtures.mjs'
import { asProfile, critic, profilesBlock } from './profile-support.mjs'

console.log('== the critic is told the run profile')

// The critic stage of a run recorded as `profile`, after its first wave: { input, prompt } as the stage planned and the workflow rendered them.
async function criticStage(profile, extra = {}) {
  const run = seeded([unitInput('a'), unitInput('b', { canonical_refs: refsOf('b', { subsystem: 'other' }) })])
  asProfile(run.runDir, profile, extra)
  planWave(run.runDir)
  advanceState(run.runDir, 'hunt')
  mergeWave(run.runDir, coverAll(assignments(run.runDir)))
  const plan = stage(['plan', run.runDir])
  assert.equal(plan.status, 0, plan.stdout)
  const dir = stageDirOf(plan, run.runDir)
  let prompt = null
  await runScript(join(dir, 'run.js'), { 'audit-researcher': [p => { prompt = p; return critic() }] })
  return { input: readJsonFile(dir, 'input.json'), prompt }
}

const RUN_PROFILE_LINE = profile => `Run profile: ${JSON.stringify(profile)}.`
const PROFILE_SECTION = text => `--- The run profile, upstream text verbatim ---\n${text}\n\n`

for (const profile of ['quick', 'deep']) {
  await test(`${profile}: the critic's input carries the profile, and its prompt says which profile the run is, next to upstream's profile section`, async () => {
    const { input, prompt } = await criticStage(profile)
    assert.equal(input.profile, profile, 'input.profile')
    assert.ok(prompt.includes(RUN_PROFILE_LINE(profile)), `the prompt has the line ${RUN_PROFILE_LINE(profile)}`)
    assert.ok(prompt.includes(PROFILE_SECTION(profilesBlock())), 'upstream\'s profile section is still there, verbatim')
    assert.ok(prompt.indexOf(RUN_PROFILE_LINE(profile)) < prompt.indexOf(PROFILE_SECTION(profilesBlock())), 'the critic reads which profile it is before the three bullets')
    assert.equal(prompt.split('Run profile:').length - 1, 1, 'said once')
  })
}

await test('standard: the critic\'s input has no profile key and its prompt has no Run profile line, and quick\'s and deep\'s prompts differ from it by exactly the line and upstream\'s section', async () => {
  const standard = await criticStage('standard')
  assert.ok(!('profile' in standard.input), 'no profile key')
  assert.ok(!standard.prompt.includes('Run profile:') && !standard.prompt.includes('The run profile, upstream text verbatim'))
  const sameTree = ({ input, prompt }) => prompt.replaceAll(input.tree, '<tree>')   // each run has its own snapshot directory, which the prompt names
  for (const profile of ['quick', 'deep']) {
    const other = await criticStage(profile)
    const stripped = sameTree(other).replace(`${RUN_PROFILE_LINE(profile)}\n\n`, '').replace(PROFILE_SECTION(profilesBlock()), '')
    assert.equal(stripped, sameTree(standard), `${profile}: nothing else of the critic's prompt moved, so standard's prompt is byte for byte what it was`)
  }
})

await test('a run with no profile in its metadata, or one that is not a profile name, is read as standard: no key, no line', async () => {
  for (const profile of [undefined, 'fast', null]) {
    const { input, prompt } = await criticStage(profile)
    assert.ok(!('profile' in input), `profile ${JSON.stringify(profile)}: no key`)
    assert.ok(!prompt.includes('Run profile:'), `profile ${JSON.stringify(profile)}: no line`)
  }
})
