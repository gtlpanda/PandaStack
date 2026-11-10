import { types } from 'node:util'

const recordKeys = ['schemaVersion', 'scopeId', 'bootId', 'ownerPid', 'ownerStart', 'anchorPid', 'anchorStart', 'pgid']
const factKeys = ['bootId', 'owner', 'anchor', 'current', 'lineage']
const procKeys = ['pid', 'parentPid', 'start', 'pgid', 'state']
const states = new Set(['R', 'S', 'D', 'T', 't', 'I', 'W', 'P'])
const invalid = () => Object.assign(new Error('Invalid capture scope'), { code: 'INVALID_SCOPE' })
const requireValid = condition => { if (!condition) throw invalid() }
const matches = (value, expression) => typeof value === 'string' && expression.exec(value)?.[0] === value
const uuid = value => matches(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const start = value => matches(value, /^[1-9][0-9]{0,19}$/)
const pid = (value, minimum = 1) => Number.isInteger(value) && value >= minimum && value <= 2147483647

// Reject proxies before reflection, which could otherwise execute their traps.
// Copy only own enumerable data descriptors, never caller accessors or hooks.
function property(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  requireValid(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'))
  return descriptor.value
}

function snapshot(value, keys) {
  requireValid(value !== null && typeof value === 'object' && !types.isProxy(value))
  const prototype = Object.getPrototypeOf(value)
  requireValid(prototype === Object.prototype || prototype === null)
  const ownKeys = Reflect.ownKeys(value)
  requireValid(ownKeys.length === keys.length && ownKeys.every(key => keys.includes(key)))
  return Object.fromEntries(keys.map(key => [key, property(value, key)]))
}

function scope(value) {
  const result = snapshot(value, recordKeys)
  requireValid(result.schemaVersion === 1 && uuid(result.scopeId) && uuid(result.bootId) &&
    pid(result.ownerPid) && pid(result.anchorPid) && pid(result.pgid) && start(result.ownerStart) && start(result.anchorStart))
  return result
}

function proc(value) {
  const result = snapshot(value, procKeys)
  requireValid(pid(result.pid) && pid(result.parentPid, 0) && pid(result.pgid) && start(result.start) && states.has(result.state))
  return result
}

function lineage(value) {
  requireValid(value !== null && typeof value === 'object' && !types.isProxy(value) &&
    Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype)
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
  requireValid(Number.isInteger(length) && length >= 1 && length <= 256 && Reflect.ownKeys(value).length === length + 1)
  return Array.from({ length }, (_, index) => proc(property(value, String(index))))
}

/** Parse the fixed private-path protocol record, retaining birth tokens verbatim. */
export function parseScopeRecord(text) {
  requireValid(typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= 256)
  // Every accepted field is ASCII; terminal LF is the only permitted whitespace
  // beyond the exact seven delimiters. Full-field matching rejects embedded LF.
  const fields = text.split('\t')
  requireValid(fields.length === 8 && text.endsWith('\n'))
  fields[7] = fields[7].slice(0, -1)
  requireValid(fields[0] === '1' && uuid(fields[1]) && uuid(fields[2]) && start(fields[4]) && start(fields[6]))
  for (const index of [3, 5, 7]) requireValid(matches(fields[index], /^[1-9][0-9]{0,9}$/) && pid(Number(fields[index])))
  return { schemaVersion: 1, scopeId: fields[1], bootId: fields[2], ownerPid: Number(fields[3]),
    ownerStart: fields[4], anchorPid: Number(fields[5]), anchorStart: fields[6], pgid: Number(fields[7]) }
}

/** Consistency of supplied observations only; this does not authenticate them. */
export function validateScopeJoin(record, facts) {
  try {
    const r = scope(record), f = snapshot(facts, factKeys)
    requireValid(uuid(f.bootId) && f.bootId === r.bootId)
    const owner = proc(f.owner), anchor = proc(f.anchor), current = proc(f.current), rows = lineage(f.lineage)
    requireValid(owner.pid === r.ownerPid && owner.start === r.ownerStart &&
      anchor.pid === r.anchorPid && anchor.start === r.anchorStart &&
      anchor.pgid === anchor.pid && anchor.pid === r.pgid && anchor.parentPid === owner.pid &&
      owner.pid !== anchor.pid && owner.pgid !== r.pgid && current.pgid === r.pgid)
    const equal = (a, b) => procKeys.every(key => a[key] === b[key])
    requireValid(equal(rows[0], current) && equal(rows.at(-1), anchor))
    const seen = new Set()
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]
      requireValid(!seen.has(row.pid) && row.pgid === r.pgid &&
        (index === rows.length - 1 || row.parentPid === rows[index + 1].pid))
      seen.add(row.pid)
    }
    return true
  } catch { return false }
}
