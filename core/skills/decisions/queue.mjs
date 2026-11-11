import { isAbsolute, normalize } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { createDecision, validId, validText, exactRecord, timestampKey } from './records.mjs'
import { guarded, queueError, openQueueStorage } from './queue-storage.mjs'

const states = ['pending', 'answered', 'delivered', 'acknowledged', 'cancelled']
const recipientKeys = ['deliveryId', 'repo', 'runId', 'revision']
const requireValid = condition => { if (!condition) throw queueError('INVALID_DECISION') }
const validRepo = value => typeof value === 'string' && !value.includes('\0') && isAbsolute(value) &&
  normalize(value) === value && (value === '/' || !value.endsWith('/'))
const validRevision = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && value.length === 40
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
function input(work) {
  try { return work() } catch { throw queueError('INVALID_DECISION') }
}
function identifier(id) { requireValid(validId(id)); return id }
function recipient(value) {
  const result = exactRecord(value, recipientKeys)
  requireValid(validId(result.deliveryId) && validId(result.runId) && validRepo(result.repo) && validRevision(result.revision))
  return result
}
function codexTarget(value) {
  const result = exactRecord(value, ['threadId', 'turnId'])
  requireValid(Object.values(result).every(id => validText(id, 256) && !/[\u0000-\u001f\u007f-\u009f]/.test(id)))
  return result
}
function storedDispatch(value) {
  const dispatch = exactRecord(value.codexDispatch, ['dispatchId', 'target', 'state', 'receipt'])
  requireValid(validId(dispatch.dispatchId) && ['inflight', 'acknowledged'].includes(dispatch.state))
  dispatch.target = codexTarget(dispatch.target)
  requireValid(value.decision.kind === 'question' && value.delivery !== null)
  if (dispatch.state === 'inflight') requireValid(dispatch.receipt === null && value.ack === null)
  else {
    dispatch.receipt = exactRecord(dispatch.receipt, ['turnId'])
    requireValid(dispatch.receipt.turnId === dispatch.target.turnId && value.ack !== null)
  }
  return dispatch
}
function answerInput(value) {
  const result = exactRecord(value, ['answerId', 'value', 'actor', 'at', 'revision'])
  requireValid(validId(result.answerId) && validId(result.value) && validText(result.actor, 256) && validRevision(result.revision))
  timestampKey(result.at)
  return result
}
function cancellation(value) {
  const result = exactRecord(value, ['reason'])
  requireValid(validText(result.reason, 4096))
  return result
}
function matchingRecipient(decision, target) {
  if (target.repo !== decision.repo || target.runId !== decision.runId) throw queueError('WRONG_RECIPIENT')
  if (target.revision !== decision.revision) throw queueError('STALE')
}
function validAnswer(decision, answer) {
  requireValid(decision.options.some(option => option.id === answer.value))
  requireValid(timestampKey(answer.at) >= timestampKey(decision.createdAt))
}
function stored(row) {
  if (!row) return null
  try {
    const parsed = JSON.parse(row.snapshot)
    const keys = ['decision', 'state', 'answer', 'delivery', 'ack', 'cancellation']
    // Existing version 1 snapshots need no rewrite. Native dispatch is an
    // optional internal extension; the public queue snapshot stays unchanged.
    if (parsed && Object.hasOwn(parsed, 'codexDispatch')) keys.push('codexDispatch')
    const value = exactRecord(parsed, keys)
    value.decision = createDecision(value.decision)
    requireValid(value.decision.id === row.id && states.includes(value.state))
    if (value.answer !== null) {
      value.answer = answerInput(value.answer)
      validAnswer(value.decision, value.answer)
      requireValid(value.answer.revision === value.decision.revision)
      requireValid(value.decision.expiresAt === null || timestampKey(value.answer.at) < timestampKey(value.decision.expiresAt))
    }
    if (value.delivery !== null) {
      value.delivery = recipient(value.delivery)
      matchingRecipient(value.decision, value.delivery)
      requireValid(value.answer !== null)
    }
    if (value.ack !== null) {
      value.ack = recipient(value.ack)
      requireValid(value.delivery !== null && isDeepStrictEqual(value.ack, value.delivery))
    }
    if (value.cancellation !== null) value.cancellation = cancellation(value.cancellation)
    requireValid((value.state === 'cancelled') === (value.cancellation !== null))
    switch (value.state) {
      case 'pending': requireValid(value.answer === null && value.delivery === null && value.ack === null); break
      case 'answered': requireValid(value.answer !== null && value.delivery === null && value.ack === null); break
      case 'delivered': requireValid(value.delivery !== null && value.ack === null); break
      case 'acknowledged': requireValid(value.ack !== null); break
      case 'cancelled': requireValid(value.ack === null); break
    }
    if (Object.hasOwn(value, 'codexDispatch')) value.codexDispatch = storedDispatch(value)
    return value
  } catch { throw queueError('CORRUPT') }
}
function publicSnapshot(value) {
  if (value === null) return null
  const { decision, state, answer, delivery, ack } = value
  return { decision, state, answer, delivery, ack }
}

