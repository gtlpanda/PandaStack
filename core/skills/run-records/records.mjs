import { isAbsolute } from 'node:path'

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)
const revision = value => value === null || (typeof value === 'string' && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value))
const path = value => typeof value === 'string' && !value.includes('\0') && isAbsolute(value)
const nullable = check => value => value === null || check(value)
// Same model grammar as scripts/agent-config.mjs; that frozen module does not export it.
const model = nullable(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value))
const effort = nullable(value => ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none'].includes(value))
const settingsFields = {
  model, subagentModel: model, advisorModel: model, probeModel: model,
  effort, subagentEffort: effort, advisorEffort: effort, probeEffort: effort,
  maxConcurrentSubagents: value => Number.isSafeInteger(value) && value > 0,
  subagentModelForce: value => typeof value === 'boolean',
}
const sourceValues = ['central', 'project', 'env', 'cli', 'default', 'runtime', 'unknown']
const object = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const own = (value, key) => Object.hasOwn(value, key)
const invalid = () => Object.assign(new Error('Invalid run record or settings'), { code: 'INVALID_RECORD' })

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false
  const time = Date.parse(value)
  // Date.parse normalizes invalid calendar days; reject those as well.
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)
}

function shape(value, fields, required = true) {
  if (!object(value)) return ['Expected a record object']
  const problems = []
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !own(fields, key))) problems.push('Unknown fields')
  for (const [key, check] of Object.entries(fields)) {
    if (!own(value, key)) {
      if (required) problems.push(`Missing ${key}`)
    } else if (!check(value[key])) problems.push(`Invalid ${key}`)
  }
  return problems
}

const sourcesValid = value => shape(value, Object.fromEntries(
  Object.keys(settingsFields).map(key => [key, source => sourceValues.includes(source)]),
), false).length === 0
const settingsValid = value => shape(value, { ...settingsFields, sources: sourcesValid }, false).length === 0

export function sanitizeSettings(input) {
  try {
    if (!object(input)) throw invalid()
    const result = {}
    for (const [key, check] of Object.entries(settingsFields)) {
      if (!own(input, key)) continue
      const value = input[key]
      if (!check(value)) throw invalid()
      result[key] = value
    }
    if (own(input, 'sources')) {
      const sources = input.sources
      if (!object(sources)) throw invalid()
      result.sources = {}
      for (const key of Object.keys(settingsFields)) {
        if (!own(sources, key)) continue
        const value = sources[key]
        if (!sourceValues.includes(value)) throw invalid()
        result.sources[key] = value
      }
    }
    return result
  } catch { throw invalid() }
}

const runFields = {
  schemaVersion: value => value === 1,
  id, repo: path, revision, runnerRoot: path, runnerRevision: revision,
  workflow: value => ['autobuild', 'build-app', 'session'].includes(value),
  backend: value => ['claude', 'codex'].includes(value),
  parentRunId: nullable(id), startedAt: timestamp, settings: settingsValid,
}
const eventFields = {
  schemaVersion: value => value === 1,
  id, runId: id,
  type: value => ['started', 'finished', 'failed', 'cancelled'].includes(value),
  at: timestamp,
  exitCode: nullable(value => Number.isInteger(value) && value >= 0 && value <= 255),
}

export function validateRun(run) {
  try {
    const problems = shape(run, runFields)
    if (object(run) && own(run, 'id') && run.parentRunId === run.id) problems.push('Run cannot parent itself')
    return problems
  } catch { return ['Unreadable run record'] }
}

export function validateEvent(event) {
  try {
    const problems = shape(event, eventFields)
    if (!object(event)) return problems
    const { type, exitCode } = event
    if ((type === 'started' && exitCode !== null) ||
        (type === 'finished' && exitCode !== 0) ||
        (type === 'failed' && (exitCode === null || exitCode === 0)) ||
        (type === 'cancelled' && exitCode === 0)) problems.push('Exit code does not match event type')
    return problems
  } catch { return ['Unreadable event record'] }
}

export function createRun(input) {
  try {
    if (!object(input)) throw invalid()
    // Reject hidden or symbol extras before copying enumerable fields.
    if (Reflect.ownKeys(input).some(key => !own(runFields, key))) throw invalid()
    const run = { ...input }
    if (!own(input, 'schemaVersion')) run.schemaVersion = 1
    if (!own(input, 'parentRunId')) run.parentRunId = null
    run.settings = sanitizeSettings(input.settings)
    if (validateRun(run).length) throw invalid()
    return run
  } catch { throw invalid() }
}
