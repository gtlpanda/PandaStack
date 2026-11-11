// Execute ONE scheduler-selected stage through trusted host ports. This library
// is not a provider launcher or a second audit lifecycle. Critic partition dispatch
// remains a separate required integration; legacy clipped critics are refused.
import { join } from 'node:path'
import { planNativeStage, applyStage, completedStageRejection, NATIVE_CAPTURE_FILE, pendingNativeApplication, recordNativeApplication } from './audit-stage.mjs'
import { loadRun, nextStep, readJson, writeJson } from './audit-run.mjs'
import { assertAuditJournalOwner } from './dispatch-journal.mjs'
import { createAuditStageCheckpoints } from './native-checkpoints.mjs'
import { publishPartialReport, readPartialReport } from './audit-report.mjs'
import { inspectSnapshotProtection } from './snapshot-protection.mjs'
import { createNativeRuntime } from '../../../../core/skills/native-runtime/runtime.mjs'
import { registryWorkflow } from '../../../../core/skills/native-runtime/registry.mjs'
import { fields, exact, json, fail } from '../../../../core/skills/native-runtime/boundary.mjs'

export async function runNativeAuditStage(options) {
  const input = fields(options, 'INVALID_RUNTIME_INPUT')
  const keys = ['runDir', 'journal', 'registry', 'provider', 'resolveLeaf', 'maxConcurrentSubagents', 'deadlineMs']
  exact(input, Object.hasOwn(input, 'signal') ? [...keys, 'signal'] : keys, 'INVALID_RUNTIME_INPUT')
  const { runDir, journal, registry, provider, resolveLeaf, maxConcurrentSubagents, deadlineMs, signal } = input
  assertAuditJournalOwner(journal, runDir)
  if (!journal.getControl()) fail('CONTROL_REQUIRED')
  if (typeof resolveLeaf !== 'function') fail('INVALID_SELECTION')
  if (!inspectSnapshotProtection(join(runDir, 'tree')).ok) fail('SNAPSHOT_UNPROTECTED')
  const publish = () => {
    assertAuditJournalOwner(journal, runDir)
    if (publishPartialReport(runDir).status === 'failed' || readPartialReport(runDir).status !== 'current') fail('REPORT_NOT_CURRENT')
    // Terminal reports remain publishable; terminal grants remain forbidden.
    if (loadRun(runDir).meta.run_status === 'in_progress') journal.acknowledgeReport({ expectedRevision: journal.getControl().revision })
  }
  // Repair completed application reports even when nextStep now names a helper
  // (seed/report), which intentionally cannot be planned as a native leaf stage.
  publish()
  const recovery = pendingNativeApplication(runDir)
  const plan = recovery ?? planNativeStageAfterCriticCheck(runDir)
  const marker = readJson(join(plan.stage.dir, NATIVE_CAPTURE_FILE))
  if (registryWorkflow(registry, 'security-audit-flow').sha256 !== marker.workflow_sha256) fail('CONFLICT')
  const apply = () => {
    let applied
    try {
      applied = applyStage(runDir, plan.returned)
    } catch (e) {
      // Only a rejection the owning applier completed (and branded) allows the
      // next bounded attempt. Any other error, Refusal or not, leaves the saved
      // result pending, so the same result is applied again with no new call.
      if (completedStageRejection(e) === null) throw e
      try { recordNativeApplication(plan, 'rejected') }
      catch { throw nativeError('APPLICATION_RECEIPT_UNCONFIRMED', e) }
      throw e
    }
    recordNativeApplication(plan, 'applied')
    return applied
  }
  if (recovery) {
    const result = readJson(plan.returned)
    // A prior apply may have already saved the next step before interruption.
    const applied = nextStep(loadRun(runDir)).step === plan.step ? apply() : null
    if (applied === null) recordNativeApplication(plan, 'applied')
    publish()
    return { stageName: plan.stage.name, invocationId: plan.invocationId, result, applied, recoveredApplication: true }
  }
  // The host may repair report freshness, never budget/uncertainty blockers.
  publish()
  const checkpoints = createAuditStageCheckpoints({ runDir, journal, stageName: plan.stage.name, invocationId: plan.invocationId })
  let runtime, value, failure
  try {
    runtime = createNativeRuntime({ registry, provider, checkpoints,
      resolveLeaf: context => {
        const chosen = json(resolveLeaf(context), 'INVALID_SELECTION')
        if (chosen?.selection?.provider !== 'codex') fail('INVALID_SELECTION')
        return chosen
      }, maxConcurrentSubagents, deadlineMs, ...(signal === undefined ? {} : { signal }) })
    const result = await runtime.run('security-audit-flow', readJson(join(plan.stage.dir, 'input.json')), { invocationId: plan.invocationId })
    writeJson(plan.returned, result)
    const applied = apply()
    publish()
    value = { stageName: plan.stage.name, invocationId: plan.invocationId, result, applied }
  } catch (e) { failure = e }
  finally {
    // Unconfirmed cleanup stays fatal and takes precedence; the primary error is kept as its cause.
    const primary = failure
    try { if (runtime) await runtime.close() } catch { failure = nativeError('CLEANUP_UNCONFIRMED', primary) }
    try { await checkpoints.close() } catch { failure = nativeError('CLEANUP_UNCONFIRMED', primary) }
  }
  if (failure) throw failure
  return value
}

// boundary.mjs's error(code), with the original error object retained as `cause` when there is one.
function nativeError(code, cause) {
  const e = cause === undefined ? new Error(`Native runtime: ${code}.`) : new Error(`Native runtime: ${code}.`, { cause })
  return Object.assign(e, { code })
}

function planNativeStageAfterCriticCheck(runDir) {
  if (nextStep(loadRun(runDir)).step === 'critic') fail('PARTITION_INTEGRATION_REQUIRED')
  return planNativeStage(runDir)
}