// Local scoped bookkeeping only: actor is attribution, never authentication.
// authorize() does not establish human consent or execute any action.
export function createDecisionQueue(directory, options = {}) {
  return guarded(() => {
    const now = input(() => {
      requireValid(options !== null && typeof options === 'object')
      const keys = Reflect.ownKeys(options)
      requireValid(keys.every(key => key === 'now'))
      const values = exactRecord(options, keys)
      requireValid(values.now === undefined || typeof values.now === 'function')
      return values.now ?? (() => new Date().toISOString())
    })
    const storage = openQueueStorage(directory)
    function currentTime() {
      try { return timestampKey(now()) } catch { throw queueError('IO_ERROR') }
    }
    function live(value, time) {
      if (value.state === 'cancelled') throw queueError('CANCELLED')
      if (value.decision.expiresAt !== null && timestampKey(value.decision.expiresAt) <= time) throw queueError('EXPIRED')
    }
    const find = (db, id) => stored(db.prepare('SELECT id, snapshot FROM decisions WHERE id=?').get(id))
    function update(id, work) {
      return guarded(() => {
        input(() => identifier(id))
        return storage.transaction(true, db => {
          const value = find(db, id)
          if (!value) throw queueError('NOT_FOUND')
          const result = work(value)
          db.prepare('UPDATE decisions SET snapshot=? WHERE id=?').run(JSON.stringify(value), id)
          return result
        })
      })
    }
    return {
      close: storage.close,
      readNamespace: storage.namespace,
      request(decision) {
        return guarded(() => {
          const snapshot = createDecision(decision)
          return storage.transaction(true, db => {
            const existing = find(db, snapshot.id)
            if (existing) {
              if (!isDeepStrictEqual(existing.decision, snapshot)) throw queueError('CONFLICT')
              return { created: false }
            }
            const value = { decision: snapshot, state: 'pending', answer: null, delivery: null, ack: null, cancellation: null }
            db.prepare('INSERT INTO decisions (id, snapshot) VALUES (?, ?)').run(snapshot.id, JSON.stringify(value))
            return { created: true }
          })
        })
      },
      read(id) {
        return guarded(() => {
          input(() => identifier(id))
          return storage.transaction(false, db => publicSnapshot(find(db, id)))
        })
      },
      list(filters = {}) {
        return guarded(() => {
          const selected = input(() => {
            requireValid(filters !== null && typeof filters === 'object')
            const keys = Reflect.ownKeys(filters)
            requireValid(keys.every(key => ['repo', 'runId', 'state'].includes(key)))
            const value = exactRecord(filters, keys)
            if ('repo' in value) requireValid(validRepo(value.repo))
            if ('runId' in value) requireValid(validId(value.runId))
            if ('state' in value) requireValid(states.includes(value.state))
            return value
          })
          return storage.transaction(false, db => db.prepare('SELECT id, snapshot FROM decisions').all().map(stored)
            .filter(value => Object.entries(selected).every(([key, field]) => (key === 'state' ? value.state : value.decision[key]) === field))
            .sort((a, b) => compare(timestampKey(a.decision.createdAt), timestampKey(b.decision.createdAt)) || compare(a.decision.id, b.decision.id))
            .map(publicSnapshot))
        })
      },
      answer(id, value) {
        const answer = input(() => answerInput(value))
        return update(id, stored => {
          const time = currentTime()
          live(stored, time)
          if (answer.revision !== stored.decision.revision) throw queueError('STALE')
          validAnswer(stored.decision, answer)
          requireValid(timestampKey(answer.at) <= time)
          if (stored.answer !== null) {
            if (!isDeepStrictEqual(stored.answer, answer)) throw queueError('CONFLICT')
            return { created: false }
          }
          stored.answer = answer; stored.state = 'answered'
          return { created: true }
        })
      },
      deliver(id, value) {
        const target = input(() => recipient(value))
        return update(id, stored => {
          matchingRecipient(stored.decision, target)
          live(stored, currentTime())
          if (stored.answer === null) throw queueError('NOT_READY')
          if (stored.delivery !== null) {
            if (!isDeepStrictEqual(stored.delivery, target)) throw queueError('CONFLICT')
          } else { stored.delivery = target; stored.state = 'delivered' }
          return publicSnapshot(stored)
        })
      },
      acknowledge(id, value) {
        const target = input(() => recipient(value))
        return update(id, stored => {
          matchingRecipient(stored.decision, target)
          live(stored, currentTime())
          if (stored.delivery === null) throw queueError('NOT_READY')
          if (!isDeepStrictEqual(stored.delivery, target)) throw queueError('CONFLICT')
          if (stored.codexDispatch?.state === 'inflight') throw queueError('MANUAL_HANDOFF')
          if (stored.ack !== null) return { created: false }
          stored.ack = target; stored.state = 'acknowledged'
          return { created: true }
        })
      },
      // Both operations share the same transaction/locking and durable snapshot
      // as ordinary delivery. No database transaction is held across the RPC.
      reserveCodexDispatch(id, value, targetInput) {
        const delivery = input(() => recipient(value))
        const target = input(() => codexTarget(targetInput))
        return update(id, stored => {
          matchingRecipient(stored.decision, delivery)
          live(stored, currentTime())
          if (stored.decision.kind !== 'question') throw queueError('MANUAL_HANDOFF')
          if (stored.answer === null) throw queueError('NOT_READY')
          if (stored.codexDispatch) {
            if (!isDeepStrictEqual(stored.delivery, delivery) || !isDeepStrictEqual(stored.codexDispatch.target, target) ||
                stored.codexDispatch.state !== 'acknowledged') throw queueError('MANUAL_HANDOFF')
            return null
          }
          // An ordinary ack is not evidence that this native target received it.
          if (stored.ack !== null) throw queueError('MANUAL_HANDOFF')
          if (stored.delivery !== null && !isDeepStrictEqual(stored.delivery, delivery)) throw queueError('CONFLICT')
          const dispatchId = randomUUID()
          stored.delivery = delivery; stored.state = 'delivered'
          stored.codexDispatch = { dispatchId, target, state: 'inflight', receipt: null }
          return { dispatchId, target, snapshot: publicSnapshot(stored) }
        })
      },
      completeCodexDispatch(id, value) {
        const receipt = input(() => {
          const result = exactRecord(value, ['dispatchId', 'recipient', 'turnId'])
          requireValid(validId(result.dispatchId))
          result.recipient = recipient(result.recipient)
          return result
        })
        return update(id, stored => {
          matchingRecipient(stored.decision, receipt.recipient)
          live(stored, currentTime())
          const dispatch = stored.codexDispatch
          if (!dispatch || dispatch.state !== 'inflight' || dispatch.dispatchId !== receipt.dispatchId ||
              !isDeepStrictEqual(stored.delivery, receipt.recipient) || receipt.turnId !== dispatch.target.turnId) {
            throw queueError('MANUAL_HANDOFF')
          }
          dispatch.state = 'acknowledged'; dispatch.receipt = { turnId: receipt.turnId }
          stored.ack = receipt.recipient; stored.state = 'acknowledged'
          return { created: true }
        })
      },
      cancel(id, value) {
        const reason = input(() => cancellation(value))
        return update(id, stored => {
          if (stored.state === 'acknowledged') throw queueError('CONFLICT')
          if (stored.cancellation !== null) {
            if (!isDeepStrictEqual(stored.cancellation, reason)) throw queueError('CONFLICT')
            return { created: false }
          }
          stored.cancellation = reason; stored.state = 'cancelled'
          return { created: true }
        })
      },
      authorize(id, value) {
        return guarded(() => {
          const target = input(() => {
            identifier(id)
            const result = exactRecord(value, ['action', 'resource', 'revision', 'repo', 'runId'])
            requireValid(['merge', 'publish', 'deploy'].includes(result.action) && validText(result.resource, 2048) &&
              validRevision(result.revision) && validRepo(result.repo) && validId(result.runId))
            return result
          })
          return storage.transaction(false, db => {
            const stored = find(db, id)
            if (!stored || stored.state !== 'acknowledged' || stored.decision.kind !== 'approval' || stored.answer.value !== 'approve') return false
            const { decision } = stored
            if (decision.expiresAt !== null && timestampKey(decision.expiresAt) <= currentTime()) return false
            return target.repo === decision.repo && target.runId === decision.runId && target.revision === decision.revision &&
              target.action === decision.scope.action && target.resource === decision.scope.resource
          })
        })
      },
    }
  })
}
