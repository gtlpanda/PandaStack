// audit-deep-second-pass.test.mjs - the edges of deep's second pass (audit-ledger.mjs buildCritic) beyond what the acceptance test (profile-deep.test.mjs) pins:
// the dry run (applyCriticProblems) judges the replanned ledger the write makes; the second_pass count reaches the event log for deep only; a unit an earlier
// run covered on source that has changed since (prior_covered_changed_source) is not passed again.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '../../../scripts/workflow-harness.mjs'
import { SECOND_PASS_REASON, applyCritic, applyCriticProblems, mergeWave, planWave, seed } from '../skills/security-audit/audit-ledger.mjs'
import { advanceState } from '../skills/security-audit/audit-run.mjs'
import { FILES, newRun } from './audit-fixtures.mjs'
import { assignments, commitChange, coverAll, ledgerValid, priorRun, priorUnit, readLedger, reconInput, unitInput } from './ledger-fixtures.mjs'
import { asProfile, byName, critic } from './profile-support.mjs'

const lastEvent = runDir => JSON.parse(readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').at(-1))
const OTHER = 'src/other.js'

// An earlier run covered `keep` (on src/app.js) and `moved` (on src/other.js); `change` is committed after it. This run seeds keep, moved and fresh, is recorded
// as `profile`, and takes wave 1 to a merged result with every unit covered: apply-critic is next.
function afterFirstWave(profile, { change } = {}) {
  const before = repo => {
    priorRun(repo, [priorUnit('keep', 'covered'), priorUnit('moved', 'covered', { starting_paths: [OTHER], reviewed_paths: [OTHER] })])
    if (change) commitChange(repo, change)
  }
  const run = newRun({ files: { ...FILES, [OTHER]: 'export const o = 1\n' }, before })
  seed(run.runDir, reconInput([unitInput('keep'), unitInput('moved', { starting_paths: [OTHER] }), unitInput('fresh')]))
  asProfile(run.runDir, profile)
  planWave(run.runDir)
  advanceState(run.runDir, 'hunt')
  mergeWave(run.runDir, coverAll(assignments(run.runDir)))
  advanceState(run.runDir, 'critic', { critic_kind: 'post-wave' })
  advanceState(run.runDir, 'mint')
  return run
}

await test('deep: the dry run (applyCriticProblems) judges the replanned ledger the write makes, and the write then archives exactly what it judged', () => {
  const { runDir } = afterFirstWave('deep')
  assert.deepEqual(applyCriticProblems(runDir, critic(), { units: [] }), [])
  const out = applyCritic(runDir, critic(), { units: [] })
  assert.match(out.summary, / second_pass=2$/, out.summary)
  const by = byName(readLedger(runDir))
  for (const name of ['keep', 'moved']) assert.deepEqual([by[name].status, by[name].wave, by[name].attempts.map(a => a.reassignment_reason)], ['planned', 2, [SECOND_PASS_REASON]], name)
  assert.deepEqual([by.fresh.status, by.fresh.attempts.length], ['covered', 0], 'a unit no earlier run covered is not passed again')
  assert.ok(ledgerValid(runDir))
})

await test('deep: a unit an earlier run covered on source that changed since (prior_covered_changed_source) is not given the second pass; the same-source one is', () => {
  const { runDir } = afterFirstWave('deep', { change: { [OTHER]: 'export const o = 2 // edited\n' } })
  const before = byName(readLedger(runDir))
  assert.deepEqual([before.keep.prior_status, before.moved.prior_status, before.moved.status], ['prior_covered_same_source', 'prior_covered_changed_source', 'covered'], 'the fixture')
  const out = applyCritic(runDir, critic(), { units: [] })
  assert.match(out.summary, / second_pass=1$/, out.summary)
  const by = byName(readLedger(runDir))
  assert.deepEqual([by.keep.status, by.moved.status, by.moved.wave, by.moved.attempts.length], ['planned', 'covered', 1, 0])
  assert.ok(ledgerValid(runDir))
})

for (const [profile, expected] of [['deep', 2], ['standard', undefined], ['quick', undefined]]) {
  await test(`${profile}: the apply-critic event's counts ${expected === undefined ? 'have no second_pass key' : `carry second_pass=${expected}`}`, () => {
    const { runDir } = afterFirstWave(profile)
    applyCritic(runDir, critic(), { units: [] })
    const event = lastEvent(runDir)
    assert.equal(event.cmd, 'apply-critic')
    assert.equal(event.counts.second_pass, expected)
    assert.equal('second_pass' in event.counts, expected !== undefined)
  })
}
