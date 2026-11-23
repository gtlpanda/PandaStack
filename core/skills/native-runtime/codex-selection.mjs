// Codex leaf selection (spec/contracts/codex-parity-cp-02c.md): the `resolveLeaf`
// a native host hands to createNativeRuntime for Codex. It maps a graph role to a
// runtime profile and the requested model and effort to Codex values, and refuses
// every leaf Codex must not run in wave 1. Pure: no file, no process, no state.
import { types } from 'node:util'
import { codexModel } from '../../../graphs/autobuild/tool/lib/config.mjs'
import { DOCTOR_EFFORTS } from '../run-records/doctor.mjs'
import { codexExecArgs } from './codex-exec.mjs'
import { CODEX_PROVIDER, sandboxForProfile } from './codex-provider.mjs'
import { exact, fail, fields, nonempty } from './boundary.mjs'

const CODE = 'INVALID_SELECTION'
const CONTEXT_KEYS = ['workflowId', 'workflowPath', 'agentType', 'label', 'phase', 'requestedModel', 'requestedEffort']
const check = ok => { if (!ok) fail(CODE) }

// Static data, checked against the role files and catalog workflow rows by the
// CP-02c acceptance test. Rules, first match wins: runner is not a model leaf;
// Edit or Write is build-workspace; checker runs verify, which writes; then the
// security-audit and release graph roles; every other role (Bash alone included)
// is source-review.
const GROUPS = {
  'build-workspace': ['checker', 'fix-verifier', 'fixer', 'implementer', 'repairer', 'reproducer', 'scribe'],
  'source-review': ['acceptance-auditor', 'advisor', 'architect', 'extractor', 'hunter', 'impact-mapper', 'planner',
    'qa-auditor', 'questioner', 'reviewer', 'scout', 'skeptic', 'slicer'],
  'audit-source-only': ['audit-analyst', 'audit-researcher', 'audit-synthesizer'],
  'release-controlled': ['deploy-watcher', 'merger', 'release-checker'],
}
const byName = ([a], [b]) => a < b ? -1 : a > b ? 1 : 0

/** Role name to runtime profile, or null for a role that is not a model leaf. Keys sorted. */
export const ROLE_PROFILES = Object.freeze(Object.fromEntries([
  ...Object.entries(GROUPS).flatMap(([profile, roles]) => roles.map(role => [role, profile])),
  ['runner', null],
].sort(byName)))

/** No leaf of these workflows runs on Codex, whatever its role. release-flow left this list at CP-08. */
export const CODEX_REFUSED_WORKFLOWS = Object.freeze(['security-audit-flow'])

/**
 * The Codex `{selection, profile}` for one leaf context, or a throw of
 * INVALID_SELECTION with a fixed message that never echoes the context.
 */
export function resolveLeaf(context) {
  // Every failure below, including codexModel's own message (which names the
  // model), is replaced by the one fixed refusal.
  try { return select(context) }
  catch { fail(CODE) }
}

// A detached copy read through own data descriptors: a hole, getter, proxy or own
// method override on the caller's array never runs or slips past a check.
function stringList(value) {
  check(Array.isArray(value) && !types.isProxy(value) && value.length > 0)
  const list = []
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, i)
    check(d !== undefined && Object.hasOwn(d, 'value') && nonempty(d.value))
    list.push(d.value)
  }
  return list
}

function select(context) {
  const c = fields(context, CODE)
  exact(c, CONTEXT_KEYS, CODE)
  check(['workflowId', 'agentType', 'label', 'phase', 'requestedModel', 'requestedEffort'].every(key => nonempty(c[key])))
  const workflowPath = stringList(c.workflowPath)
  check(workflowPath.at(-1) === c.workflowId)

  check(!workflowPath.some(id => CODEX_REFUSED_WORKFLOWS.includes(id)))

  check(Object.hasOwn(ROLE_PROFILES, c.agentType))
  const profile = ROLE_PROFILES[c.agentType]
  check(profile !== null)
  // The network-capable release profile exists for release-flow's own leaves only.
  check(profile !== 'release-controlled' || (c.workflowId === 'release-flow' && workflowPath.length === 1))
  const sandbox = sandboxForProfile(profile)
  check(sandbox !== null)

  const effort = c.requestedEffort
  check(DOCTOR_EFFORTS.includes(effort))
  const model = codexModel(c.requestedModel)
  // The launcher's own argument checks, run before any reserve rather than at dispatch.
  codexExecArgs({ sandbox, model, reasoningEffort: effort })

  return { selection: { provider: CODEX_PROVIDER, model, effort }, profile }
}
