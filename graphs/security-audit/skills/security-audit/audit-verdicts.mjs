// audit-verdicts.mjs - the three Workflow stages between hunting and the report, planned and applied: consolidate (one synthesizer groups the candidates
// of one root cause), validate (Phase 3: one fresh verifier per candidate) and verify (Phase 5: one fresh verifier per final record, and a new one for
// a material replacement). audit-stage.mjs calls the planners and appliers from its tables; the rules they apply (IDs, independence, transitions,
// materiality, what a record must be) and the one writer of findings.json are in audit-findings.mjs. Upstream's text
// (vendor/cloudflare-security-audit/skills/security-audit/VALIDATION-AND-REPORTING.md, HUNTING.md) is the authority.
//
// The workflow has no filesystem and cannot run upstream's validators, so it returns what the agents said and nothing here trusts it: every
// result is judged by the parent (the vendored schema validator, the snapshot, the transition table) in `apply`, and a result that fails is
// discarded without repair (VALIDATION-AND-REPORTING.md: "Discard a malformed or prose-wrapped verifier result without repairing it").
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { CARRIED, LEDGER_FAILED, REASONS, advanceState, appendEvent, markIncomplete, readJson, recordSpend, refuse, writeJson } from './audit-run.mjs'
import { commitLedger, loadPriors } from './audit-ledger.mjs'
import { CLIP, architectureOf, baseInput, blockText, clipText, clipValue, encodedSize } from './audit-inputs.mjs'
import { CANDIDATES_FILE, CONFIRMED_WITHOUT_EVIDENCE, HISTORY_FILE, MAX_TRIES, VERDICTS, agentId, decisionsOf, ensureDecisions, entryOf, historyOf, readPool, recordAgent, recordProblems, saveDecisions, transitionProblem } from './audit-findings.mjs'
import { companions, parts } from './blocks.mjs'

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const show = v => String(JSON.stringify(v)).slice(0, 80)
const text = v => (typeof v === 'string' ? clipText(v) : null)
const sortedUnique = list => [...new Set(list)].sort()

export const CONSOLIDATION_FILE = 'consolidation.json'

// ---------- consolidate ----------
const CONSOLIDATION = 'HUNTING.md#Parent consolidation and ledger update'
// The most a consolidate input may be once run-script.mjs has written it into the script (the ceiling is 524,288 bytes and the script itself is about 70 KB).
export const MAX_CONSOLIDATE_BYTES = 300_000

// Consolidation is optional work: with fewer than two candidates there is nothing to group, with the budget at its last agent it would take the one a verifier
// needs, and with an input that cannot fit one script it cannot run. Each of these closes the step with no merge and says why (the same thing an invalid
// grouping does: the candidates are validated as they stand).
export function skipConsolidation(runDir, why) {
  writeJson(join(runDir, CONSOLIDATION_FILE), { version: 1, stage: null, applied: false, problems: [why], groups: [] })
  advanceState(runDir, 'consolidate')
  appendEvent(runDir, { cmd: 'plan', stage: 'consolidate', result: 'skipped', reason: why })
  refuse(`consolidation skipped: ${why}; no agent was launched and nothing was merged. The candidates are validated as they stand: \`audit-run.mjs next\` says validate`)
}

export function consolidateInput(runDir, run) {
  const pool = readPool(runDir)
  const candidates = pool.map(c => ({
    fingerprint: c.fingerprint, proposed_verdict: c.proposed_verdict, title: text(c.record.title), root_cause: text(c.record.claimed_root_cause ?? c.record.root_cause),
    trace: (Array.isArray(c.record.trace) ? c.record.trace : []).slice(0, CLIP.list).map(t => (isObj(t) ? { file: text(t.file), kind: text(t.kind), scope: text(t.scope) } : null)),
    units: c.units.slice(0, CLIP.list),
  }))
  const input = { ...baseInput(runDir, run.meta, 'consolidate'), architecture_md: architectureOf(runDir), candidates, parts: { consolidation: blockText(CONSOLIDATION) } }
  if (pool.length < 2) skipConsolidation(runDir, `${pool.length} candidate(s): fewer than two have nothing to group`)
  const left = run.meta.budget === null ? Infinity : run.meta.budget - run.meta.agents_spent
  if (left < 2) skipConsolidation(runDir, `${left} agent(s) left of the budget: the grouping would take the one a verifier needs`)
  if (encodedSize(input) > MAX_CONSOLIDATE_BYTES) skipConsolidation(runDir, `the ${pool.length} candidates would make an input of ${encodedSize(input)} bytes, over the ${MAX_CONSOLIDATE_BYTES} one script can carry`)
  return input
}

