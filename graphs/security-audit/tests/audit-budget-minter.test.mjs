// audit-budget-minter.test.mjs - the per-wave minter is a call this graph adds (upstream's parent mints units itself), so the reserve the budget keeps for critics and
// validation has to count it, as it counts the recon synthesizer (retro 38). Without it a minter takes what the plan holds for the verifiers: reproduced first, with a budget
// where the wave's hunters fill exactly what waveAllowance gave them and the validation reserve holds one candidate's two agents (a verifier and its Phase 5 verifier).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { MINT_CALLS, RECON_CALLS, SYNTHESIS_CALLS, budgetGate, criticReserve, minimumBudget, reconGate, validationReserve, waveAllowance } from '../skills/security-audit/audit-run.mjs'
import { init, meta, mkRepo } from './audit-fixtures.mjs'
import { driveAudit } from './e2e-driver.mjs'
import { answer } from './toy-agents.mjs'
import { TOY_FILES } from './toy-app.mjs'

console.log('== the reserve counts the minter')
await test('every call a profile needs before its first verifier is counted once: reconnaissance, synthesis, each critic and the minter that follows it, and one verifier', () => {
  assert.equal(MINT_CALLS, 1)
  for (const profile of ['quick', 'standard', 'deep']) assert.equal(minimumBudget(profile), RECON_CALLS + SYNTHESIS_CALLS + criticReserve(profile) * (1 + MINT_CALLS) + 1, profile)
  assert.deepEqual([minimumBudget('quick'), minimumBudget('standard'), minimumBudget('deep')], [8, 10, 10])
  const gate = budgetGate('standard', 9)
  assert.deepEqual([gate.ok, gate.minimum, gate.reason], [false, 10, 'budget_cannot_fund_reconnaissance_and_reserves'])
  assert.equal(budgetGate('standard', 10).ok, true)
})
await test('a wave may launch only what is left after the critics, the minters that follow them, and the validation reserve of the balance after both', () => {
  assert.deepEqual(waveAllowance('standard', 20), { critics: 2, minters: 2, validation: 5, hunters: 11, reason: null })   // 30% of the 16 left after four calls, rounded up
  assert.deepEqual(waveAllowance('standard', 10, 3), { critics: 2, minters: 2, validation: 6, hunters: 0, reason: 'budget_cannot_reserve_critics_and_validation' })
  assert.deepEqual(waveAllowance('quick', 10, 3), { critics: 1, minters: 1, validation: 3, hunters: 5, reason: null })
  for (const profile of ['quick', 'standard', 'deep']) for (const remaining of [0, 1, 4, 7, 12, 40]) {
    const w = waveAllowance(profile, remaining)
    assert.equal(w.hunters + w.critics + w.minters + w.validation <= Math.max(remaining, w.critics + w.minters + w.validation), true, `${profile} ${remaining}`)
    assert.ok(w.hunters === 0 || w.hunters + w.critics + w.minters + w.validation === remaining, `${profile} ${remaining}: hunters fill exactly what the reserves leave`)
    assert.equal(w.validation, validationReserve(profile, Math.max(0, remaining - w.critics - w.minters)))
  }
})
await test('reconGate for the synthesizer needs the minters too', () => {
  const min = minimumBudget('standard')
  assert.deepEqual(reconGate('standard', min, RECON_CALLS, 'synthesize'), { ok: true, needed: min - RECON_CALLS, reason: null })
  assert.equal(reconGate('standard', min - 1, RECON_CALLS, 'synthesize').ok, false)
  assert.equal(SYNTHESIS_CALLS + criticReserve('standard') * (1 + MINT_CALLS) + 1, min - RECON_CALLS)
})

