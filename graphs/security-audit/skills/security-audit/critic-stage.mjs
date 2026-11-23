// critic-stage.mjs - the plan side of the native critic stage. critic-partitions.mjs is a pure planner of full-evidence partitions; this module
// is the trusted adapter that feeds it a run (SA-05's "trusted adapter": which candidates and prior leads belong to which unit) and binds the
// stage's identities. It reads the run and returns data; it dispatches nothing, writes nothing and runs no agent.
//
// A native critic stage is the ordinary stage directory with three differences: `critic-manifest.json` holds the planned batch, `input.json` is a small
// descriptor that pins that file by sha256, and each partition and the global reconciliation are separate invocations of the workflow with their own
// invocation ids, derived from the stage's, so no two of their leaf call ids can collide.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { planCriticBatch } from './critic-partitions.mjs'
import { architectureOf, baseInput, blockText, profilePart } from './audit-inputs.mjs'
import { readJson, refuse } from './audit-run.mjs'

export const CRITIC_SECTION = 'HUNTING.md#Coverage-critic waves'
export const CRITIC_MANIFEST_FILE = 'critic-manifest.json'
const SEAM = 'const INJECTED_INPUT = null'
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const sha = text => createHash('sha256').update(text).digest('hex')
const item = (prefix, n) => `${prefix}${String(n).padStart(4, '0')}`

// The exact bytes `run-script.mjs` would write for this input: the workflow's one seam line replaced by the doubly encoded input.
// The cap is on this, never on a JSON estimate. The workflow source is trusted, installed text.
export function measureWorkflowScript(workflowSource) {
  const lines = workflowSource.split('\n')
  const at = lines.map((l, i) => (l === SEAM ? i : -1)).filter(i => i >= 0)
  if (at.length !== 1) throw new TypeError(`the workflow must hold the line "${SEAM}" exactly once`)
  // A split/join, not String.replace: an input holding `$&` or `$1` must not be read as a replacement pattern.
  return input => {
    const copy = [...lines]
    copy[at[0]] = `const INJECTED_INPUT = JSON.parse(${JSON.stringify(JSON.stringify(input))})`
    return Buffer.byteLength(copy.join('\n'))
  }
}

// The run's full records as critic-partitions items, in the host's canonical order: the ledger, then candidates, then prior leads.
// A candidate belongs to the units that carry it; a candidate no unit names, and every prior lead of a unit, follow the rules of the planner
// (an unassociated candidate is global, so every unit owns it).
function criticItems(runDir, run) {
  const units = run.ledger
  if (!Array.isArray(units) || units.length === 0 || !units.every(isObj)) refuse('coverage-ledger.json holds no units for the critic')
  const pool = readJson(join(runDir, 'candidates.json')) ?? []
  const unitIds = units.map((_, i) => item('u', i + 1))
  const byCoverage = new Map(units.map((u, i) => [u.coverage_id, unitIds[i]]))
  const items = units.map((value, i) => ({ itemId: unitIds[i], kind: 'unit', owners: [unitIds[i]], value }))
  ;(Array.isArray(pool) ? pool : []).forEach((value, i) => {
    if (!isObj(value)) refuse('candidates.json holds a candidate that is not an object')
    const owners = [...new Set((Array.isArray(value.units) ? value.units : []).map(id => byCoverage.get(id)).filter(Boolean))]
    items.push({ itemId: item('c', i + 1), kind: 'candidate', owners: owners.length ? owners : unitIds, value })
  })
  let leads = 0
  units.forEach((unit, i) => {
    for (const value of Array.isArray(unit.prior_leads) ? unit.prior_leads : []) {
      if (!isObj(value)) refuse(`unit ${unit.coverage_id} holds a prior lead that is not an object`)
      items.push({ itemId: item('p', ++leads), kind: 'prior', owners: [unitIds[i]], value })
    }
  })
  return items
}

/**
 * The planned critic batch for the run's current critic step (critic-partitions.mjs planCriticBatch), carrying every unit, candidate and prior
 * lead in full: nothing is clipped. Throws that module's STAGE_INPUT_TOO_LARGE when one unit's bundle cannot fit a script.
 */
export function planCriticManifest(runDir, run, next, workflowSource) {
  const { meta } = run
  return planCriticBatch({
    identity: { runId: meta.run_id, sourceRef: { commit: meta.source_ref.commit, tree: meta.source_ref.tree }, kind: next.kind, wave: next.wave, profile: meta.profile },
    shared: { architecture_md: architectureOf(runDir), parts: { criticSection: blockText(CRITIC_SECTION), ...profilePart(meta) },
      execution: baseInput(runDir, meta, 'critic').execution, tree: join(runDir, 'tree') },
    items: criticItems(runDir, run),
  }, { measureScript: measureWorkflowScript(workflowSource) })
}

/** The stage's input.json: small, and it pins the manifest file's bytes. `native_partitioned` is what the native stage dispatches on. */
export function criticStageInput(manifest, next, manifestText) {
  return { stage: 'critic', part: 'critic', native_partitioned: true, kind: next.kind, wave: next.wave, batch_id: manifest.batchId,
    manifest_sha256: sha(manifestText), partitions: manifest.partitions.map(p => ({ partId: p.partId, inputDigest: p.inputDigest, scriptBytes: p.scriptBytes })) }
}

/** The stage's run.js: a descriptor, not a script. The workflow runs once per partition from the manifest, never from one file. */
export function criticStageScript(manifest) {
  return `// native critic stage ${manifest.batchId}: ${manifest.partitions.length} partition run(s) and one global reconciliation of security-audit-flow.\n` +
    `// The inputs are in critic-manifest.json, pinned by input.json; nothing here runs.\n`
}

const derive = (...parts) => sha(parts.join('\n'))
/** The invocation id of one partition's workflow run. Unique per stage, partition and exact input. */
export const partitionInvocationId = (stageInvocationId, partition) => derive('critic-part', stageInvocationId, partition.partId, partition.inputDigest)
/** The invocation id of the global reconciliation run. It does not depend on the partitions' answers, so the stage owns it from the start. */
export const globalInvocationId = (stageInvocationId, manifest) => derive('critic-global', stageInvocationId, manifest.batchId)
/** Every invocation id a native critic stage may journal under: its partitions, then the reconciliation. */
export const criticInvocationIds = (stageInvocationId, manifest) =>
  [...manifest.partitions.map(p => partitionInvocationId(stageInvocationId, p)), globalInvocationId(stageInvocationId, manifest)]

/** A bounded, host-written line about one partition's answer. Model text never reaches it: only counts. */
export function partitionSummaryText(partition, critic) {
  return `${partition.partId} (${partition.itemIds.length} item(s)): ${critic.missing_units.length} missing unit(s), ` +
    `${critic.reassign_ids.length} to reassign, ${critic.resolved_prior_leads.length} prior lead(s) resolved, stop ${critic.stop}`
}
