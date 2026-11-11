import assert from 'node:assert/strict'
import { test } from '../scripts/workflow-harness.mjs'
import { fixture, checkpointPort, reconArgs, research } from '../acceptance/native-runtime/nr-02-runtime-support.mjs'
async function using(options, work) {
  const cleanup = []
  try { await work(await fixture({ after: fn => cleanup.push(fn) }, { answer: research, cap: 1, ...options })) }
  finally { for (const fn of cleanup) await fn() }
}
await test('malformed reserve pauses remain fatal through the actual parallel audit graph', async () => {
  for (const blockers of [['bogus'], ['report_stale', 'paused_budget'], [], ['paused_budget', 'paused_budget'], null]) {
    const port = checkpointPort(); let reserves = 0
    port.reserve = async () => { reserves++; return { state: 'paused', blockers } }
    await using({ checkpoints: port }, async f => {
      await assert.rejects(f.runtime.run('security-audit-flow', reconArgs(), { invocationId: 'malformed-pause' }), e => e.code === 'CHECKPOINT_ERROR')
      assert.equal(f.calls.length, 0)
      assert.equal(reserves, 1, 'fatal admission stops queued leaves')
    })
  }
})
await test('valid reserve pause remains controlled and preserves exact blockers', async () => {
  const port = checkpointPort()
  port.reserve = async () => ({ state: 'paused', blockers: ['paused_budget', 'report_stale'] })
  await using({ checkpoints: port }, async f => {
    await assert.rejects(f.runtime.run('security-audit-flow', reconArgs(), { invocationId: 'valid-pause' }), e => {
      assert.equal(e.code, 'CONTROL_PAUSED'); assert.deepEqual(e.blockers, ['paused_budget', 'report_stale']); return true
    })
    assert.equal(f.calls.length, 0)
  })
})
await test('null leaf selection uses the owning invalid-selection error before reservation', async () => {
  await using({ resolveLeaf: () => null }, async f => {
    await assert.rejects(f.runtime.run('security-audit-flow', reconArgs(), { invocationId: 'null-selection' }), e => e.code === 'INVALID_SELECTION')
    assert.equal(f.calls.length, 0); assert.equal(f.checkpoints.rows.size, 0)
  })
})
await test('unapproved selection extensions do not widen the frozen leaf contract', async () => {
  await using({ resolveLeaf: () => ({ selection: { provider: 'codex', model: 'fixture', effort: 'high' }, profile: 'audit-source-only', executionDigest: 'a'.repeat(64) }) }, async f => {
    await assert.rejects(f.runtime.run('security-audit-flow', reconArgs(), { invocationId: 'extra-selection' }), e => e.code === 'INVALID_SELECTION')
    assert.equal(f.calls.length, 0); assert.equal(f.checkpoints.rows.size, 0)
  })
})
