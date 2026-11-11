#!/usr/bin/env node
// One offline, static preflight for a single native-runtime offering. It chains the
// existing catalog loader, discovery and projection with the existing settings
// resolver. It reads files and writes nothing: no provider process, no auth or
// network probe, no installer change. Exit 0 is the absence of an offline refusal,
// never readiness: runtime, account and payer facts stay unknown.
import { join, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKENDS = ['codex', 'claude']
const FLAGS = new Map([
  ['--installation-root', 'installationRoot'], ['--skills-root', 'skillsRoot'],
  ['--backend', 'backend'], ['--offering', 'offeringId'],
])
const NEEDED = ['loadOfferingCatalog', 'discoverOfferings', 'projectOfferingPreflight', 'resolveSettings', 'readAgentConfig']
const SEMANTICS = 'Offline static report: settings are configured values, not observed enforcement; ' +
  'runtime, auth, account and payer are unknown; exit 0 is not readiness or certification.'

// Closed diagnostics: nothing from an argument, file or library error is echoed.
const MESSAGES = {
  INVALID_USAGE: 'Invalid arguments. Run with --help.',
  CATALOG_NOT_FOUND: 'Offering catalog spec/offering-capabilities.json was not found (or the installation root does not exist).',
  CATALOG_INVALID: 'Offering catalog is malformed, unsafe or oversize.',
  CATALOG_IO_ERROR: 'Offering catalog could not be read.',
  UNKNOWN_OFFERING: 'The offering is not in the catalog.',
  CONFIG_NOT_FOUND: 'agent-config.json was not found under the installation root.',
  CONFIG_INVALID: 'agent-config.json or the resolved settings are unreadable or invalid.',
  DEPENDENCY_UNAVAILABLE: 'A required PandaStack module could not be loaded.',
  PREFLIGHT_FAILED: 'The preflight projection could not be produced.',
}
const CATALOG_CODES = new Map([['NOT_FOUND', 'CATALOG_NOT_FOUND'], ['INVALID_CATALOG', 'CATALOG_INVALID'],
  ['IO_ERROR', 'CATALOG_IO_ERROR'], ['INVALID_CATALOG_INPUT', 'INVALID_USAGE']])

const HELP = [
  'Usage: preflight-cli --installation-root PATH --skills-root PATH --backend codex|claude --offering ID',
  '       preflight-cli --help',
  '',
  'Offline static preflight for one native-runtime offering. All four flags are required,',
  'each once; both roots must be absolute paths.',
  '',
  'Offline semantics:',
  '  Reads only the catalog (spec/offering-capabilities.json) and agent-config.json under',
  '  --installation-root, that root\'s offering sources, and the entries under --skills-root.',
  '  Writes nothing and creates no directories. Starts no provider or other process, does',
  '  no authentication check and makes no network request.',
  '  Model, effort and concurrency come from the existing settings resolver, using',
  '  agent-config.json and the process environment (for example AUTOBUILD_MODEL), with',
  '  provenance. No project autobuild.json is read. They are configured values, not',
  '  observed enforcement.',
  '  Runtime versions, authentication, account and payer are always reported as unknown.',
  '  Source and skill visibility describe files on disk, not that the offering can run.',
  '  --backend selects catalog eligibility only; it does not preflight the legacy Claude installer.',
  '',
  'Output: one JSON object on stdout.',
  '',
  'Exit codes:',
  '  0  Report printed and no offline refusal was found. This is not readiness, support or',
  '     certification: readiness stays unknown and nothing here has run the offering.',
  '  1  Invalid arguments, or the catalog, agent-config.json or a required module is missing',
  '     or invalid. One JSON error line on stderr, nothing on stdout.',
  '  2  Report printed and execution refused: implementation not certified, not install',
  '     eligible, library-only, degraded source or visibility, or a dependency source that',
  '     is not present.',
].join('\n')

const cliError = code => Object.assign(new Error(code), { cliCode: code })

function parse(args) {
  const usage = () => cliError('INVALID_USAGE')
  if (!Array.isArray(args)) throw usage()
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { help: true }
  // Exactly four flag/value pairs, each flag once, no defaults and no positionals.
  if (args.length !== FLAGS.size * 2) throw usage()
  const values = {}
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1]
    if (!FLAGS.has(flag) || Object.hasOwn(values, FLAGS.get(flag)) ||
      typeof value !== 'string' || !value.length || value.startsWith('--')) throw usage()
    values[FLAGS.get(flag)] = value
  }
  if (!BACKENDS.includes(values.backend) || !isAbsolute(values.installationRoot) || !isAbsolute(values.skillsRoot)) throw usage()
  return values
}