// Why a grouping cannot be applied, as plain strings; empty when it can. Upstream's rule is "consolidate ... by stable fingerprint and root cause" and the plan's:
// a grouping is applied only if it covers every candidate fingerprint exactly once. A carried prior record is verified as itself (its unit waits for its verifier), so it
// is never merged away.
export function groupingProblems(pool, groups) {
  if (!Array.isArray(groups) || groups.length === 0) return ['groups is not a non-empty list']
  const known = new Map(pool.map(c => [c.fingerprint, c]))
  const where = new Map()
  const problems = []
  groups.forEach((g, i) => {
    if (!isObj(g) || !isText(g.keep) || !Array.isArray(g.merge) || !g.merge.every(isText) || typeof g.reason !== 'string') { problems.push(`group ${i} is not {keep, merge: [fingerprint], reason}`); return }
    if (g.merge.length > 0 && !isText(g.reason)) problems.push(`group ${i} merges without saying why`)
    for (const fp of [g.keep, ...g.merge]) {
      if (!known.has(fp)) problems.push(`group ${i} names ${show(fp)}, which is not a candidate`)
      else if (where.has(fp)) problems.push(`${show(fp)} appears in group ${where.get(fp)} and in group ${i}`)
      else where.set(fp, i)
    }
    for (const fp of g.merge) if (known.get(fp)?.carried_from) problems.push(`${show(fp)} is a carried prior record: it is verified as itself and is never merged away`)
  })
  for (const c of pool) if (!where.has(c.fingerprint)) problems.push(`candidate ${show(c.fingerprint)} is in no group`)
  return problems
}

// The pool after a valid grouping: a merged-away entry is gone, its hunters and units belong to the entry that was kept (a hunter of either
// fingerprint may not verify the root cause), and the kept entry records what it absorbed.
function consolidatedPool(pool, groups) {
  const into = new Map()
  for (const g of groups) for (const fp of g.merge) into.set(fp, { keep: g.keep, reason: g.reason.trim().slice(0, 400) })
  const byFp = new Map(pool.map(c => [c.fingerprint, c]))
  const kept = pool.filter(c => !into.has(c.fingerprint)).map(c => {
    const group = groups.find(g => g.keep === c.fingerprint && g.merge.length)
    if (!group) return c
    const gone = group.merge.map(fp => byFp.get(fp))
    return {
      ...c, hunter_ids: sortedUnique([...c.hunter_ids, ...gone.flatMap(m => m.hunter_ids)]), units: sortedUnique([...c.units, ...gone.flatMap(m => m.units)]),
      merged: [...(c.merged ?? []), ...gone.map(m => ({ fingerprint: m.fingerprint, proposed_verdict: m.proposed_verdict, reason: into.get(m.fingerprint).reason }))],
    }
  })
  return { pool: kept, into }
}

