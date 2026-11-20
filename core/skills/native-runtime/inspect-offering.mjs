// Offering inspection (spec/contracts/codex-parity-cp-01d.md): whether one offering can
// run on one backend on this host, as ready, unsupported or unknown. The static checks
// read the catalog, its drift guard and the executable's file metadata; the executable
// is never run, opened or read. Only a caller-injected probe may start anything, so a
// ready from a fake probe is wiring proof, not runtime certification.
import { stat, access, constants } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { types } from 'node:util'
import { fields, exact, fail } from './boundary.mjs'
import { safeText } from './catalog-data.mjs'
import { loadOfferingCatalog, checkCatalogDrift, providerImplementation } from './catalog.mjs'

// autobuild `limits` keys that become Claude CLI flags and have no Codex equivalent.
export const CLAUDE_ONLY_CONTROLS = Object.freeze(['maxBudgetUsd', 'maxTurns', 'totalBudgetUsd', 'bughuntBudgetUsd',
  'reviewMaxTurns', 'reviewBudgetUsd'])

const INPUT = 'INVALID_INSPECT_INPUT'
const BACKENDS = ['claude', 'codex']
const DEFAULT_PROBE_TIMEOUT_MS = 30000
const MAX_PROBE_TIMEOUT_MS = 600000
const MISSING_EXECUTABLE = ['ENOENT', 'ENOTDIR', 'ELOOP']
const DEPENDENCY_PROBLEMS = ['SOURCE_MISSING', 'ENTRY_SHA_MISMATCH', 'DEPENDENCY_UNDECLARED']
const REPORT_KEYS = ['model', 'effort', 'concurrency']

const check = (id, status, code = null) => ({ id, status, code })
const pass = id => check(id, 'pass')
const skipped = id => check(id, 'skipped')

// ---- input --------------------------------------------------------------------------

// A plain object of own data properties (no getter is run) with every required key and
// no key outside required + optional.
function plainObject(value, required, optional) {
  const result = fields(value, INPUT)
  const allowed = [...required, ...optional]
  if (required.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => !allowed.includes(key))) fail(INPUT)
  return result
}
const absolutePath = value => safeText(value) && Buffer.byteLength(value) <= 4096 && isAbsolute(value)
const configuredText = value => value === null || (safeText(value) && Buffer.byteLength(value) <= 256)
const configuredConcurrency = value => value === null || (Number.isSafeInteger(value) && value > 0)
const probeTimeout = value => Number.isInteger(value) && value >= 1 && value <= MAX_PROBE_TIMEOUT_MS

// An optional key that is absent or explicitly undefined takes its default.
function inspectInput(input) {
  const opts = plainObject(input, ['installationRoot', 'offeringId', 'backend', 'executable', 'configuration'],
    ['probe', 'probeTimeoutMs'])
  const configuration = plainObject(opts.configuration, ['model', 'effort', 'maxConcurrentSubagents'], ['limits'])
  const limits = configuration.limits === undefined ? Object.create(null) : fields(configuration.limits, INPUT)
  const probeTimeoutMs = opts.probeTimeoutMs === undefined ? DEFAULT_PROBE_TIMEOUT_MS : opts.probeTimeoutMs
  if (!absolutePath(opts.installationRoot) || typeof opts.offeringId !== 'string' || !BACKENDS.includes(opts.backend) ||
    !absolutePath(opts.executable) || (opts.probe !== undefined && typeof opts.probe !== 'function') ||
    !probeTimeout(probeTimeoutMs) || !configuredText(configuration.model) || !configuredText(configuration.effort) ||
    !configuredConcurrency(configuration.maxConcurrentSubagents)) fail(INPUT)
  return { installationRoot: opts.installationRoot, offeringId: opts.offeringId, backend: opts.backend,
    executable: opts.executable, model: configuration.model, effort: configuration.effort,
    maxConcurrentSubagents: configuration.maxConcurrentSubagents, limits, probe: opts.probe, probeTimeoutMs }
}

