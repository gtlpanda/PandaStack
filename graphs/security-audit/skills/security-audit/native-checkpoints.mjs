// Bridge one actual journal owner to native leaf checkpoints. The graph retains
// scheduling authority; this queue serializes only short persistence boundaries.
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { assertAuditJournalOwner, readAuditJournal } from './dispatch-journal.mjs'
import { publishPartialReport, readPartialReport } from './audit-report.mjs'
import { readJson, recordSpend } from './audit-run.mjs'
import { NATIVE_CAPTURE_FILE } from './audit-stage.mjs'
import { fields, exact, json, error, fail } from '../../../../core/skills/native-runtime/boundary.mjs'

export function createAuditCheckpoints(options) {
  const input = fields(options, 'INVALID_JOURNAL_INPUT')
  exact(input, ['runDir', 'journal'], 'INVALID_JOURNAL_INPUT')
  return buildCheckpoints(input.runDir, input.journal, undefined)
}

const STAGE_NAME = /^([0-9]{2,})-([a-z0-9-]+)$/
const HEX64 = /^[0-9a-f]{64}$/
const isRecord = v => typeof v === 'object' && v !== null && !Array.isArray(v)

// The opt-in stage bridge: the same serialized publication boundary, plus a projection of this invocation's actual journal rows into the run's
// spend ledger at every publication. The stage directory and capture are fixed by runDir + stageName; nothing about them is caller supplied.
export function createAuditStageCheckpoints(options) {
  const input = fields(options, 'INVALID_JOURNAL_INPUT')
  exact(input, ['runDir', 'journal', 'stageName', 'invocationId'], 'INVALID_JOURNAL_INPUT')
  const { runDir, journal, stageName, invocationId } = input
  if (typeof stageName !== 'string' || !STAGE_NAME.test(stageName) || typeof invocationId !== 'string' || !HEX64.test(invocationId)) fail('INVALID_JOURNAL_INPUT')
  assertAuditJournalOwner(journal, runDir)
  const dir = join(runDir, 'stages', stageName), file = join(dir, NATIVE_CAPTURE_FILE)
  const dirStat = lstatSync(dir, { throwIfNoEntry: false }), fileStat = lstatSync(file, { throwIfNoEntry: false })
  if (!lstatSync(join(runDir, 'stages'), { throwIfNoEntry: false })?.isDirectory() || !dirStat?.isDirectory() || !fileStat?.isFile() || fileStat.size > 4096) fail('CAPTURE_INVALID')
  let marker
  try { marker = readJson(file) } catch { marker = undefined }
  if (!isRecord(marker) || marker.native !== true || marker.stage !== stageName || marker.invocation_id !== invocationId) fail('CAPTURE_INVALID')
  return buildCheckpoints(runDir, journal, { stageName, owns: id => id === invocationId })
}

