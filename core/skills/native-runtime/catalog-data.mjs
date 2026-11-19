// Offline inventory validation. Only detached, finite JSON reaches predicates.
import { json, exact, fail, record } from './boundary.mjs'
import { PROFILES } from './runtime.mjs'

export const INPUT = 'INVALID_CATALOG_INPUT'
export const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.exec(value)?.[0] === value
export const safeText = value => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(value)
export const relativePath = value => safeText(value) && Buffer.byteLength(value) <= 4096 &&
  !value.includes('\\') && !value.includes(':') && value.split('/').every(p => p && p !== '.' && p !== '..')
const digest = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value)
const boolean = value => typeof value === 'boolean'
const oneOf = (...values) => value => values.includes(value)
const list = (check, max, unique = true) => value => Array.isArray(value) && value.length <= max &&
  value.every(check) && (!unique || new Set(value).size === value.length)
const paths = list(relativePath, 512)
const ids = list(identifier, 32)
const shape = (value, fields) => {
  exact(value, Object.keys(fields), INPUT)
  for (const [key, check] of Object.entries(fields)) if (!check(value[key])) fail(INPUT)
}
// A field predicate for a nested exact object; it throws instead of returning false.
const nested = fields => value => { shape(value, fields); return true }
const sharedOfferingFields = {
  id: identifier,
  kind: oneOf('shared-reference-contract', 'shared-library-no-entry-skill', 'guided-offering', 'executable-graph-or-cli'),
  source: relativePath, entrySkill: boolean, installTargets: paths, nativeReadiness: oneOf('unknown'),
  dependencies: ids, evidenceOwners: paths, requiredRuntimes: ids, aliases: ids,
  requirementsComplete: boolean, entrySha256: value => value === null || digest(value),
}
const v1OfferingFields = { ...sharedOfferingFields, codexInstallEligible: boolean,
  nativeImplementation: oneOf('present-limited', 'not-certified') }
// v2 derives codexInstallEligible and nativeImplementation from providers (accessors below).
const LIMITATIONS = ['NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE', 'LIBRARY_ONLY', 'GUIDANCE_ONLY', 'NO_NATIVE_ENTRY',
  'NO_PROVIDER_TRANSPORT', 'PROFILE_UNSUPPORTED', 'UNSUPPORTED_CONTROL', 'LIVE_PROOF_MISSING', 'EXTERNAL_SERVICE']
const providerFields = { implementation: oneOf('supported', 'partial', 'unavailable'),
  transportId: value => value === null || identifier(value), limitations: list(oneOf(...LIMITATIONS), 32) }
const BACKENDS = ['claude', 'codex']
const v2OfferingFields = { ...sharedOfferingFields,
  providers: nested(Object.fromEntries(BACKENDS.map(backend => [backend, nested(providerFields)]))),
  permissionProfile: value => value === null || PROFILES.has(value), proofRefs: list(identifier, 64) }
const targetFields = { target: relativePath, source: relativePath }
const assetKind = oneOf('agents', 'commands', 'bin', 'workflows')
const workflowFields = { source: relativePath, roles: list(identifier, 512, false), nativeReadiness: oneOf('unknown') }
const v1Collections = {
  offerings: [256, 'id', v1OfferingFields],
  workflows: [32, 'source', workflowFields],
  assets: [512, 'target', { ...targetFields, kind: assetKind }],
  fixedTargets: [512, 'target', { ...targetFields, classification: safeText }],
  installerTargets: [1024, 'target', { ...targetFields, codexInstaller: boolean,
    kind: oneOf('skills', 'agents', 'commands', 'bin', 'workflows') }],
  aliases: [256, 'id', { id: identifier, source: relativePath,
    targetOffering: value => value === null || identifier(value), kind: oneOf('separate-fixed-instruction-not-certified-alias') }],
}
const v2Collections = { ...v1Collections,
  offerings: [256, 'id', v2OfferingFields],
  workflows: [32, 'source', { ...workflowFields, sha256: digest }],
  transports: [32, 'id', { id: identifier, provider: oneOf(...BACKENDS), entry: relativePath }],
}
// Keyed by number, so a string or inherited schemaVersion never selects a schema.
const SCHEMAS = new Map([[1, v1Collections], [2, v2Collections]])

