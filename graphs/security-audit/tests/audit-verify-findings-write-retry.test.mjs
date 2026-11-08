// audit-verify-findings-write-retry.test.mjs - the verify plan after a failed findings.json write: a budget-exhausted plan records the removals in decisions.json and then
// rewrites findings.json through commitFindings. When that write fails (here a real rename failure inside commitFindings), planning again must recover, not refuse forever.
import { join } from 'node:path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { summary, test } from '../../../scripts/workflow-harness.mjs'
import { recordSpend } from '../skills/security-audit/audit-run.mjs'
import { meta } from './audit-fixtures.mjs'
import { stage } from './stage-fixtures.mjs'
import { atVerify, decisions } from './verdict-fixtures.mjs'

const TWO = [{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }]
const found = runDir => JSON.parse(readFileSync(join(runDir, 'findings.json'), 'utf8'))
const leaveNoAgent = (runDir, budget) => recordSpend(runDir, 'filler', Math.max(0, budget - meta(runDir).agents_spent + (meta(runDir).stage_spend.filler ?? 0)))

console.log('== verify plan after a failed findings.json write')
await test('a plan whose findings.json rewrite failed is recoverable: planning again rewrites findings.json from the decisions instead of refusing it as hand-edited', async () => {
  const run = await atVerify(TWO, { args: ['--budget', '40'] })
  leaveNoAgent(run.runDir, 40)
  // Make the rename of findings.json.candidate fail: a non-empty directory sits where the candidate file would go.
  const candidate = join(run.runDir, 'findings.json.candidate')
  mkdirSync(candidate)
  writeFileSync(join(candidate, 'block'), 'x')
  const failed = stage(['plan', run.runDir])
  assert.notEqual(failed.status, 0, 'the first plan fails in the findings write')
  assert.ok(decisions(run.runDir).entries.every(e => e.phase5?.state === 'removed'), 'the removals were recorded in decisions.json before the write')
  assert.equal(found(run.runDir).length, 2, 'findings.json still holds the records: the write did not land')
  // The transient failure is over.
  rmSync(candidate, { recursive: true, force: true })
  const again = stage(['plan', run.runDir])
  assert.doesNotMatch(again.stdout + again.stderr, /findings\.json is not the decided records/, 'BUGHUNT-F2 the plan treats a findings.json that lags decisions.json as hand-edited and refuses forever')
  assert.deepEqual(found(run.runDir), [], 'BUGHUNT-F2 findings.json is rewritten from the decided records (both were removed)')
})
// The harness only counts failures; make them the process's exit status.
if (summary().fail > 0) process.exitCode = 1