// ---- static checks ------------------------------------------------------------------

function implementationCheck(offering, backend) {
  try {
    return providerImplementation(offering, backend) === 'unavailable'
      ? check('implementation', 'fail', 'PROVIDER_UNAVAILABLE') : pass('implementation')
  } catch { return check('implementation', 'unknown', 'INSPECTION_ERROR') }
}

// Metadata only: stat and access follow symlinks and never open the file.
async function executableCheck(path) {
  let info
  try { info = await stat(path) } catch (error) {
    return MISSING_EXECUTABLE.includes(error?.code)
      ? check('executable', 'fail', 'EXECUTABLE_MISSING') : check('executable', 'unknown', 'INSPECTION_ERROR')
  }
  if (!info.isFile()) return check('executable', 'fail', 'EXECUTABLE_NOT_RUNNABLE')
  try { await access(path, constants.X_OK) } catch { return check('executable', 'fail', 'EXECUTABLE_NOT_RUNNABLE') }
  return pass('executable')
}

// The offering's transitive dependency ids. The loaded catalog is validated, so every
// id exists and the graph is acyclic.
function dependencyClosure(catalog, offering) {
  const byId = new Map(catalog.offerings.map(row => [row.id, row]))
  const closure = new Set(), pending = [...offering.dependencies]
  while (pending.length) {
    const id = pending.pop()
    if (closure.has(id)) continue
    closure.add(id)
    pending.push(...byId.get(id).dependencies)
  }
  return closure
}

// Checks 3 to 6 from one checkCatalogDrift call. Each problem is counted once: entry
// takes its share first, then transport, then dependencies; any problem left over is
// catalog drift.
function driftChecks(installationRoot, catalog, offering, backend) {
  let drift
  try { drift = checkCatalogDrift({ installationRoot }) } catch (error) {
    const catalogCheck = error?.code === 'CATALOG_NO_PINS'
      ? check('catalog', 'fail', 'CATALOG_NO_PINS') : check('catalog', 'unknown', 'INSPECTION_ERROR')
    return [catalogCheck, skipped('entry'), skipped('transport'), skipped('dependencies')]
  }
  let remaining = drift.problems
  const take = matches => {
    const taken = remaining.filter(matches)
    remaining = remaining.filter(problem => !matches(problem))
    return taken
  }

  const entry = take(problem => problem.ref === offering.id).length > 0
    ? check('entry', 'fail', 'ENTRY_DRIFT') : pass('entry')

  const transportId = catalog.schemaVersion === 2 ? offering.providers[backend].transportId : null
  let transport = skipped('transport')
  if (transportId !== null) {
    transport = take(problem => problem.code === 'TRANSPORT_ENTRY_MISSING' && problem.ref === transportId).length > 0
      ? check('transport', 'fail', 'TRANSPORT_MISSING') : pass('transport')
  }

  const closure = dependencyClosure(catalog, offering)
  const dependencyProblems = take(problem => closure.has(problem.ref) && DEPENDENCY_PROBLEMS.includes(problem.code))
  let dependencies = pass('dependencies')
  if (dependencyProblems.some(problem => problem.code === 'SOURCE_MISSING')) dependencies = check('dependencies', 'fail', 'DEPENDENCY_MISSING')
  else if (dependencyProblems.length > 0) dependencies = check('dependencies', 'fail', 'DEPENDENCY_DRIFT')

  const catalogCheck = remaining.length > 0 ? check('catalog', 'fail', 'CATALOG_DRIFT') : pass('catalog')
  return [catalogCheck, entry, transport, dependencies]
}

function configurationCheck(input) {
  return [input.model, input.effort, input.maxConcurrentSubagents].includes(null)
    ? check('configuration', 'fail', 'CONFIGURATION_MISSING') : pass('configuration')
}

// A cap is set when it is an own key whose value is not null, so 0 is set.
function setControls(limits) {
  return CLAUDE_ONLY_CONTROLS.filter(key => Object.hasOwn(limits, key) && limits[key] !== null)
}