// Row-local v2 rules; the transports cross-check needs the whole catalog and stays in catalogData.
function v2ProvidersConsistent(row) {
  return BACKENDS.every(backend => {
    const entry = row.providers[backend]
    return (entry.implementation === 'unavailable') === (entry.transportId === null) &&
      (row.entrySkill || entry.limitations.includes('LIBRARY_ONLY'))
  })
}

export function catalogData(input, code = INPUT) {
  try {
    const value = json(input, code)
    const collections = SCHEMAS.get(value?.schemaVersion)
    if (!collections) fail(code)
    exact(value, ['schemaVersion', 'status', 'inventorySha256', ...Object.keys(collections), 'limits'], code)
    if (value.status !== 'PROPOSED_CATALOG_NOT_RUNTIME_CERTIFICATION' ||
      !digest(value.inventorySha256) || !list(safeText, 512)(value.limits)) fail(code)
    for (const [name, [max, key, fields]] of Object.entries(collections)) {
      const rows = value[name]
      if (!Array.isArray(rows) || rows.length > max || (name === 'offerings' && !rows.length)) fail(code)
      const seen = new Set()
      for (const row of rows) {
        shape(row, fields)
        if (seen.has(row[key])) fail(code)
        seen.add(row[key])
      }
    }
    const sources = new Set(), targets = new Map(), offeringTargets = new Set()
    const bind = (target, source) => {
      if (targets.has(target) && targets.get(target) !== source) fail(code)
      targets.set(target, source)
    }
    const offeringIds = new Set(value.offerings.map(row => row.id))
    const edges = new Map()
    for (const row of value.offerings) {
      if (sources.has(row.source) || (row.entrySkill ? !digest(row.entrySha256) : row.entrySha256 !== null) ||
        (row.kind === 'shared-library-no-entry-skill') !== !row.entrySkill) fail(code)
      sources.add(row.source)
      edges.set(row.id, [...row.dependencies, ...row.aliases])
      for (const target of row.installTargets) {
        if (offeringTargets.has(target) || !target.startsWith('skills/') || target.split('/').length !== 2) fail(code)
        offeringTargets.add(target); bind(target, row.source)
      }
      if (row.dependencies.some(id => !offeringIds.has(id))) fail(code)
    }
    if (value.schemaVersion === 2) {
      const transports = new Map(value.transports.map(row => [row.id, row.provider]))
      for (const row of value.offerings) {
        if (!v2ProvidersConsistent(row) || BACKENDS.some(backend => {
          const id = row.providers[backend].transportId
          return id !== null && transports.get(id) !== backend
        })) fail(code)
      }
    }
    for (const row of value.aliases) {
      if (edges.has(row.id) || (row.targetOffering !== null && !offeringIds.has(row.targetOffering))) fail(code)
      edges.set(row.id, row.targetOffering === null ? [] : [row.targetOffering])
    }
    for (const name of ['assets', 'fixedTargets', 'installerTargets']) {
      for (const row of value[name]) bind(row.target, row.source)
    }
    const active = new Set(), visited = new Set()
    const visit = id => {
      if (!edges.has(id) || active.has(id)) fail(code)
      if (visited.has(id)) return
      active.add(id)
      for (const next of edges.get(id)) visit(next)
      active.delete(id); visited.add(id)
    }
    for (const id of edges.keys()) visit(id)
    return value
  } catch { fail(code) }
}

export function validateCatalog(value) {
  try { catalogData(value); return [] } catch { return ['Invalid offering catalog.'] }
}