// The ledger after it: a unit that held a merged-away fingerprint holds the kept one (deduplicated: the validator rejects a repeat), and keeps the alias as
// bookkeeping, because an archived attempt of the unit still names the old fingerprint and must not be rewritten (RECONNAISSANCE.md: attempts are append-only).
function consolidatedLedger(ledger, into) {
  const moved = fp => into.get(fp)?.keep ?? fp
  return ledger.map(u => {
    const old = [...u.result_fingerprints, ...u.attempts.flatMap(a => a.result_fingerprints)].filter(fp => into.has(fp))
    if (!old.length) return u
    const have = new Set((u.merged_fingerprints ?? []).map(m => m.fingerprint))
    const aliases = sortedUnique(old).filter(fp => !have.has(fp)).map(fp => ({ fingerprint: fp, into: into.get(fp).keep, reason: into.get(fp).reason }))
    return { ...u, result_fingerprints: [...new Set(u.result_fingerprints.map(moved))], merged_fingerprints: [...(u.merged_fingerprints ?? []), ...aliases] }
  })
}

export function applyConsolidate({ runDir, run, stage, input, result, event, notes }) {
  const pool = readPool(runDir)
  const earlier = readJson(join(runDir, CONSOLIDATION_FILE))
  const finished = isObj(earlier) && earlier.stage === stage.name   // the effects landed and the step was not saved: applying the same result again finishes it
  if (!finished && !isDeepStrictEqual(input.candidates.map(c => c.fingerprint), pool.map(c => c.fingerprint))) refuse('candidates.json is not the pool this stage was planned for: plan the stage again')
  const groups = result.results.groups
  let problems = finished ? earlier.problems : groupingProblems(pool, groups)
  recordSpend(runDir, stage.name, result.budgetSpent)
  writeJson(join(stage.dir, 'result.json'), result)
  if (!finished) {
    const record = problems => ({ version: 1, stage: stage.name, applied: problems.length === 0, problems: problems.slice(0, 20).map(p => p.slice(0, 300)), groups: clipValue(groups) })
    if (problems.length === 0) {
      const merged = consolidatedPool(pool, groups)
      try { commitLedger(runDir, consolidatedLedger(run.ledger, merged.into), () => { writeJson(join(runDir, CANDIDATES_FILE), merged.pool); writeJson(join(runDir, CONSOLIDATION_FILE), record([])) }) } catch (e) {
        if (!e.problems) throw e
        problems = [`the ledger would not accept the merge: ${e.message}`, ...e.problems.slice(0, 3)]   // the grouping is optional work, so it is discarded like an invalid one
      }
    }
    if (problems.length) writeJson(join(runDir, CONSOLIDATION_FILE), record(problems))
  }
  advanceState(runDir, 'consolidate')
  const now = readPool(runDir)
  const merged = pool.length - now.length
  if (problems.length) notes.push(`the grouping was discarded (${problems.length} problem(s), first: ${problems[0].slice(0, 200)}); the ${pool.length} candidate(s) are validated as they stand`)
  event('ok', { counts: { candidates: pool.length, groups: groups.length, merged } }, problems.length ? 'grouping discarded' : null)
  return { summary: `consolidate candidates=${pool.length} groups=${groups.length} merged=${problems.length ? 0 : merged} applied=${problems.length === 0} agents=${result.budgetSpent}`, notes, then: `node audit-stage.mjs plan ${runDir}` }
}

// ---------- validate (Phase 3) ----------
// One fresh verifier per unique candidate, and per carried prior record (VALIDATION-AND-REPORTING.md, Phase 3). A candidate's verifier gets exactly what the method lists
// (the candidate, its linked checks, architecture facts, the validation blocks of the companions its units selected, the promotion procedure, the execution boundary, the three
// schema branches, prior records of the same fingerprint) and nothing else: not another candidate, another verifier's result, a hunter's ID or hardening notes. Its result is
// judged here, never repaired: a result that is not a valid record of the decision it names is discarded, the candidate is run once more with a fresh ID, and then it stays an
// unvalidated candidate in the ledger and is never a finding.
const LOCAL_BOUNDARIES = 'HUNTING.md#Local validation boundaries'
// What one validate input may be once written into a script. The script itself (the workflow and the parts it carries) is about 80 KB of the 524,288 the Workflow tool allows,
// so candidates go in batches: the rest stay pending and the next round runs them.
export const MAX_VALIDATE_BYTES = 380_000
const MAX_RECORD_BYTES = 64 * 1024   // one record in a verifier's input: a pool record is bounded already (merge-wave); a carried prior record is not
const MAX_CHECKS = 20
const clipTo = (v, n) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v)

