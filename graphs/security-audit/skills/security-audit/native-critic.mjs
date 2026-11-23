// native-critic.mjs - dispatch of one native critic stage. The stage's manifest (critic-stage.mjs, critic-partitions.mjs) holds every unit, candidate and
// prior lead in full, cut into partitions that each fit one workflow script. Here each partition is one run of the trusted security-audit-flow
// under its own invocation id, and the global reconciliation is one more, only after every partition returned a valid critic. The pure planner owns the
// barrier and the union; this module owns neither a scheduler nor a ledger: the aggregate critic it returns is handed to the unchanged applyStage.
//
// Durability is the journal's. Every leaf reserves before it is dispatched and settles when it returns (native-checkpoints.mjs), so running this
// again after an interruption replays the completed leaves with no new call and no new logical id; the manifest never changes.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { acceptCriticReconciliation, planCriticReconciliation } from './critic-partitions.mjs'
import { CRITIC_MANIFEST_FILE, globalInvocationId, measureWorkflowScript, partitionInvocationId, partitionSummaryText } from './critic-stage.mjs'
import { readJson } from './audit-run.mjs'
import { fail } from '../../../../core/skills/native-runtime/boundary.mjs'

const WORKFLOW = 'security-audit-flow'

/** The manifest the stage's input.json pins. A file that changed since planning is refused. */
export function readCriticManifest(stageDir, input) {
  const text = readFileSync(join(stageDir, CRITIC_MANIFEST_FILE), 'utf8')
  if (createHash('sha256').update(text).digest('hex') !== input.manifest_sha256) fail('CAPTURE_INVALID')
  const manifest = readJson(join(stageDir, CRITIC_MANIFEST_FILE))
  if (manifest?.batchId !== input.batch_id) fail('CAPTURE_INVALID')
  return manifest
}

// A workflow result a partition or the reconciliation may be built from: a done critic of this stage's kind.
function criticOf(result, kind) {
  const ok = result && result.status === 'done' && result.results?.part === 'critic' && result.results.kind === kind
  return ok ? result.results.critic : null
}

/**
 * Runs the stage: every partition in manifest order, then the reconciliation. Returns what the workflow would have returned for one critic
 * (`{status, reason, stage, history, results}`), without `budgetSpent`, which the caller takes from the journal. An escalation of any leaf is
 * returned as an escalation and no later leaf runs. A paused, uncertain or aborted run throws, exactly as the runtime does, and leaves the stage
 * pending for a resume. `runtime` is a createNativeRuntime object; each run is one `runtime.run`.
 */
export async function runCriticPartitions({ runtime, stageDir, input, stageInvocationId, workflowSource }) {
  const manifest = readCriticManifest(stageDir, input)
  const options = { measureScript: measureWorkflowScript(workflowSource) }
  // Validates the manifest from its raw values (every digest, every bundle) before a single leaf is reserved.
  planCriticReconciliation({ manifest, results: [] }, options)
  const kind = input.kind, id = kind === 'post-wave' ? `c${input.wave}` : `cf${input.wave}`
  const history = []
  const rows = []
  const escalate = reason => ({ status: 'escalate', reason, stage: 'critic', history })

  for (const partition of manifest.partitions) {
    const result = await runtime.run(WORKFLOW, partition.input, { invocationId: partitionInvocationId(stageInvocationId, partition) })
    const critic = criticOf(result, kind)
    history.push({ node: 'critic-partition', partId: partition.partId, status: result?.status ?? null })
    if (critic === null) return escalate(`critic partition ${partition.partId} did not return a ${kind} critic: ${String(result?.reason ?? 'no result').slice(0, 300)}`)
    rows.push({ batchId: manifest.batchId, partId: partition.partId, inputDigest: partition.inputDigest, critic,
      summary: { text: partitionSummaryText(partition, critic), itemIds: partition.itemIds } })
  }

  // The manifest was validated above, so a rejection here is what a model returned (an ID that is not in the ledger): a completed, rejectable answer.
  let reconciliation
  try { reconciliation = planCriticReconciliation({ manifest, results: rows }, options) } catch (e) {
    if (e?.code === 'INVALID_PARTITION_RESULT') return escalate('a critic partition answered with IDs outside the ledger or its prior leads')
    throw e
  }
  if (!reconciliation.complete) fail('CAPTURE_INVALID')
  const global = await runtime.run(WORKFLOW, reconciliation.plan.input, { invocationId: globalInvocationId(stageInvocationId, manifest) })
  const globalCritic = criticOf(global, kind)
  history.push({ node: 'critic-reconciliation', status: global?.status ?? null })
  if (globalCritic === null) return escalate(`critic reconciliation did not return a ${kind} critic: ${String(global?.reason ?? 'no result').slice(0, 300)}`)

  let accepted
  try {
    accepted = acceptCriticReconciliation({ manifest, results: rows, plan: reconciliation.plan,
      result: { batchId: manifest.batchId, inputDigest: reconciliation.plan.inputDigest, critic: globalCritic } })
  } catch (e) {
    if (e?.code === 'INVALID_PARTITION_RESULT') return escalate('the critic reconciliation answered with IDs outside the ledger or its prior leads')
    throw e
  }
  if (!accepted.complete) fail('CAPTURE_INVALID')
  return { status: 'done', reason: `${kind} critic ${id}: ${manifest.partitions.length} partition(s) and one reconciliation; ` +
    `${accepted.critic.missing_units.length} missing unit(s), ${accepted.critic.reassign_ids.length} to reassign, stop ${accepted.critic.stop}`,
  stage: 'critic', history, results: { part: 'critic', kind, id, critic: accepted.critic } }
}
