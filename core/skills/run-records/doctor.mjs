// Read-only inspection of managed launches. Provider account availability is unknown.
import { readFileSync, statSync, accessSync, constants, existsSync } from 'node:fs'
import { join, isAbsolute, delimiter } from 'node:path'
import { readAgentConfig, validateAgentConfig } from '../../../scripts/agent-config.mjs'
import { renderAgentConfig, ROOT } from '../../../scripts/configure-agents.mjs'
import { resolveManagedModels, resolveManagedConfig } from '../../../graphs/autobuild/tool/lib/config.mjs'
import { findInstalls, assessInstalls } from '../../../graphs/autobuild/tool/lib/codex-installs.mjs'
import { sanitizeSettings } from './records.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const controls = ['model', 'effort', 'concurrency']
const efforts = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none'])
function validateProject(project, env, overrides) {
  if (![project, env, overrides].every(object) || Object.keys(overrides).some(k => k !== 'model')) throw Error('Invalid configuration')
  // Model validation belongs to the shared resolver after precedence selection;
  // shadowed project/environment values are not managed launch inputs.
  for (const key of ['maxConcurrentSubagents', 'subagentModelForce']) {
    if (Object.hasOwn(project, key)) sanitizeSettings({ [key]: project[key] })
  }
  if (project.codex !== undefined && !object(project.codex)) throw Error('Invalid configuration')
  if (project.codex && Object.hasOwn(project.codex, 'reasoningEffort') && !efforts.has(project.codex.reasoningEffort)) throw Error('Invalid configuration')
  if (project.env !== undefined) {
    if (!object(project.env) || (project.env.vars !== undefined && !object(project.env.vars))) throw Error('Invalid configuration')
    if (Object.values(project.env.vars ?? {}).some(v => typeof v !== 'string')) throw Error('Invalid configuration')
    for (const key of ['pathPrepend', 'ldLibraryPath']) {
      if (project.env[key] !== undefined && (!Array.isArray(project.env[key]) || project.env[key].some(v => typeof v !== 'string'))) throw Error('Invalid configuration')
    }
  }
}

export function resolveSettings({ backend, central, project = {}, env = {}, overrides = {} }) {
  return resolveInspection({ backend, central, project, env, overrides }).settings
}

function resolveInspection({ backend, central, project, env, overrides }) {
  if (!['claude', 'codex'].includes(backend)) throw Error('Invalid backend')
  validateAgentConfig(central)
  validateProject(project, env, overrides)
  const config = resolveManagedConfig({ project, env, overrides: { ...overrides, backend }, central })
  const { values, sources } = resolveManagedModels({ backend, central, project, env, overrides })
  const set = (key, value, source) => { values[key] = value; sources[key] = source }
  set('maxConcurrentSubagents', project.maxConcurrentSubagents ?? central.maxConcurrentSubagents,
    project.maxConcurrentSubagents === undefined ? 'central' : 'project')
  set('subagentModelForce', project.subagentModelForce ?? false, project.subagentModelForce === undefined ? 'default' : 'project')
  if (backend === 'codex') {
    set('effort', project.codex?.reasoningEffort ?? 'medium', project.codex?.reasoningEffort === undefined ? 'default' : 'project')
    set('advisorModel', values.model, sources.model)
    set('advisorEffort', values.effort, sources.effort)
    set('subagentEffort', null, 'unknown')
    set('probeEffort', 'high', 'default')
  } else {
    const effort = project.env?.vars?.CLAUDE_CODE_EFFORT_LEVEL
    set('effort', effort === undefined ? central.claude.orchestrator.effort : efforts.has(effort) ? effort : null,
      effort === undefined ? 'central' : efforts.has(effort) ? 'project' : 'unknown')
    set('advisorModel', values.subagentModelForce ? values.subagentModel : central.claude.advisor.model,
      values.subagentModelForce ? sources.subagentModel : 'central')
    set('advisorEffort', central.claude.advisor.effort, 'central')
    set('subagentEffort', central.claude.subagents.effort, 'central')
    set('probeEffort', values.effort, sources.effort)
  }
  return { settings: { values: sanitizeSettings(values), sources }, config }
}

const unknownRuntime = (evidence = 'No established native control evidence.') => ({ version: null,
  controls: Object.fromEntries(controls.map(key => [key, { status: 'unknown', evidence }])) })
function normalizeRuntime(input) {
  const result = unknownRuntime()
  if (!object(input)) return result
  // Only version identifiers, never raw command output.
  if (typeof input.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(input.version)) result.version = input.version
  for (const key of controls) {
    const control = input.controls?.[key]
    if (object(control) && ['supported', 'unsupported', 'unknown'].includes(control.status) &&
      typeof control.evidence === 'string' && control.evidence.trim() && control.evidence.length <= 240 && !/[\x00-\x1f\x7f]/.test(control.evidence)) {
      result.controls[key] = { status: control.status, evidence: control.evidence }
    }
  }
  return result
}