// The value as it is when it fits `max` bytes, and else its clipped form marked truncated.
export function bounded(value, max = MAX_RECORD_BYTES) {
  return Buffer.byteLength(JSON.stringify(value)) <= max ? value : { truncated: true, ...clipValue(value) }
}

// The linked units' evidence for a candidate: the checks of each unit that holds it live (a candidate unit), and of each archived attempt that held it, without the
// owner's ID. Each text is cut and each list bounded: a hunter may fill a unit with 64 KiB.
function checksOf(ledger, entry) {
  const mine = new Set(entry.units)
  const checks = []
  for (const u of ledger.filter(x => mine.has(x.coverage_id))) {
    const evidence = [...(u.status === 'candidate' && u.result_fingerprints.includes(entry.fingerprint) ? u.local_checks : []), ...u.attempts.filter(a => a.result_fingerprints.includes(entry.fingerprint)).flatMap(a => a.local_checks)]
    for (const c of evidence) checks.push({ reviewed_paths: (c.reviewed_paths ?? []).slice(0, CLIP.list).map(p => clipTo(p, 300)), invariant: clipTo(c.invariant, 1000), method: c.method, result: clipTo(c.result, 1000), artifact: c.artifact })
  }
  return checks.slice(0, MAX_CHECKS)
}

// The Validation rules of each companion a linked unit selected (a unit that selects any block of a companion selects its Validation rules too: seed refuses one that does not).
function validationRefsOf(ledger, entry) {
  const validation = new Set(companions().map(c => c.validation))
  const mine = new Set(entry.units)
  return [...new Set(ledger.filter(u => mine.has(u.coverage_id)).flatMap(u => (u.selected_companion_blocks ?? []).filter(r => validation.has(r))))].sort()
}

// An ID is assigned when a verifier is planned: the entry's number, and its next try. Every ID is recorded in the independence history at once, with the hunters of the
// candidate, so that a reuse is refused here and not found afterwards.
function planned(history, entry, hunters, kind) {
  let h = history
  for (const id of hunters) h = recordAgent(h, entry.fingerprint, 'hunter', id)
  const id = agentId(kind, entry.n, { attempt: entry.attempts.length + 1 })
  return { history: recordAgent(h, entry.fingerprint, 'validator', id), id }
}

function markUnvalidated(decisions, entries, reason) {
  const ids = new Set(entries.map(e => e.fingerprint))
  return { ...decisions, entries: decisions.entries.map(e => (ids.has(e.fingerprint) ? { ...e, state: 'unvalidated', unresolved: reason } : e)) }
}

