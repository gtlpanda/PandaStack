import { randomUUID } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import { performance } from 'node:perf_hooks'
import { exactRecord, validId, timestampKey } from './records.mjs'

const invalid = () => Object.assign(new Error('Invalid decision observation'), { code: 'INVALID_OBSERVATION' })
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.exec(value)?.[0] === value
const outcomes = ['timeout', 'cancelled', 'expired', 'stale', 'manual_handoff', 'failed']
const waitKeys = ['queueNamespace', 'decisionRunId', 'featureId', 'decisionId', 'revision', 'deliveryId']
const stdout = event => process.stdout.write(`PANDASTACK_DECISION ${JSON.stringify(event)}\n`)

function requireValid(value) { if (!value) throw invalid() }

function traceOptions(input) {
  const keys = Reflect.ownKeys(input)
  requireValid(keys.every(key => ['repo', 'revision', 'invocationRunId', 'emit', 'now', 'monotonicNow'].includes(key)))
  const value = exactRecord(input, keys)
  requireValid(typeof value.repo === 'string' && !value.repo.includes('\0') && isAbsolute(value.repo) &&
    normalize(value.repo) === value.repo && (value.repo === '/' || !value.repo.endsWith('/')))
  requireValid(sha(value.revision) && (value.invocationRunId === null || validId(value.invocationRunId)))
  const { emit = stdout, now = () => new Date().toISOString(), monotonicNow = () => performance.now() } = value
  requireValid(typeof emit === 'function' && typeof now === 'function' && typeof monotonicNow === 'function')
  return { ...value, emit, now, monotonicNow }
}

// This helper reports host observations only. Queue acknowledgment, permission
// checks and provider work remain the caller's responsibility.
export function createDecisionTrace(input) {
  let opts
  try { opts = traceOptions(input) } catch { throw invalid() }
  const traceId = randomUUID(), spans = new Map()
  let incomplete = false, lastMonotonic = 0

  function guarded(work) {
    try { return work() }
    catch { incomplete = true; throw invalid() }
  }

  function clocks() {
    const at = opts.now()
    timestampKey(at)
    const monotonic = opts.monotonicNow()
    requireValid(typeof monotonic === 'number' && Number.isFinite(monotonic) && monotonic >= lastMonotonic)
    lastMonotonic = monotonic
    return { at, monotonic }
  }

  function publish(event) {
    // The sink and caller each receive their own snapshot; neither can corrupt
    // terminal replay or correlation metadata retained by the trace.
    try { opts.emit({ ...event }) } catch { incomplete = true }
    return { ...event }
  }

  function terminal(spanId, input, event) {
    return guarded(() => {
      requireValid(validId(spanId) && spans.has(spanId))
      const span = spans.get(spanId)
      const key = event === 'received' ? 'answerId' : 'outcome'
      const value = exactRecord(input, [key])[key]
      requireValid(key === 'answerId' ? validId(value) : outcomes.includes(value))
      if (span.terminal) {
        requireValid(span.terminal.event === event && span.terminal[key] === value)
        return { ...span.terminal }
      }
      const { at, monotonic } = clocks()
      const waitDurationMs = Math.floor(monotonic - span.started)
      requireValid(Number.isSafeInteger(waitDurationMs) && waitDurationMs >= 0)
      span.terminal = { ...span.waiting, event, eventId: randomUUID(), at,
        [key]: value, waitDurationMs }
      return publish(span.terminal)
    })
  }

  return {
    startWait(input) {
      return guarded(() => {
        const fields = exactRecord(input, waitKeys)
        requireValid(waitKeys.every(key => key === 'revision' ? sha(fields[key]) : validId(fields[key])))
        const { at, monotonic } = clocks(), spanId = randomUUID()
        const waiting = { schemaVersion: 2, event: 'waiting', eventId: randomUUID(), at, traceId,
          queueNamespace: fields.queueNamespace, spanId, repo: opts.repo,
          decisionRunId: fields.decisionRunId, invocationRunId: opts.invocationRunId,
          featureId: fields.featureId, decisionId: fields.decisionId, revision: fields.revision,
          deliveryId: fields.deliveryId }
        spans.set(spanId, { waiting, started: monotonic, terminal: null })
        return publish(waiting)
      })
    },
    finishWait(spanId, input) { return terminal(spanId, input, 'received') },
    failWait(spanId, input) { return terminal(spanId, input, 'wait_failed') },
    markIncomplete() { incomplete = true },
    get complete() {
      return !incomplete && opts.invocationRunId !== null && [...spans.values()].every(span => span.terminal !== null)
    },
  }
}