// Anchor without join/resolve: the kernel must traverse symlink/.. components
// just as it does for a managed child running in the target repository.
const fromRepo = (repo, path) => isAbsolute(path) ? path : `${repo}/${path}`
function effectivePath(config, env, pandaRoot, repo) {
  const vars = config.env.vars ?? {}
  if (Object.hasOwn(vars, 'PATH')) return vars.PATH
  // The shared resolver has already expanded home prefixes. buildEnv omits
  // empty prefixes before search; an explicit PATH above retains empty entries.
  // Anchor only the existence check: serializing the repo would introduce new
  // PATH delimiters when its pathname contains a colon.
  const prepend = config.env.pathPrepend.filter(p => p && existsSync(fromRepo(repo, p)))
  const inherited = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const kit = join(pandaRoot, 'graphs/autobuild/tool/bin')
  return [...prepend, ...(inherited.includes(kit) ? [] : [kit]), ...inherited].join(delimiter)
}
function locateBinary(bin, path, repo) {
  const candidates = bin.includes('/') ? [fromRepo(repo, bin)] : path.split(delimiter).map(dir => fromRepo(repo, `${dir || '.'}/${bin}`))
  for (const file of candidates) {
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file } catch { /* Try the next PATH entry. */ }
  }
  return null
}
export async function inspectDoctor({ repo, backend = 'codex', pandaRoot = ROOT, env = process.env, overrides = {}, capabilityProbe } = {}) {
  const result = { schemaVersion: 1, status: 'blocked', backend, settings: { values: {}, sources: {} },
    runtime: unknownRuntime(capabilityProbe ? undefined : 'Provider execution was not performed; native control support is unknown.'), checks: [] }
  const check = (id, status, message) => result.checks.push({ id, status, message })
  let project, path, bin
  try {
    if (typeof repo !== 'string' || !isAbsolute(repo) || !statSync(repo).isDirectory()) throw Error('Invalid repository')
    const central = readAgentConfig(join(pandaRoot, 'agent-config.json'))
    try { project = JSON.parse(readFileSync(join(repo, 'autobuild.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') project = {}; else throw error }
    const resolved = resolveInspection({ backend, central, project, env, overrides })
    result.settings = resolved.settings
    path = effectivePath(resolved.config, env, pandaRoot, repo)
    bin = resolved.config[`${backend}Bin`]
    check('configuration', 'pass', 'Managed launch configuration is valid.')
    const rendered = renderAgentConfig(pandaRoot, central)
    const drift = [...rendered].some(([file, text]) => readFileSync(join(pandaRoot, file), 'utf8') !== text)
    check('generated', drift ? 'fail' : 'pass', drift ? 'Generated agent configuration has drifted.' : 'Generated agent configuration matches.')
  } catch {
    result.settings = { values: {}, sources: {} }
    check('configuration', 'fail', 'Configuration or generated files are invalid or unreadable.')
    return result
  }
  if (result.settings.values.effort === null) check('effort-setting', 'unknown', 'Managed effort is automatic, unset, or unrecognized.')
  try {
    // Injected probes provide discovery evidence for PATH names. Explicit paths
    // must still exist locally; a fixture cannot make a missing path ready.
    const executable = capabilityProbe ? bin : locateBinary(bin, path, repo)
    if (!executable) check('binary', 'fail', 'Managed provider executable was not found.')
    else {
      // Default inspection only checks presence. Executing even --version would
      // cross the trust boundary into code selected by project or environment.
      if (capabilityProbe) result.runtime = normalizeRuntime(await capabilityProbe({ backend, bin: executable, repo, path }))
      const missingPath = capabilityProbe && bin.includes('/') && !locateBinary(bin, path, repo)
      check('binary', missingPath ? 'fail' : 'pass', missingPath ? 'Managed provider executable was not found.' :
        capabilityProbe ? 'Managed provider probe completed.' : 'Managed provider executable was found; execution was not performed.')
    }
  } catch { check('binary', 'fail', 'Managed provider probe failed.') }
  // Informational only, so readiness never depends on what else this machine has
  // installed. autobuild's preflight is what refuses an older Codex shadowing a newer one.
  if (backend === 'codex') {
    const installs = findInstalls(bin, path, repo)
    if (installs.length) check('codex-cli', 'pass', assessInstalls(installs).message)
  }
  for (const key of controls) {
    const control = result.runtime.controls[key]
    check(`control-${key}`, control.status === 'supported' ? 'pass' : control.status === 'unsupported' ? 'fail' : 'unknown', control.evidence)
  }
  result.status = result.checks.some(c => c.status === 'fail') ? 'blocked' : result.checks.some(c => c.status === 'unknown') ? 'degraded' : 'ready'
  return result
}