// The ledger once validation is over, one write: every decided candidate adds its verifier's check to the units that hold it, and an unvalidated one adds its reason to them.
// Upstream (Phase 3): "set that check's agent_id to the verifier's canonical ID and list its nonempty repository-relative reviewed_paths. Keep the unit-level reviewed_paths equal to
// the union across checks. Use method: source with artifact: null ... For a carried prior record's seeded planned unit there is no prior owner: the verifier that re-checks it becomes
// the unit's assignment owner, and its re-check is the unit's first check, moving the unit to candidate with the carried fingerprint." The verifier's result carries no list of paths
// it read, so the check lists the files of the record's trace and evidence, the ones it was told to re-read (my reading; the record has no other field for it).
const visible = (text, n, otherwise) => { const t = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, n).trim(); return t || otherwise }
function verifierCheck(entry) {
  const r = entry.record
  const paths = [...new Set([...r.trace, ...r.evidence].map(e => e.file))].sort()
  const finding = entry.decision === 'rejected' ? `the claim was refuted: ${visible(r.reason, 400, 'see the record')}` : `the claimed root cause stands as a lead: ${visible(r.claimed_root_cause, 400, 'see the record')}`
  return { agent_id: entry.verifier_id, reviewed_paths: paths, invariant: `independent Phase 3 verification of ${visible(entry.fingerprint, 200, 'the candidate')}: the cited source re-read and refutation attempted`, method: 'source', result: `decision ${entry.decision}; ${finding}`, artifact: null }
}
export function validatedLedger(ledger, decisions) {
  const patch = new Map()
  const unit = id => patch.get(id) ?? ledger.find(u => u.coverage_id === id)
  for (const e of decisions.entries) {
    for (const id of e.units) {
      const u = unit(id)
      if (!u) continue
      if (e.state === 'decided') {
        const carried = u.status === 'planned' && CARRIED.includes(u.prior_status)
        if (!(carried || (u.status === 'candidate' && u.result_fingerprints.includes(e.fingerprint)))) continue
        const check = verifierCheck(e)
        if (u.local_checks.some(c => c.agent_id === check.agent_id)) continue
        const next = { ...u, local_checks: [...u.local_checks, check], reviewed_paths: [...new Set([...u.reviewed_paths, ...check.reviewed_paths])] }
        patch.set(id, carried ? { ...next, status: 'candidate', agent_id: e.verifier_id, result_fingerprints: [e.fingerprint], unresolved: [] } : next)
      } else if (e.state === 'unvalidated' && u.status === 'candidate' && u.result_fingerprints.includes(e.fingerprint) && !u.unresolved.includes(e.unresolved)) {
        patch.set(id, { ...u, unresolved: [...u.unresolved, e.unresolved] })
      }
    }
  }
  return ledger.map(u => patch.get(u.coverage_id) ?? u)
}

// Closes the step: the ledger carries the decisions, and the step is saved last. A ledger the validator would refuse (nothing here is known to make one) ends the run with its
// own reason and is not retried: the step is closed all the same, so that `next` goes on to write-findings and the report discloses it.
function closeValidation(runDir, run, decisions) {
  const entries = decisions.entries.map(e => ({ ...e, units: readPool(runDir).find(c => c.fingerprint === e.fingerprint)?.units ?? [] }))
  try { commitLedger(runDir, validatedLedger(run.ledger, { ...decisions, entries })) } catch (err) {
    if (!err.problems) throw err
    markIncomplete(runDir, LEDGER_FAILED)
    appendEvent(runDir, { cmd: 'apply', stage: 'validate', result: 'failed', reason: LEDGER_FAILED, problems: err.problems.slice(0, 5) })
  }
  advanceState(runDir, 'validate')
}

