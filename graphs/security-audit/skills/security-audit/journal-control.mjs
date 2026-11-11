// Data/transaction helpers for the existing journal owner. No new lease,
// scheduler, provider or reconciliation authority.
import { BODY_LIMIT, TOTAL_LIMIT, need, fields, canonical, parseCanonical, pending, contentBytes } from './journal-data.mjs'

export const HISTORY_LIMIT = 32768
export const CONTROL_BYTES = 4096 + HISTORY_LIMIT * 1024
export const CONTROL_SCHEMA = [
  'CREATE TABLE control (singleton INTEGER PRIMARY KEY CHECK(singleton=1), body TEXT NOT NULL) STRICT',
  'CREATE TABLE control_history (revision INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT',
]
export const BLOCKERS = ['paused_budget', 'paused_uncertain', 'report_stale']
const REASONS = ['init', 'operator_increase', ...BLOCKERS, 'ack_report', 'resume_budget', 'settled', 'recovered_uncertain']
const KEYS = ['version', 'revision', 'maximum', 'currentGrant', 'blockers', 'acknowledgedGeneration', 'reservedHistorySlots']
const HISTORY_KEYS = ['reason', 'oldGrant', 'newGrant', 'beforeBlockers', 'afterBlockers', 'acknowledgedGeneration']
export const natural = n => Number.isSafeInteger(n) && n >= 0
export const generation = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const validBlockers = v => Array.isArray(v) && v.every((b, i) => BLOCKERS.includes(b) && (!i || v[i - 1] < b))
const equal = (a, b) => canonical(a) === canonical(b)
export const withBlockers = (c, ...reasons) => [...new Set([...c.blockers, ...reasons])].sort()
export const publicControl = c => c === null ? null : Object.fromEntries(KEYS.filter(k => k !== 'reservedHistorySlots').map(k => [k, structuredClone(c[k])]))
export const budgetEvidence = c => c === null ? null : { version: 1, maximum: c.maximum, currentGrant: c.currentGrant }
export const controlBody = c => canonical(c, 4096, 'CORRUPT', 'CORRUPT')

// Called before ANY variable-width journal body is materialized. Charge the
// full fixed control reserve, then verify individual lengths without allocating
// control or history contents. Schema was verified by the owning transaction.
export function inspectControl(db, countBytes) {
  if (db.prepare('PRAGMA user_version').get().user_version === 1) return false
  countBytes(CONTROL_BYTES, CONTROL_BYTES)
  const control = db.prepare('SELECT singleton, length(CAST(body AS BLOB)) AS bytes FROM control LIMIT 2').all()
  need(control.length === 1 && control[0].singleton === 1 && natural(control[0].bytes) && control[0].bytes > 0 && control[0].bytes <= 4096)
  const history = db.prepare(`SELECT CAST(revision AS TEXT) AS position, length(CAST(body AS BLOB)) AS bytes
    FROM control_history ORDER BY revision LIMIT ${HISTORY_LIMIT + 1}`).all()
  need(history.length > 0 && history.length <= HISTORY_LIMIT)
  for (let i = 0; i < history.length; i++) need(Number(history[i].position) === i + 1 &&
    natural(history[i].bytes) && history[i].bytes > 0 && history[i].bytes <= 1024)
  return true
}

export function controlledBytes(identity, limit, rows, controlled) {
  return contentBytes(identity, limit, rows) + (controlled ? CONTROL_BYTES + rows.filter(r => pending(r.state)).length * BODY_LIMIT : 0)
}
export function requireHistoryCapacity(c, reserved = false) {
  need(natural(c.revision) && natural(c.reservedHistorySlots))
  need(reserved ? c.reservedHistorySlots > 0 && c.revision < HISTORY_LIMIT :
    c.revision + c.reservedHistorySlots < HISTORY_LIMIT, 'CONTROL_CAPACITY')
}
export function checkRevision(c, revision) {
  need(c !== null, 'CONTROL_INIT_REFUSED')
  need(c.revision === revision, 'CONFLICT')
}
export function controlInput(options, keys) {
  const input = fields(options, keys, 'INVALID_CONTROL_INPUT')
  if (keys.includes('expectedRevision')) need(natural(input.expectedRevision) && input.expectedRevision > 0, 'INVALID_CONTROL_INPUT')
  return input
}
export function quiescent(rows) {
  need(!rows.some(r => ['dispatched', 'uncertain'].includes(r.state)), 'CONTROL_BUSY')
}

