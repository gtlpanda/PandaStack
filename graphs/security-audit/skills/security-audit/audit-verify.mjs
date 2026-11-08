// audit-verify.mjs - the verify stage (Phase 5) of a security-audit run, planned and applied: one fresh verifier per final confirmed or needs_validation record, and a new
// independent one for a material replacement. Upstream (vendor/cloudflare-security-audit/skills/security-audit/VALIDATION-AND-REPORTING.md, Phase 5) is the authority:
// "Launch one fresh research verifier per final confirmed and needs_validation record ... Each verifier returns exactly one JSON object: {"decision":"verified",
// "fingerprint":"..."} or {"decision":"replace","reason":"...","record":{...}} ... Do not apply a Phase 5 replacement as final when it promotes a record to a stronger verdict
// ... or materially changes the root cause, trace, execution input or observed result, demonstrated impact, or severity. Give that complete replacement to a new independent
// verifier ... If budget or independence is unavailable, remove the disputed record from findings.json, keep its ledger unit as an unresolved candidate, and set run_status:
// incomplete with an exact incomplete_reason."
//
// Like validate it runs in rounds, since a round is one Workflow run and the replacement of a record needs a verifier of its own: round after round the pending items are
// (a) a record no Phase 5 verifier has settled, (b) a material replacement waiting for its independent verifier. decisions.json (audit-findings.mjs) holds where each stands;
// the step is saved when none is pending. Every change to the final records goes through commitFindings: both vendored validators and the link-check.
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { REASONS, advanceState, appendEvent, markIncomplete, recordSpend, refuse, writeJson } from './audit-run.mjs'
import { architectureOf, baseInput, blockText } from './audit-inputs.mjs'
import { FINDINGS_FAILED } from './audit-run.mjs'
import { HISTORY_FILE, MAX_REPLACEMENT_ROUNDS, MAX_TRIES, RECORD_UNRESOLVED, agentId, commitFindings, decisionsOf, finalRecords, finishRun, historyOf, materialChanges, needsPhase5, recordAgent, recordProblems, retained, saveDecisions, transitionProblem } from './audit-findings.mjs'
import { parts } from './blocks.mjs'
import { bounded, syncLedger } from './audit-verdicts.mjs'

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const show = v => String(JSON.stringify(v)).slice(0, 80)

const PHASE5 = 'VALIDATION-AND-REPORTING.md#Phase 5: Verify the final records with fresh eyes'
const LOCAL_BOUNDARIES = 'HUNTING.md#Local validation boundaries'
// A verify input is small (a record and the shared text); still a round holds at most this many items, so no run script grows with the number of records.
export const MAX_VERIFY_ITEMS = 40
const FRESH = () => ({ state: 'pending', verifier_id: null, attempts: [], replacement: null, rounds: 0, reason: null, last_stage: null })

// Where an entry stands in Phase 5: which verifier is next and for what. `slot` is phase5 (the decided record has no verifier yet) or replacement (a material replacement
// waits for its independent verifier, round `replacement.round`). Tries are counted per slot, so a replacement's verifier gets its own first try.
const slotOf = e => (e.phase5.replacement ? 'replacement' : 'phase5')
const triesIn = e => e.phase5.attempts.filter(a => a.slot === slotOf(e) && (slotOf(e) === 'phase5' || a.round === e.phase5.replacement.round)).length
const idOf = e => (slotOf(e) === 'phase5' ? agentId('r', e.n, { attempt: triesIn(e) + 1 }) : agentId('x', e.n, { round: e.phase5.replacement.round, attempt: triesIn(e) + 1 }))
const subjectOf = e => (slotOf(e) === 'phase5' ? e.record : e.phase5.replacement.record)

