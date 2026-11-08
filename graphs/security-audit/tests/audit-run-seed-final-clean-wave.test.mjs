// audit-run-seed-final-clean-wave.test.mjs - a seed with nothing to hunt must not route to a critic the critic stage rejects.
// security-audit-flow.js critic() escalates unless args.wave is an integer from 1, so `next` after seed has to offer one.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextStep } from '../skills/security-audit/audit-run.mjs'

const unit = status => ({ status, prior_status: 'new', attempts: [], result_fingerprints: [] })
const meta = { run_status: 'in_progress', incomplete_reason: null }
const seeded = ledger => ({ meta, state: { version: 1, last: 'seed', wave: 0, critic_kind: null }, ledger })
// The rule security-audit-flow.js critic() applies to args.wave (its isInt1).
const isInt1 = v => Number.isSafeInteger(v) && v >= 1


for (const [name, ledger] of [
  ['every unit out_of_scope', [unit('out_of_scope'), unit('out_of_scope')]],
  ['units deferred and not_applicable', [unit('deferred'), unit('not_applicable')]],
  ['every unit carried to its verifier', [{ ...unit('planned'), prior_status: 'prior_confirmed_same_source' }]],
  ['an empty ledger', []],
]) {
  test(`${name}: any critic step carries a wave the critic stage accepts`, () => {
    const next = nextStep(seeded(ledger))
    if (next.step === 'critic') {
      assert.ok(isInt1(next.wave), `BUGHUNT-F1 seed with nothing to hunt routes to the ${next.kind} critic at wave ${next.wave}; the critic stage escalates "args.wave must be the wave number, an integer from 1", so the run can never proceed`)
    }
  })
}