export function readControl(db, maximum, rows) {
  const c = fields(parseCanonical(db.prepare('SELECT body FROM control WHERE singleton=1').get().body, 4096), KEYS, 'CORRUPT')
  need(c.version === 1 && natural(c.revision) && c.revision > 0 && c.revision <= HISTORY_LIMIT && c.maximum === maximum &&
    natural(c.currentGrant) && c.currentGrant <= maximum && rows.length <= c.currentGrant && validBlockers(c.blockers) &&
    (c.acknowledgedGeneration === null || generation(c.acknowledgedGeneration)) && natural(c.reservedHistorySlots))
  need(c.reservedHistorySlots === rows.filter(r => ['prepared', 'dispatched'].includes(r.state)).length &&
    c.revision + c.reservedHistorySlots <= HISTORY_LIMIT)
  if (rows.some(r => r.state === 'uncertain')) need(c.blockers.includes('paused_uncertain'))
  const history = db.prepare(`SELECT revision, body FROM control_history ORDER BY revision LIMIT ${HISTORY_LIMIT}`).all()
  need(history.length === c.revision)
  let previous = null
  for (const [i, row] of history.entries()) {
    const h = fields(parseCanonical(row.body, 1024), HISTORY_KEYS, 'CORRUPT')
    need(row.revision === i + 1 && REASONS.includes(h.reason) && natural(h.newGrant) && h.newGrant <= maximum &&
      validBlockers(h.beforeBlockers) && validBlockers(h.afterBlockers) &&
      (h.acknowledgedGeneration === null || generation(h.acknowledgedGeneration)))
    if (!previous) need(h.reason === 'init' && h.oldGrant === null && h.beforeBlockers.length === 0 &&
      equal(h.afterBlockers, ['report_stale']) && h.acknowledgedGeneration === null)
    else {
      need(h.reason !== 'init' && h.oldGrant === previous.newGrant && equal(h.beforeBlockers, previous.afterBlockers))
      need(h.reason === 'operator_increase' ? h.newGrant > h.oldGrant : h.newGrant === h.oldGrant)
      let expected = h.beforeBlockers
      if (BLOCKERS.includes(h.reason)) expected = withBlockers({ blockers: expected }, h.reason)
      if (h.reason === 'operator_increase') {
        need(h.beforeBlockers.includes('paused_budget'))
        expected = withBlockers({ blockers: expected }, 'report_stale')
      }
      if (h.reason === 'ack_report') {
        need(generation(h.acknowledgedGeneration))
        expected = expected.filter(b => b !== 'report_stale')
      } else need(h.acknowledgedGeneration === previous.acknowledgedGeneration)
      if (h.reason === 'resume_budget') expected = expected.filter(b => b !== 'paused_budget')
      if (h.reason === 'recovered_uncertain') expected = withBlockers({ blockers: expected }, 'report_stale', 'paused_uncertain')
      if (h.reason === 'settled') {
        const base = withBlockers({ blockers: expected }, 'report_stale')
        need(equal(h.afterBlockers, base) || equal(h.afterBlockers, withBlockers({ blockers: base }, 'paused_uncertain')))
      } else need(equal(h.afterBlockers, expected))
    }
    previous = h
  }
  need(previous.newGrant === c.currentGrant && equal(previous.afterBlockers, c.blockers) && previous.acknowledgedGeneration === c.acknowledgedGeneration)
  return c
}

// The caller owns BEGIN/COMMIT. Settlement uses its reservation even when
// ordinary mutations have exhausted every unreserved history slot.
export function transitionControl(db, c, patch, reason, reserved = false) {
  requireHistoryCapacity(c, reserved)
  const next = { ...c, ...patch, revision: c.revision + 1,
    reservedHistorySlots: c.reservedHistorySlots - (reserved ? 1 : 0) }
  const history = { reason, oldGrant: c.currentGrant, newGrant: next.currentGrant,
    beforeBlockers: c.blockers, afterBlockers: next.blockers, acknowledgedGeneration: next.acknowledgedGeneration }
  db.prepare('INSERT INTO control_history VALUES (?,?)').run(next.revision, canonical(history, 1024, 'CORRUPT', 'CORRUPT'))
  db.prepare('UPDATE control SET body=? WHERE singleton=1').run(controlBody(next))
  return next
}
export function reserveHistory(db, c, delta) {
  if (delta > 0) requireHistoryCapacity(c)
  need(natural(c.reservedHistorySlots + delta))
  db.prepare('UPDATE control SET body=? WHERE singleton=1').run(controlBody({ ...c, reservedHistorySlots: c.reservedHistorySlots + delta }))
}
export function initializeControl(db, s, initialGrant) {
  need(s.control === null, 'CONFLICT')
  need(s.rows.length === 0, 'CONTROL_INIT_REFUSED')
  need(natural(initialGrant) && initialGrant <= s.public.invocationLimit, 'INVALID_CONTROL_INPUT')
  need(controlledBytes(JSON.parse(s.identity), s.public.invocationLimit, s.rows, true) <= TOTAL_LIMIT, 'INPUT_TOO_LARGE')
  const c = { version: 1, revision: 1, maximum: s.public.invocationLimit, currentGrant: initialGrant,
    blockers: ['report_stale'], acknowledgedGeneration: null, reservedHistorySlots: 0 }
  db.exec(CONTROL_SCHEMA.join(';'))
  db.prepare('INSERT INTO control VALUES (1,?)').run(controlBody(c))
  db.prepare('INSERT INTO control_history VALUES (1,?)').run(canonical({ reason: 'init', oldGrant: null, newGrant: initialGrant,
    beforeBlockers: [], afterBlockers: c.blockers, acknowledgedGeneration: null }, 1024, 'CORRUPT', 'CORRUPT'))
  db.exec('PRAGMA user_version=2')
  return c
}