export const visibilityValues = ['absent', 'linked', 'copy', 'drifted', 'broken', 'wrong-target', 'unreadable', 'library-only']
export const sourceValues = ['present', 'missing', 'drifted', 'unreadable']
const sourceBlockers = { missing: 'SOURCE_MISSING', drifted: 'SOURCE_DRIFTED', unreadable: 'SOURCE_UNREADABLE' }
const visibilityBlockers = { absent: 'SKILL_ABSENT', drifted: 'SKILL_DRIFTED', broken: 'BROKEN_LINK',
  'wrong-target': 'WRONG_TARGET', unreadable: 'UNREADABLE_ENTRY', 'library-only': 'LIBRARY_ONLY' }
export function backendInput(value) {
  if (!BACKENDS.includes(value)) fail(INPUT)
  return value
}
// Version-independent reads of one offering row. Each accessor first detaches and
// shape-checks the row (v2 when it has providers), so a stray or hostile row fails
// closed with INPUT instead of reading a missing field.
const isV2Row = row => Object.hasOwn(row, 'providers')
function offeringRow(offering) {
  try {
    const row = json(offering, INPUT)
    const v2 = record(row) && isV2Row(row)
    shape(row, v2 ? v2OfferingFields : v1OfferingFields)
    if (v2 && !v2ProvidersConsistent(row)) fail(INPUT)
    return row
  } catch { fail(INPUT) }
}
function implementationOf(row, backend) {
  if (isV2Row(row)) return row.providers[backend].implementation
  if (backend === 'codex') return row.nativeImplementation === 'present-limited' ? 'partial' : 'unavailable'
  return row.installTargets.length > 0 ? 'supported' : 'unavailable'
}
export function providerImplementation(offering, backend) {
  const row = offeringRow(offering)
  return implementationOf(row, backendInput(backend))
}
export function installEligible(offering, backend) {
  const row = offeringRow(offering)
  if (backendInput(backend) === 'claude') return row.installTargets.length > 0
  if (!isV2Row(row)) return row.codexInstallEligible
  return implementationOf(row, 'codex') !== 'unavailable' && row.installTargets.length > 0
}
export function nativeImplementationOf(offering) {
  const row = offeringRow(offering)
  if (!isV2Row(row)) return row.nativeImplementation
  return ['partial', 'supported'].includes(implementationOf(row, 'codex')) ? 'present-limited' : 'not-certified'
}
export function blockers(offering, sourceStatus, visibility) {
  return ['NATIVE_UNVERIFIED', ...(!offering.requirementsComplete ? ['REQUIREMENTS_INCOMPLETE'] : []),
    sourceBlockers[sourceStatus], visibilityBlockers[visibility]].filter(Boolean).sort()
}
export const safeFilename = value => relativePath(value) && !value.includes('/')
export function discoveryData(input, catalog, backend) {
  const value = json(input, INPUT)
  exact(value, ['schemaVersion', 'backend', 'offerings', 'unknownEntries'], INPUT)
  if (value.schemaVersion !== 1 || value.backend !== backend || !Array.isArray(value.offerings) ||
    value.offerings.length !== catalog.offerings.length || !list(safeFilename, 65536)(value.unknownEntries) ||
    value.unknownEntries.some((name, i) => i && value.unknownEntries[i - 1] >= name)) fail(INPUT)
  value.offerings.forEach((row, index) => {
    const offering = catalog.offerings[index]
    exact(row, ['id', 'visibility', 'sourceStatus', 'installEligible', 'nativeImplementation', 'nativeReadiness', 'blockers'], INPUT)
    if (row.id !== offering.id || !visibilityValues.includes(row.visibility) || !sourceValues.includes(row.sourceStatus) ||
      row.installEligible !== installEligible(offering, backend) || row.nativeImplementation !== nativeImplementationOf(offering) ||
      row.nativeReadiness !== 'unknown' || (!offering.entrySkill) !== (row.visibility === 'library-only') ||
      JSON.stringify(row.blockers) !== JSON.stringify(blockers(offering, row.sourceStatus, row.visibility))) fail(INPUT)
  })
  return value
}
