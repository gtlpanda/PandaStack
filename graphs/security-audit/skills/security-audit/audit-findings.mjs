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
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { readJson, refuse } from './audit-run.mjs'
import { refProblem } from './audit-facts.mjs'
import { isSafeAgentId, validateFindingsDocument } from './upstream.mjs'

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

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const show = v => String(JSON.stringify(v)).slice(0, 80)
// Code-unit order, as the vendored validator compares fingerprints (never localeCompare).
export const byFingerprint = (a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0)

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
// VALIDATION-AND-REPORTING.md, Phase 5: a replacement is not applied as final when it "promotes a record to a stronger verdict ... or
// materially changes the root cause, trace, execution input or observed result, demonstrated impact, or severity"; "non-material wording or
// repository-line corrections may be applied directly". Where "material" starts is my reading (plan 4.3 node E), kept in this one table:
// a field is material when its value differs. Anything not listed (title, description, evidence, conditions, remediation, confidence, a trace
// step's line or description, blockers, the validation plan) is wording or a line. Broader than the plan on one point: severity.likelihood.score
// also counts, because upstream says "severity" and likelihood is half of it (its reason text stays wording).
const traceShape = r => (Array.isArray(r.trace) ? r.trace.map(t => (isObj(t) ? [t.file, t.kind, t.scope] : t)) : r.trace)
export const MATERIAL_FIELDS = {
  verdict: r => r.verdict,
  root_cause: r => r.root_cause,
  claimed_root_cause: r => r.claimed_root_cause,
  trace: traceShape,   // the steps' (file, kind, scope) in order; not their lines or descriptions
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

// ---------- what a record must be before anything keeps it ----------
// The vendored schema validator (the authority on shape), then what it cannot see: every trace and evidence file is in the audited snapshot
// and every line is within it (the schema has no quote field, so existence and range are what can be checked), and no `confirmed`. An optional
// `fingerprint` and `verdict` say what the record must be (a verifier returns the same fingerprint, and the verdict it decided).
export function recordProblems(runDir, record, { fingerprint, verdict, cache = new Map() } = {}) {
  if (!isObj(record)) return [`the record is not an object (${show(record)})`]
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