function buildCheckpoints(runDir, journal, spend) {
  const owner = () => assertAuditJournalOwner(journal, runDir)
  owner()
  if (!journal.getControl()) fail('CONTROL_REQUIRED')
  let closed = false, tail = Promise.resolve()
  const pending = new Map()
  const live = () => { if (closed) fail('CLOSED'); owner() }
  const check = signal => { live(); if (signal?.aborted) fail('RUNTIME_ABORTED') }
  const row = id => { owner(); return readAuditJournal(runDir).rows.find(r => r.id === id) }
  const paused = () => {
    owner()
    const blockers = journal.getControl().blockers
    return blockers.length ? { state: 'paused', blockers: [...blockers].sort() } : undefined
  }
  function boundary(signal, work) {
    const result = tail.then(() => { check(signal); return work() })
    tail = result.catch(() => {})
    return result
  }
  function publish() {
    owner()
    // Project before publishing: the report is bound to run-metadata, so a later projection would leave it stale.
    if (spend) recordSpend(runDir, spend.stageName, readAuditJournal(runDir).rows.filter(r => spend.owns(r.input?.invocationId)).length)
    const output = publishPartialReport(runDir)
    if (output.status === 'failed' || readPartialReport(runDir).status !== 'current') fail('REPORT_NOT_CURRENT')
    journal.acknowledgeReport({ expectedRevision: journal.getControl().revision })
    return paused()
  }
  function stale() {
    const control = journal.getControl()
    journal.pauseControl({ expectedRevision: control.revision, reason: 'report_stale' })
    return paused()
  }
  async function rejectAndJoin(entry) {
    if (!entry.rejected) { entry.rejected = true; entry.reject(error('DISPATCH_UNCERTAIN')) }
    try { await entry.execution } catch (e) { if (e.code !== 'DISPATCH_UNCERTAIN') throw e }
  }
  function unlink(entry) {
    entry.signal?.removeEventListener('abort', entry.onAbort)
    pending.delete(entry.id)
  }
  async function reserve(binding, { signal } = {}) {
    return boundary(signal, async () => {
      // Before any journal read or mutation: a binding for another invocation never touches this stage's rows.
      if (spend) {
        binding = json(binding, 'INVOCATION_MISMATCH')
        if (!isRecord(binding) || !spend.owns(binding.invocationId)) fail('INVOCATION_MISMATCH')
      }
      let existing = row(binding.callId)
      if (existing) {
        existing = journal.prepare({ id: binding.callId, input: binding }).row
        if (['returned', 'failed'].includes(existing.state)) return { state: 'completed', completion: existing.result }
        if (existing.state !== 'prepared') return { state: 'uncertain' }
      }
      if (readPartialReport(runDir).status !== 'current') return stale()
      const blocked = paused()
      if (blocked) return blocked
      try {
        if (!existing) journal.prepare({ id: binding.callId, input: binding })
      } catch (e) {
        if (['CONTROL_PAUSED', 'BUDGET_EXHAUSTED'].includes(e.code)) {
          const result = paused()
          if (result) { publish(); return result }
        }
        throw e
      }
      check(signal)
      let resolve, reject, entered = false
      const deferred = new Promise((yes, no) => { resolve = yes; reject = no })
      // A rejected pre-entry callback is handled even if execute refuses first.
      deferred.catch(() => {})
      const entry = { id: binding.callId, signal, resolve, reject, rejected: false }
      entry.execution = journal.execute(binding.callId, () => { entered = true; return deferred })
      entry.execution.catch(() => {})
      if (!entered) {
        reject(error('DISPATCH_UNCERTAIN'))
        try { await entry.execution } catch (e) {
          if (['CONTROL_PAUSED', 'BUDGET_EXHAUSTED'].includes(e.code) && paused()) return paused()
          throw e
        }
        fail('CHECKPOINT_UNCERTAIN')
      }
      pending.set(entry.id, entry)
      entry.onAbort = () => { rejectAndJoin(entry).catch(() => {}) }
      signal?.addEventListener('abort', entry.onAbort, { once: true })
      if (signal?.aborted) entry.onAbort()
      try {
        publish()
        check(signal)
        return { state: 'dispatch' }
      } catch (e) {
        await rejectAndJoin(entry)
        unlink(entry)
        // Intent was committed, but provider admission was never authorized.
        throw e
      }
    })
  }
  async function settle(id, completion, { signal } = {}) {
    return boundary(signal, async () => {
      const entry = pending.get(id)
      if (!entry) fail('NOT_FOUND')
      entry.resolve({ outcome: 'returned', result: completion })
      try { await entry.execution } finally { unlink(entry) }
      owner()
      const committed = row(id)
      if (committed?.state !== 'returned') fail('CHECKPOINT_UNCERTAIN')
      try { return publish() } catch (e) {
        // Only report publication can become a controlled pause. Journal reads
        // and immutable owner validation must still succeed.
        owner()
        if (e.code === 'REPORT_NOT_CURRENT' && row(id)?.state === 'returned' &&
          journal.getControl().blockers.includes('report_stale')) return paused()
        throw e
      }
    })
  }
  async function uncertain(id, _reason, { signal } = {}) {
    live()
    const entry = pending.get(id)
    if (!entry) {
      const existing = row(id)
      if (existing && ['returned', 'failed', 'uncertain'].includes(existing.state)) return
      fail('NOT_FOUND')
    }
    // Join the sole owned deferred callback, including cancellation that already
    // rejected it. Never create a second attempt or rewrite terminal evidence.
    await rejectAndJoin(entry)
    unlink(entry)
    if (!signal?.aborted) await boundary(signal, () => {
      try { publish() } catch { owner(); journal.getControl() }
    })
  }
  async function close() {
    if (closed) return
    await tail
    // Cancellation may have joined the execute promise without a later port call.
    for (const entry of [...pending.values()]) {
      if (!entry.rejected) fail('BUSY')
      await rejectAndJoin(entry); unlink(entry)
    }
    closed = true
  }
  return { reserve, settle, uncertain, close }
}
