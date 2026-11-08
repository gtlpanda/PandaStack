// audit-verify-apply-write-failed.test.mjs - a verify apply whose findings.json rewrite fails (a rename blocked here) must not close the step: the report would read
// a findings.json that still holds what Phase 5 changed. The step stays open, and the next verify plan rebuilds findings.json from decisions.json.
import { join } from 'node:path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { summary, test } from '../../../scripts/workflow-harness.mjs'
import { readJsonFile } from './ledger-fixtures.mjs'
import { returnedFile, runScript, stage, stageDirOf } from './stage-fixtures.mjs'
import { atVerify, decisions, next, passed, replaced } from './verdict-fixtures.mjs'

const TWO = [{ name: 'a', candidates: ['fp-a'] }, { name: 'b', candidates: ['fp-b'] }]
const found = runDir => JSON.parse(readFileSync(join(runDir, 'findings.json'), 'utf8'))
const finalTitles = runDir => decisions(runDir).entries.map(e => (e.phase5?.replacement?.record ?? e.record)?.title)

await test('a verify apply that dies on a findings.json rename is recovered by the next plan, which rebuilds findings.json from the saved decisions', async () => {
  const run = await atVerify(TWO)
  const plan = stage(['plan', run.runDir])
  assert.equal(plan.status, 0, plan.stdout)
  const dir = stageDirOf(plan, run.runDir)
  const input = readJsonFile(dir, 'input.json')
  const ran = await runScript(join(dir, 'run.js'), { 'audit-researcher': input.items.map(() => (p, opts) => (opts.label === input.items[0].agent_id ? replaced(input.items[0], { title: 'Reworded' }) : passed(input.items[1]))) })
  const blocker = join(run.runDir, 'findings.json.candidate')
  mkdirSync(blocker)
  writeFileSync(join(blocker, 'block'), 'x')
  const applied = stage(['apply', run.runDir, returnedFile(dir, ran.result)])
  assert.notEqual(applied.status, 0, 'the rename failure surfaces')
  assert.ok(!found(run.runDir).some(r => r.title === 'Reworded'), 'the rewrite did not land')
  assert.equal(next(run.runDir), 'NEXT: verify run=workflow', 'the step is not closed')
  rmSync(blocker, { recursive: true, force: true })
  const again = stage(['plan', run.runDir])
  assert.doesNotMatch(again.stdout + again.stderr, /findings\.json is not the decided records/)
  assert.ok(found(run.runDir).some(r => r.title === 'Reworded'), 'findings.json is rebuilt from the decisions')
  assert.equal(next(run.runDir), 'NEXT: report run=helper')
})

if (summary().fail > 0) process.exitCode = 1
