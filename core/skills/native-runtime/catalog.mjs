// Static inventory only: no installer changes, runtime probes or provider ports.
import { lstatSync, statSync, realpathSync, readdirSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { join, isAbsolute, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { fields, exact, json, record, fail } from './boundary.mjs'
import { sanitizeSettings } from '../run-records/records.mjs'
import { INPUT, catalogData, discoveryData, safeText, safeFilename, eligible, blockers } from './catalog-data.mjs'
export { validateCatalog } from './catalog-data.mjs'

const MAX_BYTES = 1048576
const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR'
const contained = (root, path) => {
  const rest = relative(root, path)
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith('..' + sep))
}
function options(input, keys) {
  const value = fields(input, INPUT)
  exact(value, keys, INPUT)
  return value
}
function rootInput(value) {
  if (!safeText(value) || Buffer.byteLength(value) > 4096 || !isAbsolute(value)) fail(INPUT)
  return value
}
function backendInput(value) {
  if (value !== 'codex' && value !== 'claude') fail(INPUT)
  return value
}
function inspectRoot(path) {
  try {
    const canonical = realpathSync(path)
    if (!statSync(canonical).isDirectory()) return { status: 'unreadable' }
    return { status: 'present', canonical }
  } catch (e) { return { status: missing(e) ? 'missing' : 'unreadable' } }
}

export function loadOfferingCatalog(input) {
  const opts = options(input, ['installationRoot'])
  const root = rootInput(opts.installationRoot)
  let fd
  try {
    const canonical = realpathSync(root)
    if (!statSync(canonical).isDirectory()) fail(INPUT)
    const file = realpathSync(join(canonical, 'spec/offering-capabilities.json'))
    if (!contained(canonical, file)) fail('INVALID_CATALOG')
    // Reject special files before open; finite regular-file reads only. This is
    // a static-path check, not protection against concurrent replacement.
    if (!statSync(file).isFile()) fail('INVALID_CATALOG')
    fd = openSync(file, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_BYTES) fail('INVALID_CATALOG')
    const bytes = Buffer.alloc(MAX_BYTES + 1)
    let length = 0, n
    while (length < bytes.length && (n = readSync(fd, bytes, length, bytes.length - length, null))) length += n
    if (length > MAX_BYTES) fail('INVALID_CATALOG')
    let parsed
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) }
    catch { fail('INVALID_CATALOG') }
    return catalogData(parsed, 'INVALID_CATALOG')
  } catch (e) {
    if (['INVALID_CATALOG', INPUT].includes(e.code)) throw e
    fail(missing(e) ? 'NOT_FOUND' : 'IO_ERROR')
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { fail('IO_ERROR') }
    }
  }
}

function skillHash(directory, root) {
  const file = realpathSync(join(directory, 'SKILL.md'))
  if (!contained(root, file) || !contained(directory, file) || !statSync(file).isFile()) fail('UNREADABLE_ENTRY')
  const fd = openSync(file, 'r')
  try {
    if (!fstatSync(fd).isFile()) fail('UNREADABLE_ENTRY')
    const hash = createHash('sha256'), bytes = Buffer.alloc(65536)
    let length
    while ((length = readSync(fd, bytes, 0, bytes.length, null))) hash.update(bytes.subarray(0, length))
    return hash.digest('hex')
  } finally { closeSync(fd) }
}
function inspectSource(offering, root) {
  if (root.status !== 'present') return { status: root.status }
  try {
    const canonical = realpathSync(join(root.canonical, offering.source))
    if (!contained(root.canonical, canonical) || !statSync(canonical).isDirectory()) return { status: 'unreadable' }
    try {
      const status = !offering.entrySkill || skillHash(canonical, root.canonical) === offering.entrySha256 ? 'present' : 'drifted'
      return { status, canonical }
    } catch (e) { return { status: missing(e) ? 'missing' : 'unreadable', canonical } }
  } catch (e) { return { status: missing(e) ? 'missing' : 'unreadable' } }
}
function inspectEntry(path, offering, source, root) {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      let canonical
      try { canonical = realpathSync(path) }
      catch (e) { return missing(e) || e.code === 'ELOOP' ? 'broken' : 'unreadable' }
      if (source.status === 'unreadable') return 'unreadable'
      // Compare destinations without opening the contents of a wrong target.
      return canonical === source.canonical ? 'linked' : 'wrong-target'
    }
    if (!stat.isDirectory()) return 'unreadable'
    const canonical = realpathSync(path)
    if (!contained(root.canonical, canonical)) return 'unreadable'
    try { return skillHash(canonical, root.canonical) === offering.entrySha256 ? 'copy' : 'drifted' }
    catch (e) { return missing(e) ? 'drifted' : 'unreadable' }
  } catch (e) { return missing(e) ? 'absent' : 'unreadable' }
}
function visibility(offering, source, root) {
  if (!offering.entrySkill) return 'library-only'
  if (root.status !== 'present') return root.status === 'missing' ? 'absent' : 'unreadable'
  const states = offering.installTargets.map(target => inspectEntry(join(root.canonical, target.slice('skills/'.length)), offering, source, root))
  // An error on any declared entry must not be hidden by a healthy alias.
  for (const state of ['unreadable', 'wrong-target', 'broken', 'drifted', 'absent', 'linked', 'copy']) {
    if (states.includes(state)) return state
  }
  return 'absent'
}

