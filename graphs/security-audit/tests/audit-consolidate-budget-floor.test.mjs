// audit-consolidate-budget-floor.test.mjs - consolidation must not run when its one agent leaves validate unable to fund any candidate.
import assert from 'node:assert/strict'
import { summary, test } from '../../../scripts/workflow-harness.mjs'
import { recordSpend } from '../skills/security-audit/audit-run.mjs'
import { meta } from './audit-fixtures.mjs'
import { runStage, stage } from './stage-fixtures.mjs'
import { atValidation, next } from './verdict-fixtures.mjs'

await test('with two agents left of the budget, consolidation does not spend the agent validate needs to fund a candidate', async () => {
  const run = atValidation([{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }], { args: ['--budget', '40'] })
  recordSpend(run.runDir, 'earlier', 38)   // two agents left
  const plan = stage(['plan', run.runDir])
  if (plan.status === 0) {
    // consolidation was planned: run it with a grouping that merges nothing, as an honest synthesizer may
    const res = await runStage(run.runDir, { 'audit-synthesizer': [{ groups: [{ keep: 'fp-a', merge: [], reason: '' }, { keep: 'fp-b', merge: [], reason: '' }] }] })
    assert.equal(res.apply.status, 0, res.apply.stdout)
  }
  assert.equal(next(run.runDir), 'NEXT: validate run=workflow')
  const left = 40 - meta(run.runDir).agents_spent
  const validate = stage(['plan', run.runDir])
  assert.equal(validate.status, 0, `BUGHUNT-F1 consolidation left ${left} agent(s) and validate can fund no candidate: ${validate.last}`)
})

// Run alone (node --test), the harness only prints a failure; make it the exit code too.
if (summary().fail > 0) process.exitCode = 1