// Imported lazily so a missing module is a clear coded failure, not a stack trace.
async function loadDependencies() {
  const [catalog, doctor, agentConfig] = await Promise.all([import('./catalog.mjs'),
    import('../run-records/doctor.mjs'), import('../../../scripts/agent-config.mjs')])
  return { loadOfferingCatalog: catalog.loadOfferingCatalog, discoverOfferings: catalog.discoverOfferings,
    projectOfferingPreflight: catalog.projectOfferingPreflight, resolveSettings: doctor.resolveSettings,
    readAgentConfig: agentConfig.readAgentConfig }
}
async function loadChecked(load) {
  let deps
  try { deps = await load() } catch { throw cliError('DEPENDENCY_UNAVAILABLE') }
  if (!deps || NEEDED.some(name => typeof deps[name] !== 'function')) throw cliError('DEPENDENCY_UNAVAILABLE')
  return deps
}
function stage(work, translate) {
  try { return work() } catch (error) { throw cliError(translate(error?.code)) }
}

// Transitive catalog dependencies in catalog order. The loaded catalog is already
// validated: every dependency id exists and the graph is acyclic.
function dependencyRows(catalog, discovery, index) {
  const position = new Map(catalog.offerings.map((row, i) => [row.id, i]))
  const wanted = new Set(), pending = [...catalog.offerings[index].dependencies]
  while (pending.length) {
    const id = pending.pop()
    if (wanted.has(id)) continue
    wanted.add(id)
    pending.push(...catalog.offerings[position.get(id)].dependencies)
  }
  return catalog.offerings.flatMap((row, i) => !wanted.has(row.id) ? [] :
    [{ id: row.id, visibility: discovery.offerings[i].visibility, sourceStatus: discovery.offerings[i].sourceStatus }])
}

// Refusal reasons are offline facts only. NATIVE_UNVERIFIED is on every row, so it
// cannot be the gate; the absence of a reason is not a readiness claim.
function refusalReasons(report, row, dependencies) {
  return [
    report.implementation === 'not-certified' && 'IMPLEMENTATION_NOT_CERTIFIED',
    !row.installEligible && 'NOT_INSTALL_ELIGIBLE',
    report.visibility === 'library-only' && 'LIBRARY_ONLY',
    report.readiness === 'degraded' && 'READINESS_DEGRADED',
    dependencies.some(dependency => dependency.sourceStatus !== 'present') && 'DEPENDENCY_SOURCE_NOT_PRESENT',
  ].filter(Boolean)
}

export async function preflightMain(args, options) {
  const { env = process.env, load = loadDependencies } = options ?? {}
  try {
    const request = parse(args)
    if (request.help) { console.log(HELP); return 0 }
    const { installationRoot, skillsRoot, backend, offeringId } = request
    const deps = await loadChecked(load)
    const catalog = stage(() => deps.loadOfferingCatalog({ installationRoot }), code => CATALOG_CODES.get(code) ?? 'PREFLIGHT_FAILED')
    const index = catalog.offerings.findIndex(row => row.id === offeringId)
    if (index < 0) throw cliError('UNKNOWN_OFFERING')
    // The central config is the explicit installation root's, never this checkout's.
    const central = stage(() => deps.readAgentConfig(join(installationRoot, 'agent-config.json')),
      code => code === 'ENOENT' ? 'CONFIG_NOT_FOUND' : 'CONFIG_INVALID')
    const settings = stage(() => deps.resolveSettings({ backend, central, project: {}, env, overrides: {} }), () => 'CONFIG_INVALID')
    const discovery = stage(() => deps.discoverOfferings({ catalog, installationRoot, skillsRoot, backend }),
      code => code === 'INVALID_CATALOG_INPUT' ? 'INVALID_USAGE' : 'PREFLIGHT_FAILED')
    const report = stage(() => deps.projectOfferingPreflight({ catalog, discovery, offeringId, backend, settings }), () => 'PREFLIGHT_FAILED')
    const row = discovery.offerings[index], dependencies = dependencyRows(catalog, discovery, index)
    const reasons = refusalReasons(report, row, dependencies)
    const configured = Object.fromEntries(['model', 'effort', 'maxConcurrentSubagents'].map(key =>
      [key, { value: report.settings.values[key] ?? null, source: report.settings.sources[key] ?? 'unknown' }]))
    console.log(JSON.stringify({ schemaVersion: 1, mode: 'offline-static-preflight', backend, offeringId,
      implementation: report.implementation, visibility: report.visibility, installEligible: row.installEligible,
      readiness: report.readiness, configured, settings: report.settings, runtimes: report.runtimes,
      auth: report.auth, account: report.account, payer: report.payer, dependencies, blockers: report.blockers,
      refusal: { refused: reasons.length > 0, reasons }, semantics: SEMANTICS }))
    return reasons.length > 0 ? 2 : 0
  } catch (error) {
    const code = Object.hasOwn(MESSAGES, error?.cliCode) ? error.cliCode : 'PREFLIGHT_FAILED'
    console.error(JSON.stringify({ error: code, message: MESSAGES[code] }))
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await preflightMain(process.argv.slice(2))