export function discoverOfferings(input) {
  const opts = options(input, ['catalog', 'installationRoot', 'skillsRoot', 'backend'])
  const catalog = catalogData(opts.catalog), backend = backendInput(opts.backend)
  const installationRoot = rootInput(opts.installationRoot), skillsRoot = rootInput(opts.skillsRoot)
  const sourceRoot = inspectRoot(installationRoot), targetRoot = inspectRoot(skillsRoot)
  const known = new Set(catalog.offerings.flatMap(row => row.installTargets.map(target => target.slice('skills/'.length))))
  let unknownEntries = []
  if (targetRoot.status === 'present') {
    try { unknownEntries = readdirSync(targetRoot.canonical).filter(name => safeFilename(name) && !known.has(name)).sort() }
    catch { targetRoot.status = 'unreadable' }
  }
  const offerings = catalog.offerings.map(offering => {
    const source = inspectSource(offering, sourceRoot), visible = visibility(offering, source, targetRoot)
    return { id: offering.id, visibility: visible, sourceStatus: source.status,
      installEligible: eligible(offering, backend), nativeImplementation: offering.nativeImplementation,
      nativeReadiness: 'unknown', blockers: blockers(offering, source.status, visible) }
  })
  return { schemaVersion: 1, backend, offerings, unknownEntries }
}

function settingsData(input) {
  try {
    const value = json(input, INPUT)
    exact(value, ['values', 'sources'], INPUT)
    if (!record(value.values) || !record(value.sources) || Object.hasOwn(value.values, 'sources')) fail(INPUT)
    // Reuse the owner's value/source predicates, then refuse fields it would
    // otherwise drop. Preserve the supplied resolver projection without coercion.
    const clean = sanitizeSettings({ ...value.values, sources: value.sources })
    if (Object.keys(clean).length !== Object.keys(value.values).length + 1 ||
      Object.keys(clean.sources).length !== Object.keys(value.sources).length) fail(INPUT)
    return value
  } catch { fail(INPUT) }
}
export function projectOfferingPreflight(input) {
  const opts = options(input, ['catalog', 'discovery', 'offeringId', 'backend', 'settings'])
  const catalog = catalogData(opts.catalog), backend = backendInput(opts.backend)
  const discovery = discoveryData(opts.discovery, catalog, backend)
  if (typeof opts.offeringId !== 'string') fail(INPUT)
  const index = catalog.offerings.findIndex(row => row.id === opts.offeringId)
  if (index < 0) fail(INPUT)
  const offering = catalog.offerings[index], row = discovery.offerings[index]
  const settings = settingsData(opts.settings)
  const readiness = row.sourceStatus !== 'present' ||
    ['absent', 'drifted', 'broken', 'wrong-target', 'unreadable'].includes(row.visibility) ? 'degraded' : 'unknown'
  return { offeringId: offering.id, backend, visibility: row.visibility,
    implementation: offering.nativeImplementation, readiness, settings,
    runtimes: offering.requiredRuntimes.map(name => ({ name, status: 'unknown', version: null })),
    auth: { status: 'unknown', value: null }, account: { status: 'unknown', value: null },
    payer: { status: 'unknown', value: null }, blockers: row.blockers }
}
