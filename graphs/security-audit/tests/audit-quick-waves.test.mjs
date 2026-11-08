// audit-quick-waves.test.mjs - the edges of quick's one wave and one critic (audit-ledger.mjs buildCritic's quick deferral, audit-run.mjs nextStep) beyond what
// the acceptance test (profile-quick-waves.test.mjs) pins: a unit whose hunter result failed once is deferred too; the dry run (applyCriticProblems) sees the
// deferred ledger the write would make; the deferred count reaches the event log for quick only; the critic_kind check still guards quick's exit to validation.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '../../../scripts/workflow-harness.mjs'
import { applyCritic, applyCriticProblems } from '../skills/security-audit/audit-ledger.mjs'
import { nextStep } from '../skills/security-audit/audit-run.mjs'
import { audit } from './audit-fixtures.mjs'
import { ledgerValid, readLedger, unitInput } from './ledger-fixtures.mjs'
import { QUICK_DEFERRED, afterWave, byName, critic, gap, quickUnit } from './profile-support.mjs'

const lastEvent = runDir => JSON.parse(readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').at(-1))
const noResults = () => ({})   // every hunter returned nothing: merge-wave returns its units to planned, failed once

await test('quick: a unit whose hunter result failed once (back to planned, failed_attempts 1) is deferred with quick_profile_final_critic, not left for a wave that never comes', () => {
  const { runDir } = afterWave([unitInput('a'), unitInput('b')], { profile: 'quick', results: noResults })
  const before = byName(readLedger(runDir))
  assert.deepEqual([before.a.status, before.a.failed_attempts, before.b.status], ['planned', 1, 'planned'], 'the fixture: both failed once')
  const out = applyCritic(runDir, critic(), { units: [] })
  assert.match(out.summary, / deferred=2$/, out.summary)
  const after = byName(readLedger(runDir))
  for (const u of [after.a, after.b]) assert.deepEqual([u.status, u.agent_id, u.unresolved], ['deferred', null, [QUICK_DEFERRED]])
  assert.ok(ledgerValid(runDir))
  assert.equal(audit(['next', runDir]).last, 'NEXT: write-findings run=helper', 'nothing to validate: straight to write-findings')
})

await test('quick: the dry run (applyCriticProblems) judges the deferred ledger the write makes, so a result it passes is one apply-critic accepts', () => {
  const { runDir } = afterWave([unitInput('a'), unitInput('b')], { profile: 'quick', results: noResults })
  const c = critic({ missing_units: [gap('g')] }), mint = { units: [quickUnit('m')] }
  assert.deepEqual(applyCriticProblems(runDir, c, mint), [])
  const out = applyCritic(runDir, c, mint)
  assert.match(out.summary, /units_added=1 .* deferred=3$/, out.summary)
  assert.ok(ledgerValid(runDir))
})

await test('the deferred count reaches the apply-critic event for quick only; standard\'s and deep\'s event counts have no deferred key', () => {
  for (const profile of ['quick', 'standard', 'deep']) {
    const { runDir } = afterWave([unitInput('a')], { profile, results: noResults })
    applyCritic(runDir, critic(), { units: [] })
    const { counts } = lastEvent(runDir)
    if (profile === 'quick') assert.equal(counts.deferred, 1, JSON.stringify(counts))
    else assert.ok(!('deferred' in counts), `${profile}: ${JSON.stringify(counts)}`)
  }
})

await test('nextStep: a quick apply-critic with no critic_kind is still refused before it goes to validation', () => {
  const meta = { run_status: 'in_progress', incomplete_reason: null, profile: 'quick' }
  const state = { version: 1, last: 'apply-critic', wave: 1, critic_kind: null }
  assert.throws(() => nextStep({ meta, state, ledger: [] }), /no critic_kind/)
})