console.log('== a whole run on a tight budget')
// What plan-wave promised when it launched a wave: after the wave, the critics and the minters that follow them can take what the reserve names for them, and the validation reserve
// is still there. Before the minter was counted this failed on the toy app (all four candidates, recon five agents) for budgets 11, 12, 13 and 16: waveAllowance(7) at budget 12 gave 3
// hunters and a validation reserve of 2, the post-wave critic, its minter and the final-clean critic took 3 of the 4 left, and validate had 1 and funded no candidate.
const RESERVE = /hunters=([1-9])/
for (const budget of [11, 12, 13, 14, 15, 16, 18, 20, 24]) {
  await test(`budget ${budget}: what validate is left with is at least the validation reserve the last wave that launched hunters kept back, and nothing is spent past the budget`, async () => {
    const repo = mkRepo(TOY_FILES, 'toy')
    let spent = 0, last = null, leftAtValidate = null
    const run = await driveAudit({ repo, answer, initArgs: ['--budget', String(budget)], tolerateRefusals: true, onStep: e => {
      if (e.step === 'plan-wave' && RESERVE.test(e.commands[0]?.last ?? '')) last = { remaining: budget - spent, ...waveAllowance('standard', budget - spent) }
      if (e.step === 'validate' && leftAtValidate === null) leftAtValidate = budget - spent
      spent += e.calls.length
    } })
    assert.ok(meta(run.RUN).agents_spent <= budget, `${meta(run.RUN).agents_spent} agents spent of ${budget}`)
    assert.equal(meta(run.RUN).agents_spent, run.agentsCalled)
    assert.ok(last, 'a wave launched hunters')
    assert.ok(leftAtValidate !== null, 'validate was reached')
    assert.ok(leftAtValidate >= last.validation, `validate was left ${leftAtValidate}; the last wave (${last.remaining} remaining) kept ${last.validation} back for validation (${JSON.stringify(last)})`)
  })
}
await test('a budget that cannot fund the minters too is refused at init, with the minters in the message, before any agent runs', () => {
  const repo = mkRepo(TOY_FILES, 'toy')
  const r = init([repo, '--full', '--budget', '9'])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL budget_cannot_fund_reconnaissance_and_reserves: --budget 9 cannot fund the 10 calls profile standard needs first \(4 reconnaissance, 1 synthesis, 2 critics, 2 minters, 1 verifier\); no agent was launched/)
  assert.equal(meta(join(repo, '.git', 'security-audit', 'run-1')).agents_spent, 0)
  assert.equal(init([mkRepo(TOY_FILES, 'toy'), '--full', '--budget', '10']).ok, true)
})

console.log('== what the smallest budget does (the README and the skill say it)')
await test('the smallest budget init accepts launches no hunter: the run ends complete with every unit deferred and the report calls it a partial pass; one more agent launches a hunter', async () => {
  const min = minimumBudget('standard')
  const repo = mkRepo(TOY_FILES, 'toy')
  const run = await driveAudit({ repo, answer, initArgs: ['--budget', String(min)], tolerateRefusals: true })
  const labels = run.trace.flatMap(e => e.calls.map(c => c.label))
  assert.deepEqual(labels.filter(l => /^h\d/.test(l)), [], 'no hunter at the minimum')
  assert.deepEqual([meta(run.RUN).run_status, meta(run.RUN).incomplete_reason], ['complete', null])
  const ledger = JSON.parse(readFileSync(join(run.RUN, 'coverage-ledger.json'), 'utf8'))
  assert.deepEqual([...new Set(ledger.map(u => u.status))], ['deferred'])
  assert.ok(ledger.every(u => u.unresolved.includes('budget_cannot_reserve_critics_and_validation')))
  const report = readFileSync(join(run.RUN, 'REPORT.md'), 'utf8')
  assert.ok(report.includes('This is a partial pass') && report.includes('some coverage was deferred'))
  const more = await driveAudit({ repo: mkRepo(TOY_FILES, 'toy'), answer, initArgs: ['--budget', String(min + 1)], tolerateRefusals: true })
  assert.ok(more.trace.flatMap(e => e.calls).some(c => /^h\d/.test(c.label)), 'one more than the minimum launches a hunter')
})
