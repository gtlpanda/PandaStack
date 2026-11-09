// audit-e2e-quick-budget.test.mjs - the whole offline quick audit of the toy repository (P-09's drive) under the two strict budgets just below what it spends, pinned exactly.
// P-09's acceptance test accepts either outcome at 12; this file pins which one the code gives, and that 11 is where quick first runs out of verifiers.
// The arithmetic: recon 4 + synthesis 1 + one hunter + the critic + its minter = 8 agents before consolidate; four candidates; quick funds floor(left / 1) of them.
// consolidateInput skips the grouping when its agent would lower that number (audit-verdicts.mjs), so at 12 (4 left) the grouping is skipped and all four
// verifiers run, and at 11 (3 left) it is skipped and three of the four run.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { audit, meta, mkRepo } from './audit-fixtures.mjs'
import { driveAudit } from './e2e-driver.mjs'
import { TOY_FILES } from './toy-app.mjs'
import { validateFindingsFile, validateLedgerFile } from '../skills/security-audit/upstream.mjs'
import { quickAnswer } from './profile-e2e-support.mjs'

console.log('== quick end to end under budgets 12 and 11')

async function quickUnderBudget(budget) {
  const d = await driveAudit({ repo: mkRepo(TOY_FILES, 'toy'), answer: quickAnswer, initArgs: ['--profile', 'quick', '--budget', String(budget)], tolerateRefusals: true })
  const labels = d.trace.flatMap(s => s.calls.map(c => c.label))
  return { RUN: d.RUN, meta: meta(d.RUN), labels, verifiers: labels.filter(l => /^v\d+$/.test(l)) }
}

function assertArtifactsValid(RUN) {
  assert.equal(audit(['check', RUN]).last, `AUDIT: OK ${RUN} passes check`)
  const ledger = validateLedgerFile(join(RUN, 'coverage-ledger.json'))
  assert.ok(ledger.valid, ledger.lastLine)
  const findings = validateFindingsFile(join(RUN, 'findings.json'))
  assert.ok(findings.valid, findings.lastLine)
}

const at12 = await quickUnderBudget(12)
await test('quick at budget 12 skips the grouping to keep its agent for a verifier, funds all four candidates and ends complete with 12 agents', () => {
  assert.deepEqual([at12.meta.run_status, at12.meta.incomplete_reason, at12.meta.agents_spent, at12.meta.budget], ['complete', null, 12, 12])
  assert.ok(!at12.labels.includes('synth-cons'), `no grouping agent: ${at12.labels.join(',')}`)
  assert.equal(at12.verifiers.length, 4, at12.verifiers.join(','))
  assert.equal(audit(['next', at12.RUN]).last, 'NEXT: done status=complete')
  assertArtifactsValid(at12.RUN)
})

const at11 = await quickUnderBudget(11)
await test('quick at budget 11 funds three of the four candidates and ends incomplete with validation_budget_exhausted, never spending past 11', () => {
  assert.deepEqual([at11.meta.run_status, at11.meta.incomplete_reason, at11.meta.agents_spent, at11.meta.budget], ['incomplete', 'validation_budget_exhausted', 11, 11])
  assert.ok(!at11.labels.includes('synth-cons'), `no grouping agent: ${at11.labels.join(',')}`)
  assert.equal(at11.verifiers.length, 3, at11.verifiers.join(','))
  assertArtifactsValid(at11.RUN)
  const report = readFileSync(join(at11.RUN, 'REPORT.md'), 'utf8')
  assert.ok(report.includes('**This is a partial pass:**'), 'an incomplete quick run is still a partial pass')
})