export function validateInput(runDir, run) {
  const pool = readPool(runDir)
  let decisions = ensureDecisions(runDir, pool)
  const pending = decisions.entries.filter(e => e.state === 'pending')
  const left = run.meta.budget === null ? Infinity : Math.max(0, run.meta.budget - run.meta.agents_spent)
  // Strict budget: validate in fingerprint order while it permits; what it cannot fund stays an unvalidated candidate of the ledger, with upstream's reason, and the run is incomplete.
  const unfunded = pending.slice(left)
  if (unfunded.length) {
    decisions = markUnvalidated(decisions, unfunded, REASONS.validation)
    saveDecisions(runDir, decisions)
    markIncomplete(runDir, REASONS.validation)
  }
  const funded = pending.slice(0, left)
  const byFp = new Map(pool.map(c => [c.fingerprint, c]))
  if (!funded.length) {
    closeValidation(runDir, run, decisions)
    appendEvent(runDir, { cmd: 'plan', stage: 'validate', result: 'refused', reason: unfunded.length ? REASONS.validation : 'nothing is pending', counts: { unvalidated: unfunded.length } })
    refuse(unfunded.length ? `${REASONS.validation}: ${left} agent(s) are left of the budget (--budget ${run.meta.budget}, ${run.meta.agents_spent} spent) and ${unfunded.length} candidate(s) need a verifier; none was launched, they stay unvalidated candidates in the ledger and the run is marked incomplete`
      : 'every candidate is already decided or unvalidated; the step is closed. `audit-run.mjs next` says what is next')
  }
  const p = parts()
  const blocks = {}
  const before = historyOf(runDir)
  let history = before
  const shared = {
    ...baseInput(runDir, run.meta, 'validate'), round: decisions.rounds.validate + 1, architecture_md: architectureOf(runDir), blocks,
    parts: { verifierPrompt: p.verifierPrompt.text, verifierPromotion: p.verifierPromotion.text, localBoundaries: blockText(LOCAL_BOUNDARIES), schema_confirmed: p.schema_confirmed.text, schema_needs_validation: p.schema_needs_validation.text, schema_rejected: p.schema_rejected.text },
  }
  const priors = loadPriors(runDir)
  const candidates = []
  let size = encodedSize({ ...shared, candidates: [] })
  for (const e of funded) {
    const c = byFp.get(e.fingerprint)
    const made = planned(history, e, c.hunter_ids, 'v')
    const refs = validationRefsOf(run.ledger, c)
    const item = {
      agent_id: made.id, fingerprint: e.fingerprint, proposed_verdict: e.proposed_verdict, record: bounded(c.record), checks: checksOf(run.ledger, c), blocks: refs,
      priors: priors.filter(pr => pr.records.has(e.fingerprint)).map(pr => ({ run_id: pr.run_id, record: bounded(pr.records.get(e.fingerprint)) })),
      ...(e.attempts.at(-1)?.kind === 'confirmed' && { feedback: { attempt: e.attempts.length + 1, of: MAX_TRIES, problems: [`The previous verifier returned decision confirmed for this candidate. ${transitionProblem(e.proposed_verdict, 'confirmed')}.`] } }),
    }
    const cost = encodedSize(item) + refs.filter(r => !(r in blocks)).reduce((n, r) => n + blockText(r).length * 2, 0)
    if (candidates.length && size + cost > MAX_VALIDATE_BYTES) break   // the rest wait for the next round
    size += cost
    for (const r of refs) blocks[r] ??= blockText(r)
    candidates.push(item)
    history = made.history
  }
  if (history !== before) writeJson(join(runDir, HISTORY_FILE), history)
  return { ...shared, candidates }
}

// What a verifier returned for a candidate, judged: { decision, record } to keep, or { kind, problems } to discard (kind: no_result, malformed, other_fingerprint, confirmed).
export function judgeValidator(runDir, entry, result, cache) {
  const discard = (kind, ...problems) => ({ kind, problems: problems.flat().slice(0, 5).map(x => String(x).slice(0, 300)) })
  if (result === null || result === undefined) return discard('no_result', 'the verifier returned no result')
  if (!isObj(result) || Object.keys(result).sort().join() !== 'decision,record') return discard('malformed', 'the result is not exactly one object with decision and record, and nothing else')
  if (!VERDICTS.includes(result.decision)) return discard('malformed', `decision is ${show(result.decision)}, not one of ${VERDICTS.join(', ')}`)
  const moved = transitionProblem(entry.proposed_verdict, result.decision)
  if (moved) return discard(result.decision === 'confirmed' ? 'confirmed' : 'malformed', moved)
  const bad = recordProblems(runDir, result.record, { verdict: result.decision, cache })
  if (bad.length) return discard('malformed', bad)
  if (result.record.fingerprint !== entry.fingerprint) return discard('other_fingerprint', `the record has fingerprint ${show(result.record.fingerprint)}, not ${show(entry.fingerprint)}: a different root cause is not applied here`)
  return { decision: result.decision, record: JSON.parse(JSON.stringify(result.record)) }
}