export function verifyInput(runDir, run) {
  let decisions = decisionsOf(runDir)
  if (!decisions) refuse('decisions.json is missing: write-findings ran without validation')
  if (!isDeepStrictEqual(finalRecords(decisions), run.findings)) refuse('findings.json is not the decided records: it is written by write-findings and by verify only, never by hand')
  decisions = { ...decisions, entries: decisions.entries.map(e => (retained(e) && needsPhase5(e.record) && e.phase5 === null ? { ...e, phase5: FRESH() } : e)) }
  const pending = decisions.entries.filter(e => retained(e) && needsPhase5(e.record) && e.phase5.state === 'pending')
  const left = run.meta.budget === null ? Infinity : Math.max(0, run.meta.budget - run.meta.agents_spent)
  // Strict budget: a record whose verifier it cannot fund is removed, as upstream says of a record that cannot be independently verified, and the run is incomplete.
  const unfunded = pending.slice(left)
  if (unfunded.length) {
    const ids = new Set(unfunded.map(e => e.fingerprint))
    decisions = { ...decisions, entries: decisions.entries.map(e => (ids.has(e.fingerprint) ? { ...e, phase5: { ...e.phase5, state: 'removed', reason: REASONS.validation } } : e)) }
    markIncomplete(runDir, REASONS.validation)
  }
  saveDecisions(runDir, decisions)
  const funded = pending.slice(0, left).slice(0, MAX_VERIFY_ITEMS)
  if (unfunded.length || !funded.length) {
    const changed = unfunded.length > 0
    if (changed) commitRemoval(runDir, run, decisions, 'plan')
    if (!funded.length) {
      closeVerify(runDir)
      appendEvent(runDir, { cmd: 'plan', stage: 'verify', result: 'refused', reason: changed ? REASONS.validation : 'nothing is pending', counts: { removed: unfunded.length } })
      refuse(changed ? `${REASONS.validation}: ${left} agent(s) are left of the budget (--budget ${run.meta.budget}, ${run.meta.agents_spent} spent) and ${unfunded.length} record(s) need a verifier; none was launched, they are removed from findings.json, stay unresolved candidates in the ledger, and the run is marked incomplete`
        : 'every record is already verified or removed; the step is closed. `audit-run.mjs next` says what is next')
    }
  }
  const p = parts()
  let history = historyOf(runDir)
  const items = funded.map(e => {
    const slot = slotOf(e)
    const id = idOf(e)
    history = recordAgent(history, e.fingerprint, slot === 'phase5' ? 'verifier' : 'replacer', id)
    // A replacement's verifier is given the replacement and nothing else: not the reason its proposer gave, not the record it replaces, not the Phase 3 decision.
    const record = subjectOf(e)
    return { agent_id: id, fingerprint: e.fingerprint, kind: slot, verdict: record.verdict, record: bounded(record) }
  })
  writeJson(join(runDir, HISTORY_FILE), history)
  return {
    ...baseInput(runDir, run.meta, 'verify'), round: decisions.rounds.verify + 1, architecture_md: architectureOf(runDir), items,
    parts: { phase5: blockText(PHASE5), localBoundaries: blockText(LOCAL_BOUNDARIES), recordContract: p.recordContract.text, schema_confirmed: p.schema_confirmed.text, schema_needs_validation: p.schema_needs_validation.text, schema_rejected: p.schema_rejected.text },
  }
}

// What a Phase 5 verifier returned for the record it was given, judged: { verified: true }, { replace: record, material: [fields], reason }, or { kind, problems } to discard.
export function judgeVerifier(runDir, entry, result, cache) {
  const discard = (kind, ...problems) => ({ kind, problems: problems.flat().slice(0, 5).map(x => String(x).slice(0, 300)) })
  if (result === null || result === undefined) return discard('no_result', 'the verifier returned no result')
  if (!isObj(result)) return discard('malformed', 'the result is not an object')
  const keys = Object.keys(result).sort().join()
  const subject = subjectOf(entry)
  if (result.decision === 'verified') {
    if (keys !== 'decision,fingerprint') return discard('malformed', 'a verified result is exactly {decision, fingerprint}')
    return result.fingerprint === entry.fingerprint ? { verified: true } : discard('malformed', `verified names fingerprint ${show(result.fingerprint)}, not ${show(entry.fingerprint)}`)
  }
  if (result.decision !== 'replace') return discard('malformed', `decision is ${show(result.decision)}, not verified or replace`)
  if (keys !== 'decision,reason,record') return discard('malformed', 'a replace result is exactly {decision, reason, record}')
  if (!isText(result.reason)) return discard('malformed', 'a replace result needs a reason')
  if (isObj(result.record) && result.record.verdict === 'confirmed') return discard('confirmed', transitionProblem(subject.verdict, 'confirmed'))   // no path reaches confirmed in v1
  const bad = recordProblems(runDir, result.record, { cache })
  if (bad.length) return discard('malformed', bad)
  const moved = transitionProblem(subject.verdict, result.record.verdict)
  if (moved) return discard('malformed', moved)
  if (result.record.fingerprint !== entry.fingerprint) return discard('other_fingerprint', `the replacement has fingerprint ${show(result.record.fingerprint)}, not ${show(entry.fingerprint)}: a separate root cause is not applied here`)
  return { replace: JSON.parse(JSON.stringify(result.record)), material: materialChanges(subject, result.record), reason: result.reason.trim().slice(0, 400) }
}

