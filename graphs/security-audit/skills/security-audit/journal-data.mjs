// Inert canonical data and logical capacity accounting. No model-selected paths.
import { types } from 'node:util'

export const BODY_LIMIT = 1024 * 1024
export const TOTAL_LIMIT = 1024 * 1024 * 1024
export const ROW_LIMIT = 10000
export const fail = code => { throw Object.assign(new Error(`Audit journal: ${code}`), { code }) }
const errors = new Set(['INVALID_JOURNAL_INPUT', 'INPUT_TOO_LARGE', 'CONFLICT', 'BUDGET_EXHAUSTED',
  'INVALID_CONTROL_INPUT', 'CONTROL_INIT_REFUSED', 'CONTROL_BUSY', 'CONTROL_PAUSED', 'CONTROL_CAPACITY', 'REPORT_NOT_CURRENT',
  'OWNER_BUSY', 'BUSY', 'CLOSED', 'DISPATCH_UNCERTAIN', 'TERMINAL_RUN', 'NOT_FOUND', 'CORRUPT', 'IO_ERROR'])
export function guarded(fn) {
  try { return fn() } catch (e) {
    fail(errors.has(e?.code) ? e.code : [11, 26].includes(e?.errcode & 255) ? 'CORRUPT' : 'IO_ERROR')
  }
}
export const need = (ok, code = 'CORRUPT') => { if (!ok) fail(code) }
export const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)
export const record = v => v !== null && typeof v === 'object' && !types.isProxy(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v))

export function fields(value, keys, code = 'INVALID_JOURNAL_INPUT') {
  need(record(value), code)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const names = Reflect.ownKeys(descriptors)
  need(names.length === keys.length && names.every(k => keys.includes(k)), code)
  for (const k of names) need('value' in descriptors[k] && descriptors[k].enumerable, code)
  return Object.fromEntries(names.map(k => [k, descriptors[k].value]))
}

// Iterative serialization avoids user hooks and call-stack limits. Count UTF8 as
// tokens are appended, reject cycles, sparse arrays, accessors and exotic objects.
export function canonical(value, limit = BODY_LIMIT, invalid = 'INVALID_JOURNAL_INPUT', large = 'INPUT_TOO_LARGE') {
  const parts = [], active = new Set(), stack = [{ value }]
  let bytes = 0
  const append = text => { bytes += Buffer.byteLength(text); need(bytes <= limit, large); parts.push(text) }
  while (stack.length) {
    const item = stack.pop()
    if ('text' in item) { append(item.text); continue }
    if ('end' in item) { active.delete(item.end); continue }
    const v = item.value
    if (v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) {
      if (typeof v === 'string') need(v.length <= limit, large)
      append(JSON.stringify(v)); continue
    }
    need(v !== null && typeof v === 'object' && !types.isProxy(v) && !active.has(v), invalid)
    const array = Array.isArray(v)
    need(array ? Object.getPrototypeOf(v) === Array.prototype : record(v), invalid)
    const descriptors = Object.getOwnPropertyDescriptors(v)
    const names = Reflect.ownKeys(descriptors)
    for (const k of names) need(typeof k === 'string' && 'value' in descriptors[k] &&
      (descriptors[k].enumerable || (array && k === 'length')), invalid)
    let keys
    if (array) {
      const length = descriptors.length.value
      need(length <= limit, large)
      need(names.length === length + 1, invalid)
      keys = Array.from({ length }, (_, i) => String(i))
      need(keys.every(k => Object.hasOwn(descriptors, k)), invalid)
    } else keys = names.sort()
    active.add(v)
    stack.push({ end: v }, { text: array ? ']' : '}' })
    for (let i = keys.length - 1; i >= 0; i--) {
      const k = keys[i]
      stack.push({ value: descriptors[k].value })
      if (!array) stack.push({ text: ':' }, { text: JSON.stringify(k) })
      if (i) stack.push({ text: ',' })
    }
    append(array ? '[' : '{')
  }
  return parts.join('')
}

export function parseCanonical(text, limit = BODY_LIMIT) {
  need(typeof text === 'string' && Buffer.byteLength(text) <= limit)
  let value
  try { value = JSON.parse(text) } catch { fail('CORRUPT') }
  need(canonical(value, limit, 'CORRUPT', 'CORRUPT') === text)
  return value
}
export const pending = state => ['prepared', 'dispatched', 'uncertain'].includes(state)
export function terminalEnvelope(value) {
  const envelope = fields(value, ['outcome', 'result'])
  need(['returned', 'failed'].includes(envelope.outcome), 'INVALID_JOURNAL_INPUT')
  if (envelope.outcome === 'failed') {
    const { code } = fields(envelope.result, ['code'])
    need(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code), 'INVALID_JOURNAL_INPUT')
  }
  return { state: envelope.outcome, result: canonical(envelope.result) }
}

// Include the full bound identity and public header/row syntax. Reserve counter
// digits and 64 bytes per pending row, exceeding every control-state expansion.
// SQLite physical pages are deliberately not part of this logical limit.
export function contentBytes(identity, invocationLimit, rows) {
  const header = { version: 1, identity, invocationLimit,
    settledCalls: Number.MAX_SAFE_INTEGER, heldCalls: Number.MAX_SAFE_INTEGER,
    available: Number.MAX_SAFE_INTEGER, rows: [] }
  let bytes = Buffer.byteLength(canonical(header, TOTAL_LIMIT, 'CORRUPT', 'CORRUPT'))
  for (const row of rows) {
    const state = pending(row.state) ? 'dispatched' : row.state
    bytes += Buffer.byteLength(JSON.stringify({ id: row.id, input: null, state, result: null })) +
      Buffer.byteLength(row.input) - 4 + Buffer.byteLength(row.result ?? 'null') - 4 + 1 + (pending(row.state) ? 64 : 0)
    need(Number.isSafeInteger(bytes))
  }
  return bytes
}
