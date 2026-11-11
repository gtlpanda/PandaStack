// native-stage-spend.test.mjs - createAuditStageCheckpoints: the opt-in stage bridge projects this invocation's actual journal rows into the spend
// ledger at every publication, before the report is published and acknowledged. Sequential fixtures on the real journal owner and real capture.
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { newInit } from './stage-fixtures.mjs'
import { openAuditJournal, readAuditJournal } from '../skills/security-audit/dispatch-journal.mjs'
import { createAuditCheckpoints, createAuditStageCheckpoints } from '../skills/security-audit/native-checkpoints.mjs'
import { publishPartialReport, readPartialReport } from '../skills/security-audit/audit-report.mjs'
import { planNativeStage } from '../skills/security-audit/audit-stage.mjs'

const meta = runDir => JSON.parse(readFileSync(join(runDir, 'run-metadata.json'), 'utf8'))
const failed = { outcome: 'failed', code: 'PROVIDER_REFUSED', usage: null, receipt: { provider: 'codex', model: 'fixture', effort: 'high', invocationId: 'owned' } }
const signal = new AbortController().signal

async function fixture(work) {
  const { runDir } = newInit()
  const planned = planNativeStage(runDir)   // the real capture, in the real stage directory
  const journal = openAuditJournal({ runDir, invocationLimit: 6 })
  journal.initControl({ initialGrant: 6 })
  publishPartialReport(runDir)
  journal.acknowledgeReport({ expectedRevision: journal.getControl().revision })
  const open = () => createAuditStageCheckpoints({ runDir, journal, stageName: planned.stage.name, invocationId: planned.invocationId })
  const ports = []
  const track = p => { ports.push(p); return p }
  try { await work({ runDir, journal, stageName: planned.stage.name, invocationId: planned.invocationId, open: () => track(open()) }) }
  finally { for (const p of ports) await p.close().catch(() => {}); journal.close() }
}
const spentOf = (runDir, stageName) => meta(runDir).stage_spend?.[stageName]

console.log('== native stage spend projection')
await test('live dispatched rows are projected before publication; settling does not change the count and the report stays current', () => fixture(async ({ runDir, stageName, invocationId, open }) => {
  const port = open()
  assert.deepEqual(await port.reserve({ callId: 'a', invocationId }, { signal }), { state: 'dispatch' })
  assert.equal(spentOf(runDir, stageName), 1)
  assert.equal(readPartialReport(runDir).status, 'current')
  assert.deepEqual(await port.reserve({ callId: 'b', invocationId }, { signal }), { state: 'dispatch' })
  assert.equal(spentOf(runDir, stageName), 2)
  assert.equal(meta(runDir).agents_spent, 2)
  await port.settle('a', failed, { signal })
  await port.settle('b', failed, { signal })
  assert.equal(spentOf(runDir, stageName), 2)
  assert.equal(readAuditJournal(runDir).rows.length, 2)
  assert.equal(readPartialReport(runDir).status, 'current')
}))

await test('a replay of settled rows is not counted twice; a new call adds exactly one', () => fixture(async ({ runDir, stageName, invocationId, open }) => {
  const first = open()
  await first.reserve({ callId: 'a', invocationId }, { signal })
  await first.settle('a', failed, { signal })
  await first.close()
  const replay = open()
  assert.deepEqual(await replay.reserve({ callId: 'a', invocationId }, { signal }), { state: 'completed', completion: failed })
  assert.equal(spentOf(runDir, stageName), 1)
  await replay.reserve({ callId: 'c', invocationId }, { signal })
  assert.equal(spentOf(runDir, stageName), 2)
  assert.equal(readAuditJournal(runDir).rows.length, 2)
  await replay.settle('c', failed, { signal })
}))

await test('a binding for another invocation refuses before any journal or ledger mutation', () => fixture(async ({ runDir, journal, stageName, invocationId, open }) => {
  const port = open()
  await port.reserve({ callId: 'a', invocationId }, { signal })
  const rows = readAuditJournal(runDir), control = journal.getControl(), ledger = meta(runDir)
  for (const binding of [{ callId: 'x', invocationId: 'f'.repeat(64) }, { callId: 'y' }, { callId: 'a', invocationId: 'e'.repeat(64) }, null, 'a']) {
    await assert.rejects(port.reserve(binding, { signal }), e => e.code === 'INVOCATION_MISMATCH')
  }
  assert.deepEqual(readAuditJournal(runDir), rows)
  assert.deepEqual(journal.getControl(), control)
  assert.deepEqual(meta(runDir), ledger)
  assert.equal(spentOf(runDir, stageName), 1)
  await port.settle('a', failed, { signal })
}))

await test('an uncertain charged intent stays in the projected count and is not rewritten', () => fixture(async ({ runDir, stageName, invocationId, open }) => {
  const port = open()
  await port.reserve({ callId: 'u', invocationId }, { signal })
  await port.uncertain('u', { code: 'RUNTIME_ABORTED' }, { signal: undefined })
  assert.equal(readAuditJournal(runDir).rows[0].state, 'uncertain')
  assert.equal(spentOf(runDir, stageName), 1)
  const before = readAuditJournal(runDir), ledger = meta(runDir)
  await port.uncertain('u', { code: 'RUNTIME_ABORTED' }, { signal: undefined })
  assert.deepEqual(readAuditJournal(runDir), before)
  assert.deepEqual(meta(runDir), ledger)
}))

await test('the stage and invocation are checked against the actual capture; nothing is projected on refusal', () => fixture(async ({ runDir, journal, stageName, invocationId }) => {
  const base = { runDir, journal }
  const ledger = meta(runDir)
  for (const patch of [
    { stageName: '../' + stageName, invocationId }, { stageName: 'Stage-1', invocationId }, { stageName: '99-missing', invocationId },
    { stageName, invocationId: '0'.repeat(64) }, { stageName, invocationId: invocationId.toUpperCase() }, { stageName, invocationId: 'short' },
    { stageName }, { stageName, invocationId, onPublish: () => {} },
  ]) assert.throws(() => createAuditStageCheckpoints({ ...base, ...patch }), e => ['INVALID_JOURNAL_INPUT', 'CAPTURE_INVALID'].includes(e.code))
  assert.deepEqual(meta(runDir), ledger)
}))

await test('the legacy bridge never projects spend', () => fixture(async ({ runDir, journal, invocationId }) => {
  const port = createAuditCheckpoints({ runDir, journal }), before = meta(runDir)
  try {
    await port.reserve({ callId: 'legacy', invocationId }, { signal })
    assert.deepEqual(meta(runDir), before)
    await port.uncertain('legacy', { code: 'RUNTIME_ABORTED' }, { signal: undefined })
  } finally {
    if (readAuditJournal(runDir).rows.some(r => r.id === 'legacy' && r.state === 'dispatched')) await port.uncertain('legacy', { code: 'RUNTIME_ABORTED' }, {})
    await port.close()
  }
}))
