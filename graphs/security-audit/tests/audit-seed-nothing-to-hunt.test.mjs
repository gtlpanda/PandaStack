// audit-seed-nothing-to-hunt.test.mjs - a seeded ledger with no hunter work (BUGHUNT F1 on the PR 5 branch): `next` routes to the
// final-clean critic as wave 1, the planned critic stage runs instead of escalating on wave 0, its prompt does not claim an earlier
// critic, and the mint and apply-critic after it carry the same wave, through to write-findings.
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { audit, ledgerCli } from './audit-fixtures.mjs'
import { ledgerValid } from './ledger-fixtures.mjs'
import { UNIT, reconToSeed, runStage } from './stage-fixtures.mjs'

const next = runDir => audit(['next', runDir]).last
const CRITIC = { missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: true }

await test('seed with every unit deferred or not_applicable: the final-clean critic runs as wave 1 (cf1), says no wave ran, and the run reaches write-findings', async () => {
  const { runDir } = await reconToSeed([
    UNIT('wait', { status: 'deferred', reason: 'budget_cannot_reserve_critics_and_validation' }),
    UNIT('na', { subsystemRef: 'two', status: 'not_applicable', reason: 'the app has no uploads' }),
  ])
  assert.equal(next(runDir), 'NEXT: critic run=workflow kind=final-clean wave=1')
  let prompt = ''
  const c = await runStage(runDir, { 'audit-researcher': [(p) => { prompt = p; return CRITIC }] })
  assert.equal(c.ran.result.status, 'done', JSON.stringify(c.ran.result.reason))
  assert.match(c.apply.last, /^AUDIT: OK apply critic kind=final-clean id=cf1 /)
  assert.match(prompt, /no hunting wave ran, because the seeded ledger had no hunter work/)
  assert.doesNotMatch(prompt, /a different critic has already looked/)
  assert.equal(JSON.parse(readFileSync(join(runDir, 'stage-state.json'), 'utf8')).wave, 1, 'the critic recorded its wave for the mint after it')
  assert.equal(next(runDir), 'NEXT: mint run=workflow wave=1')
  const m = await runStage(runDir, {})   // nothing to mint: no agent is called
  assert.match(m.apply.last, /^AUDIT: OK apply mint /, m.apply.stdout)
  assert.match(ledgerCli(['apply-critic', runDir, join(runDir, 'critic.json'), join(runDir, 'mint.json')]).last, /wave=1 kind=final-clean units_added=0/)
  assert.ok(ledgerValid(runDir))
  assert.equal(next(runDir), 'NEXT: write-findings run=helper', 'no candidates, so consolidate is skipped')
})

