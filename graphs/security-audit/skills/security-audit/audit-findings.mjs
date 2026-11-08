#!/usr/bin/env node
// audit-findings.mjs - the rules of Phases 3-5 of a security-audit run and the one writer of findings.json. Upstream's text
// (vendor/cloudflare-security-audit/skills/security-audit/VALIDATION-AND-REPORTING.md) is the authority; this file applies it.
// The stage inputs and appliers (consolidate, validate, verify) are in audit-verdicts.mjs; they call the rules below.
//
//   node audit-findings.mjs write          <run dir>     findings.json from the decided records, through both vendored validators
//   node audit-findings.mjs link-check     <run dir>     the cross-checks upstream's two validators do not make (plan 4.3, node D)
//   node audit-findings.mjs complete-check <run dir>     closes upstream's prose-only rule: complete only when every candidate has an
//                                                        independent final disposition and every retained record passed Phase 5
//
// A command's last line is "AUDIT: OK <cmd> ..." (exit 0) or "AUDIT: FAIL <reason>" (exit 1) after any "findings: <problem>" lines; bad usage
// is on stderr, exit 2.
//
// v1 is source-only (plan decision D1 A): no sandbox exists, so no record can be `confirmed`. That is enforced three times: the transition table
// has no way in (transitionProblem), a record that says `confirmed` is refused wherever one arrives (recordProblems), and link-check requires
// a `confirmed` record to be backed by a retained local artifact, which nothing can produce.
import { lstatSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { FINDINGS_FAILED, Usage, advanceState, appendEvent, formatNext, loadRun, markComplete, markIncomplete, nextStep, readJson, refuse, writeJson } from './audit-run.mjs'
import { LEDGER_FILE, MAX_CANDIDATE_BYTES } from './audit-ledger.mjs'
import { refProblem } from './audit-facts.mjs'
import { isSafeAgentId, validateFindingsDocument, validateFindingsFile, validateLedgerFile } from './upstream.mjs'
import { rulesOf } from './audit-profile.mjs'

export const CONFIRMED_REACHABLE = false   // plan D1 A: nothing in v1 can establish a bounded local observed result
// PandaStack's own reason strings (upstream's five are in audit-run.mjs REASONS). validation_budget_exhausted is upstream's, and is used for
// both a budget that cannot fund another verifier and a candidate whose verifier failed twice (the plan's choice; upstream bounds retries by budget alone).
export const CONFIRMED_WITHOUT_EVIDENCE = 'confirmed_without_local_evidence'   // plan 4.3 node C: a verifier said confirmed twice, and nothing here can back it
export const RECORD_UNRESOLVED = 'record_verification_unresolved'              // plan 4.3 node E: a record Phase 5 could not settle is removed, never kept
export const COMPLETE_CHECK_FAILED = 'complete_check_failed'                   // complete-check found the run not completable although it said in_progress
export const MAX_TRIES = 2               // a verifier's first result and one retry with a fresh ID (the plan: "retried once")
export const MAX_REPLACEMENT_ROUNDS = 2  // plan 4.3 node E, maxReplacementRounds
export const VERDICTS = ['confirmed', 'needs_validation', 'rejected']
export const DECISIONS_FILE = 'decisions.json'
export const HISTORY_FILE = 'agent-history.json'
export const FINDINGS_FILE = 'findings.json'
export const CANDIDATES_FILE = 'candidates.json'
export const EVIDENCE_LINKS_FILE = 'evidence-links.json'
const MAX_PROBLEMS = 40

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const show = v => String(JSON.stringify(v)).slice(0, 80)
// Code-unit order, as the vendored validator compares fingerprints (never localeCompare).
export const byFingerprint = (a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0)
const clone = v => JSON.parse(JSON.stringify(v))
const fail = (summary, problems = []) => { throw Object.assign(new Error(summary), { problems: problems.slice(0, MAX_PROBLEMS) }) }

// ---------- the pool of candidates ----------
// candidates.json is what merge-wave wrote (audit-ledger.mjs mergeCandidates): { fingerprint, proposed_verdict, hunter_ids, units, record }, one entry per
// fingerprint, sorted, plus what a carried prior record adds (carried_from) and what consolidation adds (merged). It is read as an untrusted file.
export function readPool(runDir) {
  const pool = readJson(join(runDir, CANDIDATES_FILE))
  if (pool === undefined) return []
  const ok = Array.isArray(pool) && pool.every(c => isObj(c) && isText(c.fingerprint) && ['confirmed', 'needs_validation'].includes(c.proposed_verdict) && Array.isArray(c.hunter_ids) && c.hunter_ids.every(isText) &&
    Array.isArray(c.units) && c.units.every(isText) && isObj(c.record)) && new Set(pool.map(c => c.fingerprint)).size === pool.length
  if (!ok) refuse(`${CANDIDATES_FILE} is not what merge-wave wrote (an array of { fingerprint, proposed_verdict, hunter_ids, units, record }, one entry per fingerprint)`)
  return pool
}

// ---------- agent IDs, and who has seen which fingerprint ----------
// The ID of a verifier, from the candidate's stable number (decisions.json): v Phase 3, r Phase 5, x a replacement's verifier. A retry appends
// -t<try>; a replacement after the first round -r<round>. Every ID matches upstream's pattern and is not a Windows device name, so it can
// name an agents/<id>/ directory. Deterministic, so a stage that died before its result was saved is planned again under the same labels.
export function agentId(kind, n, { round = 1, attempt = 1 } = {}) {
  if (!['v', 'r', 'x'].includes(kind)) throw new TypeError(`an agent kind is v, r or x, not ${show(kind)}`)
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError(`a candidate number is an integer from 1, not ${show(n)}`)
  if (!Number.isSafeInteger(round) || round < 1 || !Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('round and attempt are integers from 1')
  const id = `${kind}${String(n).padStart(2, '0')}${round > 1 ? `-r${round}` : ''}${attempt > 1 ? `-t${attempt}` : ''}`
  if (!isSafeAgentId(id)) throw new TypeError(`${id} is not a safe agent ID`)
  return id
}

export const ROLES = ['hunter', 'validator', 'verifier', 'replacer']   // hunted it; Phase 3; Phase 5; verified a replacement
// agent-history.json: { version: 1, fingerprints: { <fingerprint>: [{ role, id }] } }. An agent that has touched a fingerprint in one role may
// never take another on it (VALIDATION-AND-REPORTING.md: Phase 3 "did not hunt it"; a replacement's verifier "did not hunt, perform Phase 3
// validation, or propose the Phase 5 replacement"). An ID is one agent: a hunter finds several candidates, but a verifier is one candidate's.
export const emptyHistory = () => ({ version: 1, fingerprints: {} })

// The history with one more entry. The same (fingerprint, role, id) again is the same agent planned again and changes nothing; anything else
// that would reuse an ID is refused, naming both uses.
export function recordAgent(history, fingerprint, role, id) {
  if (!isText(fingerprint)) throw new TypeError(`a fingerprint is text, not ${show(fingerprint)}`)
  if (!ROLES.includes(role)) throw new TypeError(`a role is one of ${ROLES.join(', ')}, not ${show(role)}`)
  if (!isSafeAgentId(id)) refuse(`${show(id)} is not a safe agent ID (upstream: ^[a-z0-9][a-z0-9_-]{0,63}$, no Windows device name)`)
  const entries = Object.hasOwn(history.fingerprints, fingerprint) ? history.fingerprints[fingerprint] : []   // 'constructor' is a legal fingerprint
  if (entries.some(e => e.id === id && e.role === role)) return history
  const same = entries.find(e => e.id === id)
  if (same) refuse(`agent ${id} already served as ${same.role} of ${fingerprint}: it cannot also be its ${role} (every verifier is independent of the hunter and of every other verifier)`)
  for (const [other, list] of Object.entries(history.fingerprints)) {
    const used = list.find(e => e.id === id)
    if (other !== fingerprint && used && !(used.role === 'hunter' && role === 'hunter')) refuse(`agent ${id} already served ${other} as ${used.role}: only a hunter may serve two fingerprints, and never as a verifier`)
  }
  return { ...history, fingerprints: { ...history.fingerprints, [fingerprint]: [...entries, { role, id }] } }
}

export const historyOf = runDir => {
  const h = readJson(join(runDir, HISTORY_FILE))
  if (h === undefined) return emptyHistory()
  const ok = isObj(h) && h.version === 1 && isObj(h.fingerprints) && Object.values(h.fingerprints).every(l => Array.isArray(l) && l.every(e => isObj(e) && ROLES.includes(e.role) && isSafeAgentId(e.id)))
  if (!ok) refuse(`${HISTORY_FILE} is not what the stages wrote ({version: 1, fingerprints: {fp: [{role, id}]}}); it is never edited by hand`)
  return h
}

// Every way the history breaks independence, as plain strings (complete-check and the tests read it): an ID in two roles of one fingerprint, or
// a verifier's ID under two fingerprints.
export function historyProblems(history) {
  const problems = []
  const seen = new Map()
  for (const [fp, entries] of Object.entries(history.fingerprints)) {
    const roles = new Map()
    for (const e of entries) {
      if (roles.has(e.id) && roles.get(e.id) !== e.role) problems.push(`${fp}: agent ${e.id} is both ${roles.get(e.id)} and ${e.role}`)
      roles.set(e.id, e.role)
      const was = seen.get(e.id)
      if (was && was.fp !== fp && !(was.role === 'hunter' && e.role === 'hunter')) problems.push(`agent ${e.id} is recorded under ${was.fp} and ${fp}`)
      seen.set(e.id, { fp, role: e.role })
    }
  }
  return problems
}

// ---------- verdict transitions ----------
// VALIDATION-AND-REPORTING.md: "A verifier can promote needs_validation to confirmed only after independently establishing the complete path and
// bounded observed result. Demote proposed confirmation to needs_validation when a specific deployment or runtime fact remains unknown. Use
// rejected when source, local behavior, a visible control, missing meaningful impact, or an impossible prerequisite refutes the claim." This
// version executes nothing, so the first sentence never comes true: no row of the table ends in confirmed. `from` is the verdict a hunter
// proposed (Phase 3) or the record holds (Phase 5); a rejected record is final and is not verified again.
export const TRANSITIONS = {
  confirmed: ['needs_validation', 'rejected'],
  needs_validation: ['needs_validation', 'rejected'],
}
// The reason `to` is not a move from `from`, or null when it is one.
export function transitionProblem(from, to) {
  if (!VERDICTS.includes(to)) return `${show(to)} is not a verdict (${VERDICTS.join(', ')})`
  if (!Object.hasOwn(TRANSITIONS, from)) return `a ${show(from)} record is not verified: only a proposed confirmed or needs_validation is`
  if (to === 'confirmed' && !CONFIRMED_REACHABLE) return `${from} to confirmed is not possible here: it needs an independently established bounded observed local result, and this audit executes no target code (the verdict is needs_validation, with the missing sandbox as its blocker)`
  return TRANSITIONS[from].includes(to) ? null : `${from} to ${to} is not a move`
}

// ---------- materiality ----------
// VALIDATION-AND-REPORTING.md, Phase 5: a replacement is not applied as final when it "promotes a record to a stronger verdict ... or materially changes the root cause, trace,
// execution input or observed result, demonstrated impact, or severity"; "non-material wording or repository-line corrections may be applied directly when they do not change
// meaning or evidence". Where "material" starts is my reading (plan 4.3 node E), kept in this one table: a field is material when its value differs, and the value is what the
// record means, not how it is worded. Listed beyond the plan's reading (the independent audit of this branch showed one verifier replacing a record's evidence file, blockers and plan
// with no second look): severity.likelihood.score (upstream says "severity"), the files the evidence rests on (not its lines or descriptions), how many blockers there are and which
// contexts the validation plan has (not their wording). Anything else (title, description, conditions, remediation, confidence, a trace step's line or description, an evidence
// entry's line or description, the wording of a blocker or a plan) is wording or a line.
const traceShape = r => (Array.isArray(r.trace) ? r.trace.map(t => (isObj(t) ? [t.file, t.kind, t.scope] : t)) : r.trace)
export const MATERIAL_FIELDS = {
  verdict: r => r.verdict,
  root_cause: r => r.root_cause,
  claimed_root_cause: r => r.claimed_root_cause,
  trace: traceShape,   // the steps' (file, kind, scope) in order; not their lines or descriptions
  evidence: r => (Array.isArray(r.evidence) ? r.evidence.map(e => (isObj(e) ? e.file : e)) : r.evidence),
  blockers: r => (Array.isArray(r.blockers) ? r.blockers.length : r.blockers),
  validation_plan: r => (isObj(r.validation_plan) ? Object.keys(r.validation_plan).sort() : r.validation_plan),
  'execution.payloads': r => r.execution?.payloads,
  'execution.instructions': r => r.execution?.instructions,
  'execution.observed_result': r => r.execution?.observed_result,
  'severity.impact': r => r.severity?.impact,
  'severity.overall_severity': r => r.severity?.overall_severity,
  'severity.likelihood.score': r => r.severity?.likelihood?.score,
}
// The material fields on which two records differ; empty means the change is non-material. Anything that is not a record is material.
export function materialChanges(before, after) {
  if (!isObj(before) || !isObj(after)) return ['record']
  return Object.entries(MATERIAL_FIELDS).filter(([, get]) => !isDeepStrictEqual(get(before), get(after))).map(([name]) => name)
}
export const isMaterial = (before, after) => materialChanges(before, after).length > 0

// ---------- decisions.json: what each verifier decided, and where each candidate stands ----------
// { version: 1, rounds: { validate: N, verify: N }, entries: [entry] } with one entry per pool fingerprint, in fingerprint order. `n` is the entry's number for
// life (its verifiers' IDs come from it), assigned once, so a candidate keeps its IDs whatever else is decided or removed. An array, not an object keyed by
// fingerprint: 'constructor' is a legal fingerprint.
//   state     pending (a verifier has yet to settle it), decided (decision and record), unvalidated (no verifier did: unresolved says why, it is never a finding)
//   attempts  the verifier results discarded so far: { id, stage, kind, problems }
//   phase5    null until Phase 5 reaches the record; audit-verdicts.mjs owns its shape
const STATES = ['pending', 'decided', 'unvalidated']
export const emptyDecisions = () => ({ version: 1, rounds: { validate: 0, verify: 0 }, entries: [] })
const isEntry = e => isObj(e) && isText(e.fingerprint) && Number.isSafeInteger(e.n) && e.n >= 1 && ['confirmed', 'needs_validation'].includes(e.proposed_verdict) && STATES.includes(e.state) &&
  Array.isArray(e.attempts) && e.attempts.every(a => isObj(a) && isSafeAgentId(a.id) && isText(a.stage) && isText(a.kind) && Array.isArray(a.problems)) &&
  (e.decision === null || ['needs_validation', 'rejected'].includes(e.decision)) && (e.record === null || isObj(e.record)) && (e.verifier_id === null || isSafeAgentId(e.verifier_id)) &&
  (e.unresolved === null || isText(e.unresolved)) && (e.phase5 === null || isObj(e.phase5)) && (e.state !== 'decided' || (e.decision !== null && e.record !== null && e.verifier_id !== null))
const isDecisions = d => isObj(d) && d.version === 1 && isObj(d.rounds) && Number.isSafeInteger(d.rounds.validate) && Number.isSafeInteger(d.rounds.verify) && Array.isArray(d.entries) && d.entries.every(isEntry) &&
  new Set(d.entries.map(e => e.fingerprint)).size === d.entries.length && new Set(d.entries.map(e => e.n)).size === d.entries.length

// The decisions on disk, or null when there are none yet. A file that is not what the stages wrote is refused by name: it is never edited by hand and never read as empty.
export function decisionsOf(runDir) {
  const d = readJson(join(runDir, DECISIONS_FILE))
  if (d === undefined) return null
  if (!isDecisions(d)) refuse(`${DECISIONS_FILE} is not what the stages wrote ({version: 1, rounds, entries: [one per candidate]}); it is never edited by hand`)
  return d
}
export const saveDecisions = (runDir, decisions) => writeJson(join(runDir, DECISIONS_FILE), decisions)
export const entryOf = (decisions, fingerprint) => decisions.entries.find(e => e.fingerprint === fingerprint)

// The decisions for `pool` (candidates.json): the file on disk with an entry for every candidate, new ones numbered after the highest, or a fresh one. The pool is final
// when this runs (consolidation is over), so the numbers follow fingerprint order. An entry on disk for a fingerprint the pool no longer holds is refused.
export function ensureDecisions(runDir, pool) {
  const had = decisionsOf(runDir) ?? emptyDecisions()
  const known = new Set(pool.map(c => c.fingerprint))
  const stray = had.entries.find(e => !known.has(e.fingerprint))
  if (stray) refuse(`${DECISIONS_FILE} has an entry for ${show(stray.fingerprint)}, which candidates.json no longer holds`)
  let n = Math.max(0, ...had.entries.map(e => e.n))
  const added = pool.filter(c => !entryOf(had, c.fingerprint)).sort(byFingerprint).map(c => ({
    fingerprint: c.fingerprint, n: ++n, proposed_verdict: c.proposed_verdict, state: 'pending', attempts: [], decision: null, record: null, verifier_id: null, unresolved: null, phase5: null,
  }))
  if (!added.length) return had
  const out = { ...had, entries: [...had.entries, ...added].sort(byFingerprint) }
  saveDecisions(runDir, out)
  return out
}

// ---------- what a record must be before anything keeps it ----------
// The vendored schema validator (the authority on shape), then what it cannot see: every trace and evidence file is in the audited snapshot
// and every line is within it (the schema has no quote field, so existence and range are what can be checked), and no `confirmed`. An optional
// `fingerprint` and `verdict` say what the record must be (a verifier returns the same fingerprint, and the verdict it decided).
export function recordProblems(runDir, record, { fingerprint, verdict, cache = new Map() } = {}) {
  if (!isObj(record)) return [`the record is not an object (${show(record)})`]
  // The schema bounds no text, and a verifier reads hostile source: a record is as large as a candidate may be and no larger (the findings validator refuses a file over 5 MiB, and
  // one record of that size would cost every other finding in the run), checked before anything reads it.
  const bytes = Buffer.byteLength(JSON.stringify(record))
  if (bytes > MAX_CANDIDATE_BYTES) return [`the record is ${bytes} bytes, over the ${MAX_CANDIDATE_BYTES} a record may hold`]
  const problems = validateFindingsDocument([record]).map(m => m.replace(/^\$\[0\](?:\.|: )?/, '')).slice(0, 10)
  if (problems.length) return problems
  const wrong = []
  if (fingerprint !== undefined && record.fingerprint !== fingerprint) wrong.push(`the fingerprint is ${show(record.fingerprint)}, not ${show(fingerprint)}`)
  if (verdict !== undefined && record.verdict !== verdict) wrong.push(`the record's verdict is ${show(record.verdict)}, not ${show(verdict)}`)
  if (record.verdict === 'confirmed' && !CONFIRMED_REACHABLE) wrong.push('the record is confirmed, and no bounded observed local result can exist in this audit')
  for (const e of [...record.trace, ...record.evidence]) {
    const bad = refProblem(`${e.file}:${e.line}`, join(runDir, 'tree'), cache)
    if (bad) wrong.push(`trace or evidence ${bad}`)
  }
  return [...new Set([...wrong])].slice(0, 10)
}

// ---------- the final records ----------
// A record is retained while it is decided and Phase 5 has not removed it. findings.json is exactly the retained records, sorted by fingerprint.
export const retained = e => e.state === 'decided' && !(e.phase5 && e.phase5.state === 'removed')
export const finalRecords = decisions => decisions.entries.filter(retained).map(e => e.record).sort(byFingerprint)
// Phase 5 reads confirmed and needs_validation records; a rejected one is final as the verifier left it.
export const needsPhase5 = record => record.verdict === 'confirmed' || record.verdict === 'needs_validation'

// ---------- link-check ----------
// What upstream's two validators cannot see, because each takes exactly one file (plan 1.4): the records against the ledger and the snapshot. It adds checks and relaxes none.
//   1. every record is linked from at least one ledger unit (a live fingerprint, an archived attempt's, or the kept side of a consolidation alias)
//   2. every candidate the ledger holds (live or archived, aliases resolved) and every candidate in the pool has a record in findings.json, or is listed as unresolved with a reason
//      (an unvalidated candidate, a record Phase 5 removed), and then the run must say it is incomplete: nothing is dropped silently
//   3. every confirmed record is backed by a unit check with method "local" whose artifact is a regular file that exists (v1: none can, which is the D1 rule enforced by construction)
//   4. every trace and evidence file is in the snapshot and every line is within it
// Returns { problems, unresolved } with unresolved = [{ fingerprint, reason, units }].
export function linkCheck({ runDir, records, ledger, decisions, pool, meta }) {
  const problems = []
  const note = text => { if (problems.length < MAX_PROBLEMS) problems.push(text) }
  const alias = new Map(ledger.flatMap(u => (Array.isArray(u.merged_fingerprints) ? u.merged_fingerprints : []).map(m => [m.fingerprint, m.into])))
  const resolved = fp => alias.get(fp) ?? fp
  const have = new Set(records.map(r => r.fingerprint))
  const linked = new Set(ledger.flatMap(u => [...u.result_fingerprints, ...u.attempts.flatMap(a => a.result_fingerprints), ...(Array.isArray(u.merged_fingerprints) ? u.merged_fingerprints.map(m => m.into) : [])]))
  for (const r of records) if (!linked.has(r.fingerprint)) note(`record ${show(r.fingerprint)} is linked from no coverage unit`)
  const candidates = new Map()   // fingerprint -> units that hold it
  const add = (fp, unit) => candidates.set(resolved(fp), [...(candidates.get(resolved(fp)) ?? []), ...(unit ? [unit] : [])])
  for (const u of ledger) for (const fp of [...(u.status === 'candidate' ? u.result_fingerprints : []), ...u.attempts.flatMap(a => a.result_fingerprints)]) add(fp, u.coverage_id)
  for (const c of pool) add(c.fingerprint, null)
  const unresolved = []
  for (const [fp, units] of [...candidates].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (have.has(fp)) continue
    const e = decisions?.entries.find(x => x.fingerprint === fp)
    const reason = e?.state === 'unvalidated' ? e.unresolved : e?.phase5?.state === 'removed' ? e.phase5.reason : null   // anything else is a candidate that was never settled
    if (reason === null) { note(`candidate ${show(fp)} has no record in findings.json and is not listed as unresolved: nothing may be dropped silently`); continue }
    unresolved.push({ fingerprint: fp, reason, units: [...new Set(units)].sort() })
    if (meta.run_status !== 'incomplete') note(`candidate ${show(fp)} is unresolved (${reason}) but the run is not marked incomplete`)
  }
  for (const r of records.filter(x => x.verdict === 'confirmed')) {
    const backed = ledger.some(u => u.result_fingerprints.includes(r.fingerprint) && u.local_checks.some(c => c.method === 'local' && typeof c.artifact === 'string' && isRegularFile(join(runDir, c.artifact))))
    if (!backed) note(`confirmed record ${show(r.fingerprint)} is backed by no unit check with method "local" whose artifact is a regular file that exists`)
  }
  const cache = new Map()
  for (const r of records) for (const e of [...(Array.isArray(r.trace) ? r.trace : []), ...(Array.isArray(r.evidence) ? r.evidence : [])]) {
    const bad = refProblem(`${e?.file}:${e?.line}`, join(runDir, 'tree'), cache)
    if (bad) note(`record ${show(r.fingerprint)}: ${bad}`)
  }
  return { problems, unresolved }
}
function isRegularFile(path) { try { return lstatSync(path).isFile() } catch { return false } }

// fingerprint -> the units that carry it and the checks on them (plan 4.3: evidence-links.json, generated, never edited)
export function evidenceLinks(records, ledger) {
  return records.map(r => ({
    fingerprint: r.fingerprint, verdict: r.verdict,
    units: ledger.filter(u => u.result_fingerprints.includes(r.fingerprint) || u.attempts.some(a => a.result_fingerprints.includes(r.fingerprint)) || (u.merged_fingerprints ?? []).some(m => m.into === r.fingerprint))
      .map(u => ({ coverage_id: u.coverage_id, checks: u.local_checks.map(c => ({ agent_id: c.agent_id, method: c.method, artifact: c.artifact })) })),
  }))
}

// ---------- findings.json: the one write path ----------
// Writes `records`, sorted, to <runDir>/findings.json if, and only if, upstream's validators and the link-check pass: the file is written beside the real one, run through
// validate-findings.cjs and validate-coverage-ledger.cjs (upstream's documented commands, exit 0 and a PASS line) and linkCheck, and only then renamed over it. A failure
// leaves findings.json exactly as it was. Throws an Error with `problems` on failure.
export function commitFindings(runDir, records) {
  const file = join(runDir, FINDINGS_FILE), candidate = `${file}.candidate`
  if (!Array.isArray(records)) fail(`findings are an array of records; ${FINDINGS_FILE} is unchanged`)
  const sorted = clone([...records].sort(byFingerprint))
  const errors = validateFindingsDocument(sorted)
  if (errors.length) fail(`the findings would not pass upstream's validator (${errors.length} error(s)); ${FINDINGS_FILE} is unchanged`, errors)
  const ledger = readJson(join(runDir, LEDGER_FILE))
  if (!Array.isArray(ledger)) fail(`${LEDGER_FILE} is missing or not an array: findings are written against it; ${FINDINGS_FILE} is unchanged`)
  const run = loadRun(runDir)
  const link = linkCheck({ runDir, records: sorted, ledger, decisions: decisionsOf(runDir), pool: readPool(runDir), meta: run.meta })
  if (link.problems.length) fail(`the link-check failed (${link.problems.length} problem(s)); ${FINDINGS_FILE} is unchanged`, link.problems)
  writeJson(candidate, sorted)
  try {
    for (const [name, validate, path] of [['validate-findings.cjs', validateFindingsFile, candidate], ['validate-coverage-ledger.cjs', validateLedgerFile, join(runDir, LEDGER_FILE)]]) {
      let r
      try { r = validate(path) } catch (e) { fail(`upstream's ${name} gave no verdict (${e.message}); ${FINDINGS_FILE} is unchanged`) }
      if (!r.valid) fail(`upstream's ${name} said "${r.lastLine}" (exit ${r.exitCode}); ${FINDINGS_FILE} is unchanged`)
    }
    renameSync(candidate, file)
  } finally {
    rmSync(candidate, { force: true })
  }
  writeJson(join(runDir, EVIDENCE_LINKS_FILE), evidenceLinks(sorted, ledger))
}

// ---------- write-findings ----------
export function writeFindings(runDir) {
  const started = Date.now()
  const run = loadRun(runDir)
  const next = nextStep(run)
  if (next.step !== 'write-findings') refuse(`write-findings is not the next step of this run: ${formatNext(next)}`)
  const pool = readPool(runDir)
  const decisions = decisionsOf(runDir)
  if (decisions === null && pool.length) refuse(`${pool.length} candidate(s) in ${CANDIDATES_FILE} were never validated (${DECISIONS_FILE} is missing): the validate stage has not run`)
  const pending = (decisions?.entries ?? []).filter(e => e.state === 'pending').length + pool.filter(c => !entryOf(decisions ?? emptyDecisions(), c.fingerprint)).length
  if (pending) refuse(`${pending} candidate(s) are still pending a verifier: validate is not over`)
  const records = finalRecords(decisions ?? emptyDecisions())
  try {
    commitFindings(runDir, records)
  } catch (e) {
    if (!e.problems) throw e
    // Terminal state (b): the run says why it stopped. findings.json is left as it was (none), `next` goes to the report, and the report discloses it.
    markIncomplete(runDir, FINDINGS_FAILED)   // the first reason stands when the run was incomplete already: write_failed is what lets `next` go on to the report either way
    advanceState(runDir, 'write-findings', { write_failed: true })
    appendEvent(runDir, { cmd: 'write-findings', stage: 'write-findings', result: 'failed', reason: FINDINGS_FAILED, duration_ms: Date.now() - started, problems: e.problems.slice(0, 5) })
    throw Object.assign(new Error(`${e.message}; the run is marked incomplete (${FINDINGS_FAILED}) and \`next\` goes to the report`), { problems: e.problems })
  }
  advanceState(runDir, 'write-findings', { write_failed: false })
  const counts = Object.fromEntries(VERDICTS.map(v => [v, records.filter(r => r.verdict === v).length]))
  appendEvent(runDir, { cmd: 'write-findings', stage: 'write-findings', result: 'ok', duration_ms: Date.now() - started, counts })
  const notes = []
  // Nothing for Phase 5 to read (no confirmed or needs_validation record), or a quick run, whose validate stage was Phase 5 too: the run ends here, and complete-check says how.
  if (!records.some(needsPhase5)) notes.push(`no record needs Phase 5; ${finishRun(runDir).message}`)
  else if (rulesOf(run.meta).mergedValidation) notes.push(`the quick profile's merged pass: each record's Phase 3 verifier made the Phase 5 record checks too, so no verify stage runs; ${finishRun(runDir).message}`)
  return { summary: `records=${records.length} confirmed=${counts.confirmed} needs_validation=${counts.needs_validation} rejected=${counts.rejected}`, notes }
}

// ---------- complete-check ----------
// Upstream: "Set run_status: complete only when every ledger candidate has an independent final disposition and every retained record passes Phase 5." That is prose only in
// upstream (neither validator reads run status). Here: both validators pass on the files on disk, the link-check is clean with nothing unresolved, every candidate is decided,
// every retained confirmed or needs_validation record passed Phase 5, and the independence history has no reuse. A run that is incomplete stays so; a run that is in progress and
// fails is marked incomplete with complete_check_failed; one that passes is marked complete.
//
// Whether a decided entry passed Phase 5, given the non-hunter roles the independence history holds for its fingerprint. In every profile: a verifier that is not the hunter or the
// Phase 3 verifier said so (the Phase 5 verifier, or the new one a material replacement went to). In a profile that merges Phase 3 and Phase 5 (quick) also: the `merged` marker
// audit-verdicts.mjs applyValidate writes, naming the entry's own kept Phase 3 verifier, which the history holds as that fingerprint's validator. Both identities are checked: a
// discarded attempt is a validator in the history too, and only the entry says whose result was kept.
function passedPhase5(e, roles, rules) {
  const p5 = e.phase5
  if (p5?.state === 'verified') return roles.some(h => ['verifier', 'replacer'].includes(h.role) && h.id === p5.verifier_id)
  if (p5?.state === 'merged' && rules.mergedValidation) return p5.verifier_id === e.verifier_id && roles.some(h => h.role === 'validator' && h.id === p5.verifier_id)
  return false
}
export function completeProblems(runDir) {
  const run = loadRun(runDir)
  const problems = []
  const note = text => { if (problems.length < MAX_PROBLEMS) problems.push(text) }
  if (!Array.isArray(run.ledger)) { note(`${LEDGER_FILE} is missing`); return { problems, unresolved: [] } }
  if (!Array.isArray(run.findings)) { note(`${FINDINGS_FILE} is missing: nothing was written`); return { problems, unresolved: [] } }
  for (const [name, validate, file] of [['validate-findings.cjs', validateFindingsFile, FINDINGS_FILE], ['validate-coverage-ledger.cjs', validateLedgerFile, LEDGER_FILE]]) {
    try { const r = validate(join(runDir, file)); if (!r.valid) note(`${name} said "${r.lastLine}"`) } catch (e) { note(`${name} gave no verdict: ${e.message}`) }
  }
  const decisions = decisionsOf(runDir)
  const pool = readPool(runDir)
  const link = linkCheck({ runDir, records: run.findings, ledger: run.ledger, decisions, pool, meta: run.meta })
  for (const p of link.problems) note(p)
  for (const u of link.unresolved) note(`candidate ${show(u.fingerprint)} is unresolved: ${u.reason}`)
  const history = historyOf(runDir)
  const rules = rulesOf(run.meta)
  for (const p of historyProblems(history)) note(p)
  for (const e of decisions?.entries ?? []) if (e.state !== 'decided') note(`candidate ${show(e.fingerprint)} was never decided (${e.state})`)
  if (decisions && !isDeepStrictEqual(finalRecords(decisions), run.findings)) note('findings.json is not the decided records (a record Phase 5 removed is in it, or one it kept is missing)')
  for (const r of run.findings) {
    const e = decisions && entryOf(decisions, r.fingerprint)
    if (!e || e.state !== 'decided') { note(`record ${show(r.fingerprint)} has no decision`); continue }
    const roles = (history.fingerprints[r.fingerprint] ?? []).filter(h => !['hunter'].includes(h.role))
    if (!roles.some(h => h.role === 'validator')) note(`record ${show(r.fingerprint)} was verified by no Phase 3 verifier`)
    if (needsPhase5(r) && !passedPhase5(e, roles, rules)) note(`record ${show(r.fingerprint)} did not pass Phase 5`)
    if (!isDeepStrictEqual(e.record, r)) note(`record ${show(r.fingerprint)} in findings.json is not the decided record`)
  }
  return { problems, unresolved: link.unresolved }
}

// Runs complete-check and moves run_status as it decides. Returns { ok, status, message, problems }.
export function finishRun(runDir) {
  const { meta } = loadRun(runDir)
  if (meta.run_status === 'incomplete') return { ok: false, status: 'incomplete', problems: [], message: `the run is incomplete (${meta.incomplete_reason}): it stays so, and the report discloses why` }
  const { problems } = completeProblems(runDir)
  if (problems.length === 0) { markComplete(runDir); return { ok: true, status: 'complete', problems, message: 'every candidate has an independent final disposition and every retained record passed Phase 5: the run is complete' } }
  if (meta.run_status === 'complete') return { ok: false, status: 'complete', problems, message: `the run is marked complete and ${problems.length} problem(s) were found: it is not downgraded` }
  markIncomplete(runDir, COMPLETE_CHECK_FAILED)
  return { ok: false, status: 'incomplete', problems, message: `${problems.length} problem(s): the run is marked incomplete (${COMPLETE_CHECK_FAILED})` }
}

// ---------- command line ----------
const USAGE = `usage: audit-findings.mjs write <run dir>
       audit-findings.mjs link-check <run dir>
       audit-findings.mjs complete-check <run dir>`
function runLinkCheck(runDir) {
  const run = loadRun(runDir)
  if (!Array.isArray(run.ledger)) refuse(`${LEDGER_FILE} is missing`)
  if (!Array.isArray(run.findings)) refuse(`${FINDINGS_FILE} is missing`)
  const out = linkCheck({ runDir, records: run.findings, ledger: run.ledger, decisions: decisionsOf(runDir), pool: readPool(runDir), meta: run.meta })
  const notes = out.unresolved.map(u => `unresolved ${u.fingerprint} (${u.reason}) units=${u.units.join(',')}`)
  if (out.problems.length) fail(`${runDir} has ${out.problems.length} link problem(s)`, out.problems)
  return { summary: `link-check records=${run.findings.length} unresolved=${out.unresolved.length}`, notes }
}
function runCompleteCheck(runDir) {
  // A run that is not at its end is not judged: complete-check marks an unfinished run incomplete, for good, because it has not been verified yet. write and verify call finishRun
  // themselves at the points a run ends; this command is for the session to ask once `next` says report (or done).
  const next = nextStep(loadRun(runDir))
  if (!['report', 'done'].includes(next.step)) refuse(`complete-check runs at the end of a run, when \`audit-run.mjs next\` says report or done: it is ${formatNext(next)} now; nothing was changed`)
  const out = finishRun(runDir)
  if (!out.ok) fail(out.message, out.problems)
  return { summary: `complete-check ${out.message}`, notes: [] }
}
const COMMANDS = { write: writeFindings, 'link-check': runLinkCheck, 'complete-check': runCompleteCheck }

export function main(argv) {
  const [cmd, runArg, ...rest] = argv
  try {
    if (!Object.hasOwn(COMMANDS, cmd) || runArg === undefined || rest.length) throw new Usage()
    const out = COMMANDS[cmd](resolve(runArg))
    for (const n of out.notes) console.log(`note: ${n}`)
    console.log(`AUDIT: OK ${out.summary.startsWith(cmd) ? out.summary : `${cmd} ${out.summary}`}`)
    return 0
  } catch (e) {
    if (e instanceof Usage) { console.error(USAGE); return 2 }
    for (const p of e.problems ?? []) console.log(`findings: ${p}`)
    console.log(`AUDIT: FAIL ${e.message}`)
    return 1
  }
}

// Run as a command, also through the ~/.claude/skills symlink install.sh makes.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