// A record that is removed is no longer in findings.json, and its unit stays an unresolved candidate: the ledger says so, then findings.json is rewritten without it.
function commitRemoval(runDir, run, decisions, stage) {
  syncLedger(runDir, run, decisions, stage)
  commitFindings(runDir, finalRecords(decisions))
}
// The step is saved, and the run reaches a terminal state: complete only if complete-check passes, otherwise incomplete (an incomplete run stays so).
function closeVerify(runDir) {
  advanceState(runDir, 'verify')
  return finishRun(runDir)
}

export function applyVerify({ runDir, run, stage, input, result, event, notes }) {
  const got = result.results.verifiers
  const ids = input.items.map(i => i.agent_id)
  if (!isObj(got) || Object.keys(got).length !== ids.length || !ids.every(id => Object.hasOwn(got, id) && (got[id] === null || isObj(got[id])))) refuse(`results.verifiers must have exactly one entry per planned verifier (${ids.join(', ')}), each a result object or null; nothing was changed`)
  const decisions = decisionsOf(runDir)
  if (!decisions) refuse('decisions.json is missing: plan the stage again')
  const fresh = input.items.every(i => { const e = decisions.entries.find(x => x.fingerprint === i.fingerprint); return e?.phase5 && e.phase5.attempts.length === 0 && e.phase5.state === 'pending' && !e.phase5.replacement })
  if (fresh && ids.every(id => got[id] === null)) {   // the environment, not any record: no try is used (as in validate)
    recordSpend(runDir, stage.name, result.budgetSpent)
    writeJson(join(stage.dir, 'result.json'), result)
    event('escalated', {}, 'every verifier returned nothing')
    refuse(`every verifier of the round returned nothing (${result.reason}); no try was used (${result.budgetSpent} agent(s) spent): plan the stage again to retry it`)
  }
  let history = historyOf(runDir)
  const cache = new Map()
  const tally = { verified: 0, replaced: 0, queued: 0, retried: 0, removed: 0 }
  const entries = decisions.entries.map(e => {
    const item = input.items.find(i => i.fingerprint === e.fingerprint)
    if (!item) return e
    if (e.phase5?.last_stage === stage.name) return e   // applied before, the step not saved (a crash): not judged twice
    if (!e.phase5 || e.phase5.state !== 'pending') refuse(`${e.fingerprint} is not waiting for a verifier: plan the stage again`)
    if (item.agent_id !== idOf(e)) refuse(`${item.agent_id} is not the verifier planned for ${e.fingerprint} (that is ${idOf(e)}): plan the stage again`)
    history = recordAgent(history, e.fingerprint, slotOf(e) === 'phase5' ? 'verifier' : 'replacer', item.agent_id)
    const slot = slotOf(e)
    const round = slot === 'replacement' ? e.phase5.replacement.round : undefined
    const judged = judgeVerifier(runDir, e, got[item.agent_id], cache)
    const base = { ...e.phase5, last_stage: stage.name }
    const settle = (record, p5) => ({ ...e, record, phase5: { ...base, ...p5, replacement: null } })
    if (judged.verified) { tally.verified += 1; return settle(slot === 'phase5' ? e.record : e.phase5.replacement.record, { state: 'verified', verifier_id: item.agent_id }) }
    if (judged.replace) {
      if (judged.material.length === 0) { tally.replaced += 1; return settle(judged.replace, { state: 'verified', verifier_id: item.agent_id }) }   // wording or a line: applied directly
      const next = slot === 'phase5' ? 1 : round + 1
      if (next > MAX_REPLACEMENT_ROUNDS) { tally.removed += 1; return { ...e, phase5: { ...base, state: 'removed', reason: RECORD_UNRESOLVED, replacement: null, note: `a material replacement was proposed again after ${MAX_REPLACEMENT_ROUNDS} independent verification(s): ${judged.material.join(', ')}` } } }
      tally.queued += 1
      return { ...e, phase5: { ...base, replacement: { record: judged.replace, round: next, proposer_id: item.agent_id, changes: judged.material } } }
    }
    const attempts = [...e.phase5.attempts, { id: item.agent_id, stage: stage.name, slot, ...(round && { round }), kind: judged.kind, problems: judged.problems }]
    const tries = attempts.filter(a => a.slot === slot && (slot === 'phase5' || a.round === round)).length
    if (tries < MAX_TRIES) { tally.retried += 1; return { ...e, phase5: { ...base, attempts } } }
    tally.removed += 1
    return { ...e, phase5: { ...base, attempts, state: 'removed', reason: RECORD_UNRESOLVED } }
  })
  const out = { ...decisions, rounds: { ...decisions.rounds, verify: Math.max(decisions.rounds.verify, input.round) }, entries }
  saveDecisions(runDir, out)
  writeJson(join(runDir, HISTORY_FILE), history)
  const removed = entries.filter(e => e.phase5?.state === 'removed' && input.items.some(i => i.fingerprint === e.fingerprint))
  for (const e of removed) markIncomplete(runDir, e.phase5.reason)
  // A replacement applied or a record removed changes the final records: the ledger says which candidate is unresolved, findings.json is rewritten through both validators.
  // Compared with the file on disk, not with the decisions as they were: an apply that is run again after a crash finds its decisions already saved and findings.json not.
  if (!isDeepStrictEqual(finalRecords(out), run.findings)) {
    try { commitRemoval(runDir, run, out, 'verify') } catch (err) {
      if (!err.problems) throw err
      markIncomplete(runDir, FINDINGS_FAILED)
      appendEvent(runDir, { cmd: 'apply', stage: 'verify', result: 'failed', reason: FINDINGS_FAILED, problems: err.problems.slice(0, 5) })
      notes.push(`findings.json could not be rewritten (${err.message}); it is left as it was and the run is marked incomplete (${FINDINGS_FAILED})`)
    }
  } else if (removed.length) syncLedger(runDir, run, out, 'verify')
  recordSpend(runDir, stage.name, result.budgetSpent)
  writeJson(join(stage.dir, 'result.json'), result)
  const pending = entries.filter(e => retained(e) && needsPhase5(e.record) && e.phase5?.state === 'pending').length
  let finished = null
  if (pending === 0) finished = closeVerify(runDir)
  for (const e of entries) for (const a of e.phase5?.attempts.filter(x => x.stage === stage.name) ?? []) notes.push(`discarded, never repaired: ${a.id}: ${a.problems[0]}`)
  for (const e of entries.filter(x => x.phase5?.replacement && x.phase5.last_stage === stage.name)) notes.push(`${e.fingerprint}: a material replacement (${e.phase5.replacement.changes.join(', ')}) goes to a new independent verifier, round ${e.phase5.replacement.round}`)
  if (finished) notes.push(finished.message)
  event('ok', { counts: { items: ids.length, ...tally, pending } })
  return { summary: `verify round=${input.round} items=${ids.length} verified=${tally.verified} replaced=${tally.replaced} queued=${tally.queued} retried=${tally.retried} removed=${tally.removed} pending=${pending} agents=${result.budgetSpent}`, notes, then: pending ? `node audit-stage.mjs plan ${runDir}` : `node audit-run.mjs next ${runDir}` }
}
