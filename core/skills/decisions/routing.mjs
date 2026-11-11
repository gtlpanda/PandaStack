import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { exactRecord, validId } from './records.mjs'
import { guarded, queueError } from './queue-storage.mjs'

// Node timers overflow above this bound. Zero timeout permits one immediate try.
export const MAX_WAIT_MS = 2147483647
function options(input) {
  try {
    const keys = Reflect.ownKeys(input)
    if (!keys.every(key => ['queue', 'id', 'recipient', 'pollMs', 'timeoutMs', 'signal'].includes(key))) throw Error()
    const value = exactRecord(input, keys)
    const { queue, id, signal, pollMs = 100, timeoutMs = 60000 } = value
    if (typeof queue?.deliver !== 'function' || !validId(id) ||
        !Number.isInteger(pollMs) || pollMs < 1 || pollMs > MAX_WAIT_MS ||
        !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS ||
        (signal !== undefined && !(signal instanceof AbortSignal))) throw Error()
    const recipient = exactRecord(value.recipient, ['repo', 'runId', 'revision', 'deliveryId'])
    return { queue, id, recipient, signal, pollMs, timeoutMs }
  } catch { throw queueError('INVALID_DECISION') }
}

// Delivery is durable; applying an answer and acknowledging it belong to the
// consumer. Effects need their own checkpoint/idempotency across process restarts.
export async function waitForDecision(input) {
  const { queue, id, recipient, signal, pollMs, timeoutMs } = options(input)
  const deadline = performance.now() + timeoutMs
  let first = true
  for (;;) {
    if (signal?.aborted) throw queueError('CANCELLED')
    if (!first && performance.now() >= deadline) throw queueError('TIMEOUT')
    first = false
    try {
      // A single transactional operation checks identity and live state on every
      // poll, including pending requests. Only NOT_READY is safe to retry.
      return guarded(() => queue.deliver(id, recipient))
    } catch (error) {
      if (error.code !== 'NOT_READY') throw error
    }
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw queueError('TIMEOUT')
    try { await delay(Math.min(pollMs, remaining), undefined, { signal }) }
    catch { throw queueError(signal?.aborted ? 'CANCELLED' : 'IO_ERROR') }
  }
}
