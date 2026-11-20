// Static inventory only: no installer changes, runtime probes or provider ports.
import { lstatSync, statSync, realpathSync, readdirSync, openSync, fstatSync, readSync, readFileSync, closeSync, constants } from 'node:fs'
import { join, isAbsolute, posix } from 'node:path'
import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { fields, exact, json, record, fail, sha } from './boundary.mjs'
import { sanitizeSettings } from '../run-records/records.mjs'
import { INPUT, catalogData, discoveryData, safeText, safeFilename, backendInput, blockers,
  installEligible, nativeImplementationOf, identifier } from './catalog-data.mjs'
import { loadRoleFile } from './role-files.mjs'
import { catalogPathContains as contained, catalogPathsEqual } from './catalog-paths.mjs'
export { validateCatalog, providerImplementation, installEligible, nativeImplementationOf } from './catalog-data.mjs'

const MAX_BYTES = 1048576
const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR'
function options(input, keys) {
  const value = fields(input, INPUT)
  exact(value, keys, INPUT)
  return value
}
function rootInput(value) {
  if (!safeText(value) || Buffer.byteLength(value) > 4096 || !isAbsolute(value)) fail(INPUT)
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
      return source.canonical && catalogPathsEqual(canonical, source.canonical) ? 'linked' : 'wrong-target'
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
      installEligible: installEligible(offering, backend), nativeImplementation: nativeImplementationOf(offering),
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
    implementation: nativeImplementationOf(offering), readiness, settings,
    runtimes: offering.requiredRuntimes.map(name => ({ name, status: 'unknown', version: null })),
    auth: { status: 'unknown', value: null }, account: { status: 'unknown', value: null },
    payer: { status: 'unknown', value: null }, blockers: row.blockers }
}

// ---- drift guard (spec/contracts/codex-parity-cp-01b.md) --------------------------
// A static, read-only check of a v2 catalog against the tree it describes. It is not
// protection against concurrent replacement. Every path is root-relative under the
// canonical installation root.

const MENTION = /skills\/([a-z0-9][a-z0-9-]*)\//g
const STATIC_IMPORT = /^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom[ \t]*(['"])([^'"\n]+)\1|^[ \t]*import[ \t]*(['"])([^'"\n]+)\3/gm
const CODE_FILE = /\.(?:mjs|js|cjs)$/
const WORKFLOW_GRAPH = /^graphs\/([^/]+)\/workflows\/[^/]+$/
const CORE_SKILL = /^core\/skills\/([^/]+)\//
// Never follow a final symlink. O_NONBLOCK: with it, opening a FIFO returned at once
// in tests/native-catalog-drift.test.mjs instead of waiting for a writer.
const NO_FOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

const problem = (code, ref, dependency = null) => ({ code, ref, dependency })
// String order with null before any string.
const order = (a, b) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1)

// use(fd) for a regular file, or null when the path is missing, a symlink, a
// directory or another special file, or cannot be opened or read.
function withRegularFile(root, rel, use) {
  let fd
  try {
    fd = openSync(join(root, rel), NO_FOLLOW)
    return fstatSync(fd).isFile() ? use(fd) : null
  } catch { return null } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { fail('IO_ERROR') }
    }
  }
}
const regularFileBytes = (root, rel) => withRegularFile(root, rel, fd => readFileSync(fd))
const isRegularFile = (root, rel) => withRegularFile(root, rel, () => true) === true

function isRealDirectory(root, rel) {
  try { return lstatSync(join(root, rel)).isDirectory() } catch { return false }
}
// Dirents of a directory, or [] when it is missing. Their kinds come from lstat, so a
// symlink is neither a directory nor a file. Any other listing failure is IO_ERROR.
function listing(root, rel) {
  try { return readdirSync(join(root, rel), { withFileTypes: true }) } catch (e) {
    if (missing(e)) return []
    fail('IO_ERROR')
  }
}
const realDirectories = (root, rel) => listing(root, rel).filter(d => d.isDirectory()).map(d => d.name)

// core/skills, kit/skills and graphs/<g>/skills, each real. `safe` is false when <g>
// is not a catalog identifier, so no path under it is ever reported.
function skillContainers(root) {
  const top = realDirectories(root, '')
  const parents = ['core', 'kit'].filter(name => top.includes(name)).map(dir => ({ dir, safe: true }))
  if (top.includes('graphs')) {
    for (const graph of realDirectories(root, 'graphs')) parents.push({ dir: `graphs/${graph}`, safe: identifier(graph) })
  }
  return parents.filter(({ dir }) => realDirectories(root, dir).includes('skills'))
    .map(({ dir, safe }) => ({ dir: `${dir}/skills`, safe }))
}

