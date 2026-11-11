// Trusted transport observations only; no queue mutations or permission grants.
import { randomUUID } from 'node:crypto'
import { currentRunId } from '../../../../core/skills/run-records/tracking.mjs'

export function observeContextLaunch(child, { onContextSupplied, onContextUncertain }, { stdin = false } = {}) {
  if (!onContextSupplied) return () => {}
  // Capture while inside the nested tracking scope, never in the outer gate.
  const receipt = { providerRunId: currentRunId(), launchId: randomUUID() }
  let spawned = false, failedSpawn = false, ended = false, supplied = false
  let written = !stdin, writeFailed = false, uncertain = false
  function markUncertain() {
    if (uncertain) return
    uncertain = true
    try { onContextUncertain?.() } catch { /* Observational only. */ }
  }
  function supply() {
    if (ended || failedSpawn || supplied || !spawned || !written || writeFailed) return
    supplied = true
    try { onContextSupplied({ ...receipt }) } catch { markUncertain() }
  }
  child.once('spawn', () => {
    spawned = true
    if (writeFailed) markUncertain()
    supply()
  })
  child.once('error', () => {
    if (!spawned) failedSpawn = true
    else markUncertain()
  })
  child.once('close', () => {
    ended = true
    if (!failedSpawn && !supplied) markUncertain()
  })
  function writeComplete(error) {
    if (ended) return
    if (error) {
      writeFailed = true
      if (spawned) markUncertain()
    } else written = true
    supply()
  }
  if (stdin) child.stdin.on('error', writeComplete)
  return writeComplete
}
