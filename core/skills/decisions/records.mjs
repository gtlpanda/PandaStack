import { isAbsolute, normalize } from 'node:path'

const invalid = () => Object.assign(new Error('Invalid decision record'), { code: 'INVALID_DECISION' })
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)
const text = (value, max) => typeof value === 'string' && value.length <= max && value.trim().length > 0
const path = value => typeof value === 'string' && !value.includes('\0') && isAbsolute(value)
const fields = ['schemaVersion', 'id', 'runId', 'repo', 'revision', 'question', 'reason',
  'options', 'recommendation', 'evidence', 'kind', 'scope', 'createdAt', 'expiresAt']

function requireValid(condition) {
  if (!condition) throw invalid()
}

// Read only own enumerable data properties: no getters, toJSON or caller hooks.
function property(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  requireValid(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'))
  return descriptor.value
}

function record(value, keys) {
  requireValid(value !== null && typeof value === 'object')
  const prototype = Object.getPrototypeOf(value)
  requireValid(prototype === Object.prototype || prototype === null)
  const ownKeys = Reflect.ownKeys(value)
  requireValid(ownKeys.length === keys.length && ownKeys.every(key => keys.includes(key)))
  return Object.fromEntries(keys.map(key => [key, property(value, key)]))
}

function items(value, min, max, copy) {
  requireValid(Array.isArray(value))
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
  requireValid(Number.isInteger(length) && length >= min && length <= max)
  // Holes, symbols and extra array properties are not part of a JSON snapshot.
  requireValid(Reflect.ownKeys(value).length === length + 1)
  return Array.from({ length }, (_, index) => copy(property(value, String(index))))
}

function timestamp(value) {
  requireValid(typeof value === 'string')
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value)
  requireValid(match && match[0] === value)
  const time = Date.parse(value)
  requireValid(Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === match[1])
  // Normalize fractions for exact ordering, including precision beyond milliseconds.
  return match[1] + '.' + (match[2] || '').replace(/0+$/, '')
}

function evidenceUri(value) {
  if (!text(value, 2048)) return false
  if (path(value)) return true
  if (!/^https:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return false
  try {
    const uri = new URL(value)
    return uri.protocol === 'https:' && uri.hostname.length > 0
  } catch { return false }
}

function snapshot(input) {
  const result = record(input, fields)
  requireValid(result.schemaVersion === 1 && id(result.id) && id(result.runId))
  // Canonicalization of filesystem aliases belongs to the caller. Historical
  // snapshots remain valid without the repository being mounted or existing.
  requireValid(path(result.repo) && normalize(result.repo) === result.repo &&
    (result.repo === '/' || !result.repo.endsWith('/')))
  requireValid(typeof result.revision === 'string' && /^[a-f0-9]{40}$/.test(result.revision) && result.revision.length === 40)
  requireValid(text(result.question, 4096) && text(result.reason, 4096))
  result.options = items(result.options, 2, 20, value => {
    const option = record(value, ['id', 'label'])
    requireValid(id(option.id) && text(option.label, 256))
    return option
  })
  const optionIds = new Set(result.options.map(option => option.id))
  requireValid(optionIds.size === result.options.length)
  requireValid(result.recommendation === null || optionIds.has(result.recommendation))
  result.evidence = items(result.evidence, 0, 20, value => {
    const evidence = record(value, ['label', 'uri'])
    requireValid(text(evidence.label, 256) && evidenceUri(evidence.uri))
    return evidence
  })
  requireValid(result.kind === 'question' || result.kind === 'approval')
  if (result.kind === 'question') requireValid(result.scope === null)
  else {
    result.scope = record(result.scope, ['action', 'resource', 'revision'])
    requireValid(['merge', 'publish', 'deploy'].includes(result.scope.action) &&
      text(result.scope.resource, 2048) && result.scope.revision === result.revision)
    requireValid(optionIds.size === 2 && optionIds.has('approve') && optionIds.has('reject'))
  }
  const created = timestamp(result.createdAt)
  requireValid(result.expiresAt === null || timestamp(result.expiresAt) > created)
  return result
}

export function validateDecision(value) {
  try { snapshot(value); return [] }
  catch { return ['Invalid decision record'] }
}

export function createDecision(input) {
  try { return snapshot(input) }
  catch { throw invalid() }
}