export function applyValidate({ runDir, run, stage, input, result, event, notes }) {
  const got = result.results.verifiers
  const ids = input.candidates.map(c => c.agent_id)
  if (!isObj(got) || Object.keys(got).length !== ids.length || !ids.every(id => Object.hasOwn(got, id) && (got[id] === null || isObj(got[id])))) refuse(`results.verifiers must have exactly one entry per planned verifier (${ids.join(', ')}), each a result object or null; nothing was changed`)
  const pool = readPool(runDir)
  const decisions = decisionsOf(runDir)
  if (!decisions) refuse('decisions.json is missing: plan the stage again')
  // Every verifier of a round of first tries returned nothing: that is the environment (an agent the session cannot see yet), not any candidate. No try is used and the
  // stage is planned again, as a failed recon is. In a round of retries a missing result is a failed try like any other, which is what bounds the loop.
  const fresh = input.candidates.every(c => entryOf(decisions, c.fingerprint)?.attempts.length === 0 && entryOf(decisions, c.fingerprint)?.state === 'pending')
  if (fresh && ids.every(id => got[id] === null)) {
    recordSpend(runDir, stage.name, result.budgetSpent)
    writeJson(join(stage.dir, 'result.json'), result)
    event('escalated', {}, 'every verifier returned nothing')
    refuse(`every verifier of the round returned nothing (${result.reason}); no try was used (${result.budgetSpent} agent(s) spent): plan the stage again to retry it`)
  }
  let history = historyOf(runDir)
  const cache = new Map()
  const tally = { decided: 0, retried: 0, unvalidated: 0 }
  const entries = decisions.entries.map(e => {
    const c = input.candidates.find(x => x.fingerprint === e.fingerprint)
    if (!c) return e
    // The stage was applied before and its step was not saved (a crash): its effects are in decisions.json, and applying it again must not judge it twice.
    if (e.decided_in === stage.name || e.attempts.some(a => a.stage === stage.name)) return e
    if (e.state !== 'pending') refuse(`${e.fingerprint} is not pending (it is ${e.state}): plan the stage again`)
    const expected = agentId('v', e.n, { attempt: e.attempts.length + 1 })
    if (c.agent_id !== expected || !pool.some(p => p.fingerprint === e.fingerprint)) refuse(`${c.agent_id} is not the verifier planned for ${e.fingerprint} (that is ${expected}): plan the stage again`)
    history = recordAgent(history, e.fingerprint, 'validator', c.agent_id)
    const judged = judgeValidator(runDir, e, got[c.agent_id], cache)
    if (judged.decision) { tally.decided += 1; return { ...e, state: 'decided', decision: judged.decision, record: judged.record, verifier_id: c.agent_id, decided_in: stage.name } }
    const attempts = [...e.attempts, { id: c.agent_id, stage: stage.name, kind: judged.kind, problems: judged.problems }]
    if (attempts.length < MAX_TRIES) { tally.retried += 1; return { ...e, attempts } }
    tally.unvalidated += 1
    return { ...e, attempts, state: 'unvalidated', unresolved: judged.kind === 'confirmed' ? CONFIRMED_WITHOUT_EVIDENCE : REASONS.validation }
  })
  const out = { ...decisions, rounds: { ...decisions.rounds, validate: Math.max(decisions.rounds.validate, input.round) }, entries }
  saveDecisions(runDir, out)
  writeJson(join(runDir, HISTORY_FILE), history)
  for (const e of entries) if (e.state === 'unvalidated') markIncomplete(runDir, e.unresolved)
  recordSpend(runDir, stage.name, result.budgetSpent)
  writeJson(join(stage.dir, 'result.json'), result)
  const pending = entries.filter(e => e.state === 'pending').length
  if (pending === 0) closeValidation(runDir, run, out)
  const discarded = entries.flatMap(e => e.attempts.filter(a => a.stage === stage.name).map(a => `${a.id}: ${a.problems[0]}`))
  for (const d of discarded.slice(0, 10)) notes.push(`discarded, never repaired: ${d}`)
  event('ok', { counts: { candidates: ids.length, ...tally, pending } })
  return {
    summary: `validate round=${input.round} candidates=${ids.length} decided=${tally.decided} retried=${tally.retried} unvalidated=${tally.unvalidated} pending=${pending} agents=${result.budgetSpent}`, notes,
    then: pending ? `node audit-stage.mjs plan ${runDir}` : `node audit-findings.mjs write ${runDir}`,
  }
}