function unlistedSources(root, catalog) {
  const sources = new Set(catalog.offerings.map(row => row.source))
  return skillContainers(root).flatMap(({ dir, safe }) => realDirectories(root, dir)
    .filter(name => !sources.has(`${dir}/${name}`))
    .map(name => problem('SOURCE_UNLISTED', safe && identifier(name) ? `${dir}/${name}` : null)))
}

// Rule 1: each role of a graphs/<g>/workflows row gives its `skills:` names to every
// entry offering under graphs/<g>/skills. Every role is loaded, owner or not, so a
// role-file error always fails closed with its own code.
function roleEdges(root, catalog, add) {
  for (const workflow of catalog.workflows) {
    const graph = WORKFLOW_GRAPH.exec(workflow.source)?.[1]
    if (graph === undefined) continue
    const owners = catalog.offerings.filter(row => row.entrySkill && row.source.startsWith(`graphs/${graph}/skills/`))
    for (const role of workflow.roles) {
      const { skills } = loadRoleFile({ installationRoot: root, name: role }).frontmatter
      for (const owner of owners) for (const skill of skills) add(owner.id, skill)
    }
  }
}

// Rule 2: every skills/<name>/ mention in the entry SKILL.md text.
function mentionEdges(row, bytes, add) {
  for (const match of bytes.toString('utf8').matchAll(MENTION)) add(row.id, match[1])
}

// Regular code files under a source, through real directories only.
function codeFiles(root, rel) {
  return listing(root, rel).flatMap(d => {
    const path = `${rel}/${d.name}`
    if (d.isDirectory()) return codeFiles(root, path)
    return d.isFile() && CODE_FILE.test(d.name) ? [path] : []
  })
}

// Rule 3: static relative imports that resolve into core/skills/<name>/.
function importEdges(root, row, add) {
  for (const file of codeFiles(root, row.source)) {
    const bytes = regularFileBytes(root, file)
    if (bytes === null) fail('IO_ERROR')
    for (const match of bytes.toString('utf8').matchAll(STATIC_IMPORT)) {
      const specifier = match[2] ?? match[4]
      if (!specifier.startsWith('.')) continue
      const target = CORE_SKILL.exec(posix.join(posix.dirname(file), specifier))?.[1]
      if (target !== undefined) add(row.id, target)
    }
  }
}

export function checkCatalogDrift(input) {
  const opts = options(input, ['installationRoot'])
  const catalog = loadOfferingCatalog({ installationRoot: opts.installationRoot })
  if (catalog.schemaVersion !== 2) fail('CATALOG_NO_PINS')
  let root
  try { root = realpathSync(opts.installationRoot) } catch (e) { fail(missing(e) ? 'NOT_FOUND' : 'IO_ERROR') }

  const ids = new Set(catalog.offerings.map(row => row.id))
  const derived = new Map(catalog.offerings.map(row => [row.id, new Set()]))
  const add = (from, to) => { if (to !== from && ids.has(to)) derived.get(from).add(to) }
  const problems = unlistedSources(root, catalog)

  for (const row of catalog.offerings) {
    if (!isRealDirectory(root, row.source)) {
      problems.push(problem('SOURCE_MISSING', row.id))
      continue
    }
    if (row.entrySkill) {
      const bytes = regularFileBytes(root, `${row.source}/SKILL.md`)
      if (bytes === null || sha(bytes) !== row.entrySha256) problems.push(problem('ENTRY_SHA_MISMATCH', row.id))
      if (bytes !== null) mentionEdges(row, bytes, add)
    }
    importEdges(root, row, add)
  }
  roleEdges(root, catalog, add)

  for (const workflow of catalog.workflows) {
    const bytes = regularFileBytes(root, workflow.source)
    if (bytes === null || sha(bytes) !== workflow.sha256) problems.push(problem('WORKFLOW_SHA_MISMATCH', workflow.source))
  }
  for (const transport of catalog.transports) {
    if (!isRegularFile(root, transport.entry)) problems.push(problem('TRANSPORT_ENTRY_MISSING', transport.id))
  }
  for (const row of catalog.offerings) {
    for (const dependency of derived.get(row.id)) {
      if (!row.dependencies.includes(dependency)) problems.push(problem('DEPENDENCY_UNDECLARED', row.id, dependency))
    }
  }
  problems.sort((a, b) => order(a.code, b.code) || order(a.ref, b.ref) || order(a.dependency, b.dependency))
  return { ok: problems.length === 0, problems }
}
