import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'
import { createDecisionQueue } from '../core/skills/decisions/queue.mjs'
import { deliverToCodex } from '../core/skills/decisions/codex-delivery.mjs'
import { decisionMain } from '../scripts/decision-cli.mjs'

await test('CLI ack retains manual handoff after uncertain native delivery across reopen without resend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decision-handoff-')), store = join(root, 'queue')
  const revision = 'a'.repeat(40), recipient = { repo: '/fixture', runId: 'run', revision, deliveryId: 'delivery' }
  let q, calls = 0
  try {
    q = createDecisionQueue(store)
    q.request({ schemaVersion: 1, id: 'choice', runId: 'run', repo: '/fixture', revision,
      question: 'Which mode?', reason: 'Need a choice', options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }],
      recommendation: null, evidence: [], kind: 'question', scope: null, createdAt: '2026-01-01T00:00:00Z', expiresAt: null })
    q.answer('choice', { answerId: 'answer', value: 'one', actor: 'Fixture', at: '2026-01-01T00:00:01Z', revision })
    const send = () => deliverToCodex({ queue: q, id: 'choice', recipient,
      target: { threadId: 'thread', turnId: 'turn' }, transport: async () => { calls++; throw Error('PRIVATE_INPUT') } })
    await assert.rejects(send(), { code: 'MANUAL_HANDOFF' })
    q.close(); q = null
    const file = join(root, 'recipient.json'); writeFileSync(file, JSON.stringify(recipient))
    const out = [], err = [], log = console.log, error = console.error
    let status
    console.log = value => out.push(value); console.error = value => err.push(value)
    try { status = await decisionMain(['ack', '--store', store, '--id', 'choice', '--file', file]) }
    finally { console.log = log; console.error = error }
    assert.equal(status, 1); assert.deepEqual(out, []); assert.deepEqual(err, ['{"error":"MANUAL_HANDOFF"}'])
    q = createDecisionQueue(store)
    assert.equal(q.read('choice').ack, null)
    await assert.rejects(send(), { code: 'MANUAL_HANDOFF' }); assert.equal(calls, 1)
  } finally { q?.close(); rmSync(root, { recursive: true, force: true }) }
})