// ---- probe --------------------------------------------------------------------------

// Read as data: a getter, proxy, class instance or extra key is invalid, never run.
function reportCheck(report) {
  let value
  try {
    value = fields(report, 'PROBE_INVALID')
    exact(value, REPORT_KEYS, 'PROBE_INVALID')
    if (!REPORT_KEYS.every(key => typeof value[key] === 'boolean')) fail('PROBE_INVALID')
  } catch { return check('probe', 'unknown', 'PROBE_INVALID') }
  if (!value.model) return check('probe', 'fail', 'MODEL_UNSUPPORTED')
  if (!value.effort) return check('probe', 'fail', 'EFFORT_UNSUPPORTED')
  if (!value.concurrency) return check('probe', 'fail', 'CONCURRENCY_UNSUPPORTED')
  return pass('probe')
}

// Settles with the promise's outcome or a timeout, whichever comes first. The handlers
// are attached at once, so a rejection after the timeout is handled, not unhandled.
function settleWithin(pending, timeoutMs, controller) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      controller.abort()
      resolve({ outcome: 'timeout' })
    }, timeoutMs)
    Promise.prototype.then.call(pending,
      value => { clearTimeout(timer); resolve({ outcome: 'settled', value }) },
      () => { clearTimeout(timer); resolve({ outcome: 'rejected' }) })
  })
}

// Calls the probe exactly once. Only a native promise is awaited; any other return
// value is the report itself, so no `then` lookup can run a getter on it.
async function probeCheck(input) {
  const controller = new AbortController()
  const request = Object.freeze({ backend: input.backend, offeringId: input.offeringId, executable: input.executable,
    model: input.model, effort: input.effort, maxConcurrentSubagents: input.maxConcurrentSubagents,
    signal: controller.signal })
  let returned
  try { returned = input.probe(request) } catch { return check('probe', 'unknown', 'PROBE_ERROR') }
  if (!types.isPromise(returned)) return reportCheck(returned)
  const settled = await settleWithin(returned, input.probeTimeoutMs, controller)
  if (settled.outcome === 'timeout') return check('probe', 'unknown', 'PROBE_TIMEOUT')
  if (settled.outcome === 'rejected') return check('probe', 'unknown', 'PROBE_ERROR')
  return reportCheck(settled.value)
}

// ---- inspection ---------------------------------------------------------------------

function statusOf(checks) {
  if (checks.some(entry => entry.status === 'fail')) return 'unsupported'
  return checks.every(entry => entry.status === 'pass') ? 'ready' : 'unknown'
}

export async function inspectOffering(options) {
  const input = inspectInput(options)
  const catalog = loadOfferingCatalog({ installationRoot: input.installationRoot })
  const offering = catalog.offerings.find(row => row.id === input.offeringId)
  if (offering === undefined) fail('UNKNOWN_OFFERING')

  const controls = input.backend === 'codex' ? setControls(input.limits) : []
  const checks = [
    implementationCheck(offering, input.backend),
    await executableCheck(input.executable),
    ...driftChecks(input.installationRoot, catalog, offering, input.backend),
    configurationCheck(input),
    controls.length > 0 ? check('controls', 'fail', 'UNSUPPORTED_CONTROL') : pass('controls'),
  ]
  // The probe runs only after every static check passes; with no probe the result can
  // never be ready.
  let probe = skipped('probe')
  if (checks.every(entry => entry.status === 'pass')) {
    probe = input.probe === undefined ? check('probe', 'unknown', 'PROBE_ABSENT') : await probeCheck(input)
  }
  checks.push(probe)

  return { schemaVersion: 1, offeringId: offering.id, backend: input.backend, status: statusOf(checks), checks,
    unsupportedControls: controls,
    limitations: catalog.schemaVersion === 2 ? [...offering.providers[input.backend].limitations] : [] }
}
