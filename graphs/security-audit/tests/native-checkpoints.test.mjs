import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { newInit } from './stage-fixtures.mjs'
import { openAuditJournal, readAuditJournal } from '../skills/security-audit/dispatch-journal.mjs'
import { createAuditCheckpoints } from '../skills/security-audit/native-checkpoints.mjs'
import { publishPartialReport } from '../skills/security-audit/audit-report.mjs'

async function fixture(work) {
  const { runDir } = newInit()
  const journal = openAuditJournal({ runDir, invocationLimit: 4 })
  journal.initControl({ initialGrant: 4 })
  publishPartialReport(runDir)
  journal.acknowledgeReport({ expectedRevision: journal.getControl().revision })
  const port = createAuditCheckpoints({ runDir, journal })
  try { await work({ runDir, journal, port }) }
  finally { await port.close(); journal.close() }
}
await test('native checkpoint close refuses active intent; repeated uncertain join retains one charged row', () => fixture(async ({ runDir, port }) => {
  const signal = new AbortController().signal
  assert.deepEqual(await port.reserve({ callId: 'owned' }, { signal }), { state: 'dispatch' })
  await assert.rejects(port.close(), e => e.code === 'BUSY')
  await port.uncertain('owned', { code: 'RUNTIME_ABORTED' }, { signal })
  const before = readAuditJournal(runDir)
  await port.uncertain('owned', { code: 'RUNTIME_ABORTED' }, { signal })
  assert.deepEqual(readAuditJournal(runDir), before)
  assert.equal(before.heldCalls, 1)
  assert.equal(before.rows[0].state, 'uncertain')
}))
await test('native checkpoint known transport failure is replayable evidence, and changed binding conflicts while paused', () => fixture(async ({ runDir, journal, port }) => {
  const binding = { callId: 'known', promptHash: 'original' }, signal = new AbortController().signal
  await port.reserve(binding, { signal })
  const completion = { outcome: 'failed', code: 'PROVIDER_REFUSED', usage: null,
    receipt: { provider: 'codex', model: 'fixture', effort: 'high', invocationId: 'owned' } }
  await port.settle('known', completion, { signal })
  journal.pauseControl({ expectedRevision: journal.getControl().revision, reason: 'paused_budget' })
  assert.deepEqual(await port.reserve(binding, { signal }), { state: 'completed', completion })
  await assert.rejects(port.reserve({ ...binding, promptHash: 'changed' }, { signal }), e => e.code === 'CONFLICT')
  assert.equal(readAuditJournal(runDir).settledCalls, 1)
}))
