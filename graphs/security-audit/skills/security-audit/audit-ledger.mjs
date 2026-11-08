#!/usr/bin/env node
// audit-ledger.mjs - the one writer of a security-audit run's coverage-ledger.json (and architecture.md, candidates.json,
// uncovered.json). Upstream's text (vendor/cloudflare-security-audit/skills/security-audit/RECONNAISSANCE.md "Deterministic
// coverage ledger", HUNTING.md "Parent consolidation and ledger update") is the authority; this file only applies it.
//
//   node audit-ledger.mjs seed       <run dir> <recon.json>            recon.json: { architecture_md, units: [...] }
//   node audit-ledger.mjs plan-wave  <run dir>
//   node audit-ledger.mjs merge-wave <run dir> <hunter-results.json>   { "<hunter agent id>": <result object | null>, ... }
//   node audit-ledger.mjs apply-critic <run dir> <critic.json> <mint.json>   critic.json: HUNTING.md's critic JSON; mint.json: { units: [...] }
//
// Every operation runs only when `audit-run.mjs next` says it is the next step, writes the ledger through one gate, and
// then saves its step with advanceState (audit-run.mjs's stage-state.json contract) and one line in events.jsonl.
// The gate (commitLedger): the new ledger is sorted, run through upstream's validator in memory for readable errors,
// written beside the real file, and run through the validator CLI (upstream.mjs: exit 0 and a PASS line); only then is it
// renamed over coverage-ledger.json. A ledger that would fail is refused and the file is left exactly as it was.
// Upstream's validator judges every unit's evidence (state table, owned paths, fresh owners); nothing here re-implements
// its rules. A command's last line is "AUDIT: OK <cmd> ..." (exit 0) or "AUDIT: FAIL <reason>" (exit 1) after any
// "ledger: <problem>" lines; bad usage is on stderr, exit 2.
import { existsSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CARRIED, REASONS, Usage, advanceState, appendEvent, countStatuses, formatNext, git, loadRun, nextStep, readJson, refuse, waveAllowance, writeJson } from './audit-run.mjs'
import { canonicalCoverageId, isSafeRelativePath, validateFindingsFile, validateLedgerDocument, validateLedgerFile } from './upstream.mjs'

export const LEDGER_FILE = 'coverage-ledger.json'
export const ARCHITECTURE_WORD_CAP = 1100          // RECONNAISSANCE.md: "a hard cap of about 1,000 words"; my reading of "about" is 10%
export const MAX_UNIT_ATTEMPTS = 2                 // PandaStack's: a hunter result that fails twice defers its unit (plan section 4.3)
export const FAILED_TWICE = 'hunter_result_invalid_twice'   // PandaStack's own reason string, not upstream's (so not in REASONS)
const MAX_PROBLEMS = 40
const MAX_HARDENING = 20, MAX_HARDENING_CHARS = 1000   // kept small: the validator rejects a ledger file over 5 MiB or any array past 1,000 entries
const SEED_STATES = ['planned', 'not_applicable', 'out_of_scope', 'deferred']   // the states a unit can start in
const VERDICTS = ['confirmed', 'needs_validation']

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const clone = v => JSON.parse(JSON.stringify(v))   // what the file will hold: no undefined keys, no shared references
const plain = message => message.replace(/^\$\[0\](?:\.|: )?/, '')   // a one-unit document's errors, without their position
// Code-unit order, as the validator compares IDs (never localeCompare: it orders mixed case and percent signs differently).
export const byId = (a, b) => (a.coverage_id < b.coverage_id ? -1 : a.coverage_id > b.coverage_id ? 1 : 0)
const fail = (summary, problems = []) => { throw Object.assign(new Error(summary), { problems: problems.slice(0, MAX_PROBLEMS) }) }

// ---------- the one write path ----------
// Writes `ledger` to <runDir>/coverage-ledger.json if, and only if, upstream's validator passes it. `beforePublish` runs after
// the ledger has passed and before it replaces the old one, so a refusal leaves every file as it was.
export function commitLedger(runDir, ledger, beforePublish = () => {}) {
  const file = join(runDir, LEDGER_FILE), candidate = `${file}.candidate`
  if (!Array.isArray(ledger)) fail(`a ledger is an array of units; ${LEDGER_FILE} is unchanged`)
  const sorted = clone([...ledger].sort(byId))
  const errors = validateLedgerDocument(sorted)
  if (errors.length) fail(`the ledger would not pass upstream's validator (${errors.length} error(s)); ${LEDGER_FILE} is unchanged`, errors)
  writeJson(candidate, sorted)
  try {
    const r = validateLedgerFile(candidate)   // the CLI is the authority: it also reads the bytes (5 MiB, nesting, UTF-8)
    if (!r.valid) fail(`upstream's validate-coverage-ledger.cjs said "${r.lastLine}" (exit ${r.exitCode}); ${LEDGER_FILE} is unchanged`)
    beforePublish()
    renameSync(candidate, file)
  } finally {
    rmSync(candidate, { force: true })
  }
}

function writeText(file, text) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

// `step` may run only when `audit-run.mjs next` names it (so a stage cannot be applied twice or out of order).
function expectStep(run, step) {
  const next = nextStep(run)
  if (next.step !== step) refuse(`${step} is not the next step of this run: ${formatNext(next)}`)
  return next
}

function finish(runDir, step, started, counts, state = {}, extra = {}) {
  advanceState(runDir, step, state)
  appendEvent(runDir, { cmd: step, stage: step, result: 'ok', duration_ms: Date.now() - started, counts, ...extra })
}

const readQueue = runDir => readJson(join(runDir, 'uncovered.json')) ?? []   // gaps hunters reported, waiting for mint

// ---------- units ----------
const within = (p, dir) => p === dir || p.startsWith(`${dir}/`)
const inScope = (paths, scope) => scope.length === 0 || paths.some(p => scope.some(s => within(p, s) || within(s, p)))

// The ID upstream's own encoder gives these refs, or the validator's field-level reasons it will not.
function mintId(input) {
  try { return { id: canonicalCoverageId(input.canonical_refs) } } catch (e) {
    const named = validateLedgerDocument([clone({ ...input, coverage_id: 'x' })]).filter(m => m.includes('canonical_refs'))
    return { problems: named.length ? named.map(plain) : [e.message] }
  }
}

// One ledger unit from a recon or mint entry: { unit } or { problems }. The entry names the work (labels, canonical_refs,
// paths, blocks, priority); this adds the unit's start state. A planned unit outside the run's scope is recorded out_of_scope,
// never planned (SKILL.md: "record everything else as out_of_scope"). Upstream's validator judges the finished unit.
export function unitFromInput(input, ctx) {
  if (!isObj(input)) return { problems: ['is not an object'] }
  const problems = []
  let status = input.status === undefined ? 'planned' : input.status
  if (!SEED_STATES.includes(status)) problems.push(`status ${JSON.stringify(status)} is not one of ${SEED_STATES.join(', ')}: a unit starts untouched`)
  else if (status !== 'planned' && !isText(input.reason)) problems.push(`a ${status} unit needs a reason`)
  const priority = input.priority_class ?? 4
  if (!(Number.isInteger(priority) && priority >= 1 && priority <= 4)) problems.push('priority_class must be an integer from 1 to 4')
  const minted = mintId(input)
  if (minted.problems) problems.push(...minted.problems)
  const paths = Array.isArray(input.starting_paths) ? input.starting_paths : []
  for (const p of paths) {
    if (!ctx.skipPathCheck && typeof p === 'string' && isSafeRelativePath(p) && !existsSync(join(ctx.runDir, 'tree', p))) problems.push(`starting path ${p} is not in tree/ (the audited snapshot)`)
  }
  if (problems.length) return { problems }
  let unresolved = status === 'planned' ? [] : [input.reason]
  if (status === 'planned' && paths.every(p => typeof p === 'string') && !inScope(paths, ctx.scope)) {
    status = 'out_of_scope'
    unresolved = [isText(input.reason) ? input.reason : 'outside this run\'s scope_paths']
  }
  const unit = {
    coverage_id: minted.id, canonical_refs: input.canonical_refs,
    surface: input.surface, boundary: input.boundary, subsystem: input.subsystem, attack_class: input.attack_class,
    ...(input.lifecycle !== undefined && { lifecycle: input.lifecycle }),
    starting_paths: input.starting_paths, ordinary_attack_class_block: input.ordinary_attack_class_block,
    selected_companion_blocks: input.selected_companion_blocks, excluded_blocks: input.excluded_blocks,
    prior_status: ctx.priorStatus, attempts: [], wave: 1, status, agent_id: null,
    reviewed_paths: [], local_checks: [], result_fingerprints: [], unresolved,
    priority_class: priority, ...(typeof input.priority_why === 'string' && { priority_why: input.priority_why }),
  }
  const errors = validateLedgerDocument([clone(unit)]).map(plain)
  return errors.length ? { problems: errors } : { unit }
}

// ---------- seed ----------
const wordCount = text => text.trim().split(/\s+/).length

export function seed(runDir, input) {
  const started = Date.now()
  const run = loadRun(runDir)
  expectStep(run, 'seed')
  const notes = []
  const priors = loadPriors(runDir, notes)
  const ctx = { runDir, scope: run.meta.scope_paths, priorStatus: priors.length ? 'new' : 'none' }
  const problems = []
  if (!isObj(input)) fail('recon.json must be an object { architecture_md, units }')
  if (!isText(input.architecture_md)) problems.push('architecture_md is missing')
  else if (wordCount(input.architecture_md) > ARCHITECTURE_WORD_CAP) problems.push(`architecture_md has ${wordCount(input.architecture_md)} words; upstream's cap is about 1,000 (refused above ${ARCHITECTURE_WORD_CAP})`)
  if (!Array.isArray(input.units) || input.units.length === 0) problems.push('units must be a non-empty array')
  const units = [], firstOf = new Map()
  ;(Array.isArray(input.units) ? input.units : []).forEach((entry, i) => {
    const label = `unit ${i} (${JSON.stringify(String(entry?.surface ?? '').slice(0, 60))})`
    const built = unitFromInput(entry, ctx)
    if (built.problems) return problems.push(...built.problems.map(m => `${label}: ${m}`))
    const dup = firstOf.get(built.unit.coverage_id)
    if (dup !== undefined) return problems.push(`${label}: coverage_id is already unit ${dup}'s (a duplicate or a canonical identity collision); upstream never merges them`)
    firstOf.set(built.unit.coverage_id, i)
    units.push(built.unit)
  })
  if (problems.length) fail(`seed refused: ${problems.length} problem(s); nothing was written`, problems)
  const carry = carryForward(run.meta, priors, units, ctx)
  commitLedger(runDir, carry.units, () => {
    writeText(join(runDir, 'architecture.md'), `${input.architecture_md.trim()}\n`)
    writeJson(join(runDir, 'candidates.json'), carry.pool)   // a seed starts the pool: only carried records can be in it
  })
  const counts = countStatuses(carry.units)
  finish(runDir, 'seed', started, counts, {}, { carry: carry.counts })
  return { summary: `units=${carry.units.length} ${Object.entries(counts).filter(([, n]) => n).map(([s, n]) => `${s}=${n}`).join(' ')}${priors.length ? ` earlier_runs=${priors.length} carried_records=${carry.pool.length}` : ''}`, notes: [...notes, ...carry.notes] }
}

// ---------- plan-wave ----------
// Rank, upstream's order (HUNTING.md "Phase 2"): the synthesizer's priority_class (criteria 1, 2 and 4: lowest-trust surface,
// most valuable resource, productive class), then prior-run gaps and changed source before same-source re-passes (criterion 3),
// ties by coverage_id. Upstream interleaves criterion 3 between 2 and 4; one priority_class cannot, so criterion 3 follows it.
const PRIOR_GAPS = ['prior_deferred', 'prior_blocked', 'prior_out_of_scope', 'prior_confirmed_changed_source', 'prior_covered_changed_source', 'prior_rejected_claim_changed']
const priorRank = s => (PRIOR_GAPS.includes(s) ? 0 : s === 'prior_covered_same_source' ? 2 : 1)
// A planned unit carrying a prior record belongs to its Phase 3 verifier, not a hunter (audit-run.mjs `next` says the same).
export const isHunterWork = u => u.status === 'planned' && !CARRIED.includes(u.prior_status)
export const rankUnits = units => [...units].sort((a, b) => (a.priority_class ?? 4) - (b.priority_class ?? 4) || priorRank(a.prior_status) - priorRank(b.prior_status) || byId(a, b))

// Closely related units (one subsystem) share a hunter, at most `perHunter` each; hunters are ordered by their best unit.
export function groupIntoHunters(ranked, perHunter) {
  const position = new Map(ranked.map((u, i) => [u.coverage_id, i]))
  const bySubsystem = new Map()
  for (const u of ranked) bySubsystem.set(u.canonical_refs.subsystem, [...(bySubsystem.get(u.canonical_refs.subsystem) ?? []), u])
  const groups = []
  for (const list of bySubsystem.values()) for (let i = 0; i < list.length; i += perHunter) groups.push(list.slice(i, i + perHunter))
  return groups.sort((a, b) => position.get(a[0].coverage_id) - position.get(b[0].coverage_id))
}

export const hunterId = (wave, n) => `h${wave}-${String(n).padStart(2, '0')}`   // matches upstream's agent ID pattern; wave-unique, so fresh

export function planWave(runDir) {
  const started = Date.now()
  const run = loadRun(runDir)
  const { wave } = expectStep(run, 'plan-wave')
  const { meta, ledger } = run
  const work = rankUnits(ledger.filter(isHunterWork))
  const allowance = meta.budget === null ? { hunters: Infinity, reason: null } : waveAllowance(meta.profile, meta.budget - meta.agents_spent)
  const patched = new Map()
  let hunters = []
  if (allowance.hunters === 0) {
    // Upstream: launch no hunter from this wave and defer its planned units (HUNTING.md, "A budget bounds it the same way").
    for (const u of work) patched.set(u.coverage_id, { ...u, status: 'deferred', agent_id: null, unresolved: [allowance.reason] })
  } else {
    const groups = groupIntoHunters(work, meta.limits.max_units_per_hunter)
    hunters = groups.slice(0, allowance.hunters).map((units, i) => ({ agent_id: hunterId(wave, i + 1), units }))
    const rank = new Map(work.map((u, i) => [u.coverage_id, i + 1]))
    for (const h of hunters) {
      for (const u of h.units) {
        const basis = `priority_class ${u.priority_class ?? 4}, prior_status ${u.prior_status}`
        const budgeted = `${hunters.length} of ${groups.length} hunter(s) fit the budget`
        patched.set(u.coverage_id, { ...u, status: 'in_progress', agent_id: h.agent_id, wave, last_assignment: `wave ${wave} ${h.agent_id}: rank ${rank.get(u.coverage_id)} of ${work.length} (${basis}); ${budgeted}` })
      }
    }
  }
  const next = ledger.map(u => patched.get(u.coverage_id) ?? u)
  commitLedger(runDir, next)
  const deferred = allowance.hunters === 0 ? work.length : 0
  const assigned = hunters.reduce((n, h) => n + h.units.length, 0)
  finish(runDir, 'plan-wave', started, { hunters: hunters.length, assigned, deferred, still_planned: work.length - assigned - deferred }, { wave },
    { reason: deferred ? allowance.reason : null, wave, assignments: hunters.map(h => ({ agent_id: h.agent_id, coverage_ids: h.units.map(u => u.coverage_id) })) })
  return { summary: `wave=${wave} hunters=${hunters.length} assigned=${assigned} deferred=${deferred}${deferred ? ` reason=${allowance.reason}` : ''}`, notes: [] }
}

// ---------- merge-wave ----------
const DISPOSITIONS = ['covered', 'candidate', 'blocked']    // a hunter's result.units[].disposition, which is the ledger's status

// The unit after a hunter's result for it, or a reason it cannot be. Only a v1 source check is accepted: no sandbox exists, so no
// local artifact can have been promoted (plan section 6). The check owner must be the hunter: its checks are its own.
function applyUnitResult(unit, entry, candidates) {
  if (!isObj(entry)) return { reason: 'the result has no entry for this unit' }
  if (!DISPOSITIONS.includes(entry.disposition)) return { reason: `disposition ${JSON.stringify(entry.disposition)} is not ${DISPOSITIONS.join(', ')}` }
  const checks = (Array.isArray(entry.checks) ? entry.checks : []).map(c => ({ agent_id: c?.agent_id, reviewed_paths: c?.reviewed_paths, invariant: c?.invariant, method: c?.method, result: c?.result, artifact: c?.artifact }))
  if (checks.some(c => c.method !== 'source')) return { reason: 'a check is not method "source" (no sandbox, so no local artifact can be promoted)' }
  if (checks.some(c => c.agent_id !== unit.agent_id)) return { reason: `a check is not owned by the assigned hunter ${unit.agent_id}` }
  const linked = entry.candidate_fingerprints ?? []
  if (Array.isArray(linked) && linked.some(f => !candidates.has(f))) return { reason: 'a linked fingerprint has no valid entry in the result\'s candidates' }
  const merged = {
    ...unit, status: entry.disposition, reviewed_paths: entry.reviewed_paths, local_checks: checks,
    result_fingerprints: linked, unresolved: entry.unresolved ?? [],
  }
  const errors = validateLedgerDocument([clone(merged)]).map(plain)
  return errors.length ? { reason: `upstream's validator: ${errors.slice(0, 2).join('; ')}` } : { unit: merged }
}

// A hunter's candidates by fingerprint: only schema-shaped-enough entries (the validate stage checks the record against its branch).
function candidateIndex(result) {
  const index = new Map()
  for (const c of result.candidates) {
    if (isObj(c) && typeof c.fingerprint === 'string' && VERDICTS.includes(c.proposed_verdict) && !Object.hasOwn(c, 'verdict') && !index.has(c.fingerprint)) index.set(c.fingerprint, c)
  }
  return index
}

// A unit whose result failed returns to planned for reassignment (HUNTING.md); counted, and deferred with a stated reason when it
// has failed MAX_UNIT_ATTEMPTS times, so a unit that no hunter can answer cannot loop forever. `unit` is the in_progress unit the
// wave assigned, which has no evidence and nothing unresolved, so only its owner and status change.
function returnToPlanned(unit, reason) {
  const failed = (unit.failed_attempts ?? 0) + 1
  const back = { ...unit, agent_id: null, failed_attempts: failed, last_failure: reason }
  return failed >= MAX_UNIT_ATTEMPTS ? { ...back, status: 'deferred', unresolved: [FAILED_TWICE] } : { ...back, status: 'planned' }
}

const uncoveredKey = e => JSON.stringify([e.surface, e.boundary, e.subsystem, e.attack_class])
const validUncovered = e => isObj(e) && ['surface', 'boundary', 'subsystem', 'attack_class', 'reason'].every(k => isText(e[k])) && Array.isArray(e.starting_paths) && e.starting_paths.every(isText)

export function mergeWave(runDir, results) {
  const started = Date.now()
  const run = loadRun(runDir)
  expectStep(run, 'merge-wave')
  const { ledger, state } = run
  const assigned = ledger.filter(u => u.status === 'in_progress')
  if (assigned.length === 0) {   // an earlier merge saved the ledger and died before saving its step: finish the step
    finish(runDir, 'merge-wave', started, { merged: 0, failed: 0 }, {}, { reason: 'already merged' })
    return { summary: 'nothing in_progress: the wave was already merged; step saved', notes: [] }
  }
  if (!isObj(results)) refuse('hunter results must be a JSON object keyed by hunter agent ID')
  const hunters = new Map()
  for (const u of assigned) hunters.set(u.agent_id, [...(hunters.get(u.agent_id) ?? []), u])
  const unknown = Object.keys(results).filter(id => !hunters.has(id))
  if (unknown.length) refuse(`results for hunter(s) this wave did not plan: ${unknown.join(', ')}`)

  const patched = new Map(), notes = [], newCandidates = [], queued = []
  const tally = { merged: 0, failed: 0, deferred: 0, ignored_entries: 0, orphan_candidates: 0, dropped_uncovered: 0 }
  for (const [agent, units] of hunters) {
    const result = Object.hasOwn(results, agent) ? results[agent] : null
    const shaped = isObj(result) && ['units', 'candidates', 'hardening', 'uncovered'].every(k => Array.isArray(result[k]))
    const entries = shaped ? result.units.filter(isObj) : []
    const candidates = shaped ? candidateIndex(result) : new Map()
    const mine = new Set(units.map(u => u.coverage_id))
    const stray = entries.filter(e => !mine.has(e.coverage_id)).length
    if (stray) notes.push(`${agent}: ${stray} result entr${stray === 1 ? 'y' : 'ies'} for units it was not assigned, ignored`)
    tally.ignored_entries += stray
    const done = []
    for (const unit of units) {
      const matches = entries.filter(e => e.coverage_id === unit.coverage_id)
      const outcome = !shaped ? { reason: 'no result, or not { units, candidates, hardening, uncovered } arrays' } : matches.length !== 1 ? { reason: `the result lists this unit ${matches.length} times, not once` } : applyUnitResult(unit, matches[0], candidates)
      if (outcome.unit) { done.push(outcome.unit); continue }
      const back = returnToPlanned(unit, outcome.reason)
      patched.set(unit.coverage_id, back)
      tally[back.status === 'deferred' ? 'deferred' : 'failed'] += 1
      notes.push(`${unit.coverage_id} (${agent}): ${outcome.reason}; ${back.status}`)
    }
    done.sort(byId)
    done.forEach((unit, i) => {
      const hardening = i === 0 ? result.hardening.filter(isText).slice(0, MAX_HARDENING).map(t => t.slice(0, MAX_HARDENING_CHARS)) : []
      patched.set(unit.coverage_id, hardening.length ? { ...unit, hardening: [...(unit.hardening ?? []), ...hardening].slice(0, MAX_HARDENING) } : unit)
      for (const f of unit.result_fingerprints) newCandidates.push({ fingerprint: f, agent, coverage_id: unit.coverage_id, entry: candidates.get(f) })
    })
    tally.merged += done.length
    if (shaped && done.length) {
      tally.orphan_candidates += candidates.size - new Set(done.flatMap(u => u.result_fingerprints)).size
      for (const e of result.uncovered) validUncovered(e) ? queued.push({ ...clone(e), hunter_id: agent, wave: state.wave }) : (tally.dropped_uncovered += 1)
    }
  }
  const pool = mergeCandidates(readJson(join(runDir, 'candidates.json')) ?? [], newCandidates)
  const queue = readQueue(runDir)
  const seen = new Set(queue.map(uncoveredKey))
  for (const e of queued) if (!seen.has(uncoveredKey(e))) { seen.add(uncoveredKey(e)); queue.push(e) }
  commitLedger(runDir, ledger.map(u => patched.get(u.coverage_id) ?? u), () => {
    writeJson(join(runDir, 'candidates.json'), pool)
    writeJson(join(runDir, 'uncovered.json'), queue)
  })
  finish(runDir, 'merge-wave', started, { ...tally, candidates: pool.length, uncovered_queued: queue.length }, {}, { wave: state.wave })
  return { summary: `wave=${state.wave} merged=${tally.merged} failed=${tally.failed} deferred=${tally.deferred} candidates=${pool.length} uncovered_queued=${queue.length}`, notes }
}

// candidates.json: { fingerprint, proposed_verdict, hunter_ids, units, record }, sorted by fingerprint. An exact-fingerprint
// duplicate is one candidate with every linking unit and hunter recorded; the first record is kept (consolidation by root cause
// is the consolidate stage's). Re-adding the same link changes nothing, so a merge that is run again is harmless.
function mergeCandidates(existing, found) {
  const byFingerprint = new Map(existing.map(c => [c.fingerprint, c]))
  for (const { fingerprint, agent, coverage_id, entry } of found) {
    const have = byFingerprint.get(fingerprint)
    if (!have) {
      const { proposed_verdict, ...record } = clone(entry)
      byFingerprint.set(fingerprint, { fingerprint, proposed_verdict, hunter_ids: [agent], units: [coverage_id], record })
    } else {
      byFingerprint.set(fingerprint, { ...have, hunter_ids: [...new Set([...have.hunter_ids, agent])], units: [...new Set([...have.units, coverage_id])].sort() })
    }
  }
  return [...byFingerprint.values()].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1))
}

// ---------- apply-critic ----------
const ARCHIVABLE = ['blocked', 'covered', 'candidate']   // RECONNAISSANCE.md: only these states can be archived in attempts
const LIVE_EVIDENCE = { agent_id: null, reviewed_paths: [], local_checks: [], result_fingerprints: [], unresolved: [] }
const semanticOf = u => JSON.stringify([u.surface, u.boundary, u.subsystem, u.attack_class, u.lifecycle ?? null])

function criticProblems(critic, mint) {
  const p = []
  if (!isObj(critic)) return ['the critic result is not a JSON object (a critic result wrapped in prose is not one)']
  for (const k of ['missing_units', 'reassign_ids', 'resolved_prior_leads']) if (!Array.isArray(critic[k])) p.push(`critic.${k} must be an array`)
  if (typeof critic.stop !== 'boolean') p.push('critic.stop must be true or false')
  for (const k of ['reassign_ids', 'resolved_prior_leads']) if (Array.isArray(critic[k]) && !critic[k].every(isText)) p.push(`critic.${k} must hold non-empty strings`)
  if (!isObj(mint) || !Array.isArray(mint.units)) p.push('mint.json must be an object { units: [...] }')
  return p
}

// The unit after the critic reopened it: its terminal state archived exactly as upstream lists the fields, the live state
// empty and unassigned, the wave one higher (RECONNAISSANCE.md "attempts"). The next owner is fresh because plan-wave names
// hunters by wave. A unit's failure count starts over with its new assignment.
function reassign(unit, reason) {
  const { failed_attempts, last_failure, ...rest } = unit
  const { wave, status, agent_id, reviewed_paths, local_checks, result_fingerprints, unresolved } = unit
  const attempt = clone({ wave, status, agent_id, reviewed_paths, local_checks, result_fingerprints, unresolved, reassignment_reason: reason })
  return { ...rest, ...LIVE_EVIDENCE, attempts: [...unit.attempts, attempt], wave: wave + 1, status: 'planned' }
}

// The critic's `reassign_ids` carry no per-unit reason (HUNTING.md's JSON, which a critic must return exactly), though
// RECONNAISSANCE.md asks for "the critic's source-backed reassignment_reason": the archive says so instead of inventing one.
export function applyCritic(runDir, critic, mint) {
  const started = Date.now()
  const run = loadRun(runDir)
  expectStep(run, 'apply-critic')
  const { meta, state, ledger } = run
  if (state.critic_kind === null) refuse('a critic result is being applied but stage-state.json has no critic_kind')
  const problems = criticProblems(critic, mint)
  const queue = readQueue(runDir)
  const proposals = isObj(critic) && Array.isArray(critic.missing_units) ? critic.missing_units.length + queue.length : 0
  if (!problems.length && mint.units.length > proposals) problems.push(`mint returned ${mint.units.length} unit(s) for ${proposals} proposal(s): a unit comes from a proposal`)
  if (problems.length) fail(`apply-critic refused: ${problems.length} problem(s); nothing was changed`, problems)

  const by = `${state.critic_kind} critic of wave ${state.wave}`
  const notes = [], patched = new Map(), fresh = []
  const tally = { reassigned: 0, reassign_rejected: 0, units_added: 0, out_of_scope: 0, duplicates: 0, minted_rejected: 0, resolved: 0, resolved_unknown: 0, dropped_proposals: proposals - mint.units.length }
  if (tally.dropped_proposals) notes.push(`${tally.dropped_proposals} proposal(s) (critic missing_units and queued uncovered) were not minted into a unit; they are dropped`)
  const current = new Map(ledger.map(u => [u.coverage_id, u]))
  for (const id of new Set(critic.reassign_ids)) {
    const unit = current.get(id)
    if (!unit || !ARCHIVABLE.includes(unit.status)) {
      notes.push(`reassign ${id}: ${unit ? `status ${unit.status} has no live evidence to archive` : 'no such unit'}; not applied`)
      tally.reassign_rejected += 1
      continue
    }
    patched.set(id, reassign(unit, `the ${by} listed this unit in reassign_ids; the critic result gives no per-unit reason`))
    tally.reassigned += 1
  }
  const ctx = { runDir, scope: meta.scope_paths, priorStatus: ledger.some(u => u.prior_status !== 'none') ? 'new' : 'none' }   // seed decided whether earlier runs exist
  mint.units.forEach((entry, i) => {
    const built = isObj(entry) && entry.status !== undefined && entry.status !== 'planned' ? { problems: [`status ${JSON.stringify(entry.status)}: a minted unit is planned work; scope and budget decide anything else`] } : unitFromInput(entry, ctx)
    if (built.problems) { tally.minted_rejected += 1; return notes.push(`minted unit ${i}: ${built.problems.join('; ')}; rejected`) }
    const have = current.get(built.unit.coverage_id) ?? fresh.find(u => u.coverage_id === built.unit.coverage_id)
    if (have && semanticOf(have) !== semanticOf(built.unit)) fail(`coverage ID collision: minted unit ${i} has the ID of a unit with different semantic fields; upstream never merges them (${LEDGER_FILE} is unchanged)`, [built.unit.coverage_id])
    if (have) { tally.duplicates += 1; return notes.push(`minted unit ${i}: ${built.unit.coverage_id} is already in the ledger; not added again`) }
    fresh.push(built.unit)
    tally[built.unit.status === 'out_of_scope' ? 'out_of_scope' : 'units_added'] += 1
  })
  for (const fingerprint of new Set(critic.resolved_prior_leads)) {
    const linked = ledger.filter(u => (u.prior_leads ?? []).some(l => l.fingerprint === fingerprint))
    if (!linked.length) { tally.resolved_unknown += 1; notes.push(`resolved_prior_leads ${fingerprint}: not a prior lead of any unit; not applied`); continue }
    for (const u of linked) {
      const base = patched.get(u.coverage_id) ?? u
      patched.set(u.coverage_id, { ...base, prior_leads: base.prior_leads.map(l => (l.fingerprint === fingerprint ? { ...l, resolved: { by, wave: state.wave } } : l)) })
    }
    tally.resolved += 1
  }
  commitLedger(runDir, [...ledger.map(u => patched.get(u.coverage_id) ?? u), ...fresh], () => writeJson(join(runDir, 'uncovered.json'), []))
  finish(runDir, 'apply-critic', started, tally, {}, { wave: state.wave, critic_kind: state.critic_kind, critic_stop: critic.stop })
  return { summary: `wave=${state.wave} kind=${state.critic_kind} units_added=${tally.units_added} out_of_scope=${tally.out_of_scope} reassigned=${tally.reassigned} resolved=${tally.resolved} rejected=${tally.reassign_rejected + tally.minted_rejected}`, notes }
}

// ---------- carry-forward ----------
// What an earlier run contributes (SKILL.md "Coverage and prior runs"; RECONNAISSANCE.md "Prior-run input"). Evidence is
// carried only while `git diff --quiet` says the source it rests on is byte for byte the same; stale evidence is invalidated,
// never reused. A prior ledger absent from this run's seeding is added back, so no prior lead vanishes.
const COMMIT_ID = /^([0-9a-f]{40}|[0-9a-f]{64})$/
const PATHS_PER_DIFF = 200
const diffCache = new Map()

// True only when every path holds the same bytes in both commits. Anything else is "changed": a different file, a commit this
// clone lacks, an unreadable repository, an empty path list (which git would read as the whole tree), a value that is not a
// commit ID (a prior run's metadata is not trusted: "--output=x" must never reach git as an option). Paths are literal: a name
// with [ or * is that name, not a pattern. No external diff driver or textconv runs.
export function sourceUnchanged(top, priorCommit, headCommit, paths) {
  const list = [...new Set(paths)].filter(p => typeof p === 'string' && p !== '')
  if (list.length === 0 || !COMMIT_ID.test(priorCommit) || !COMMIT_ID.test(headCommit)) return false
  const key = JSON.stringify([top, priorCommit, headCommit, list])
  if (!diffCache.has(key)) {
    let same = true
    for (let i = 0; same && i < list.length; i += PATHS_PER_DIFF) {
      same = git(top, ['--literal-pathspecs', 'diff', '--quiet', '--no-ext-diff', '--no-textconv', priorCommit, headCommit, '--', ...list.slice(i, i + PATHS_PER_DIFF)]).status === 0
    }
    diffCache.set(key, same)
  }
  return diffCache.get(key)
}

// Each earlier run recorded as compatible at init, checked again with upstream's validators (its files may have changed since),
// with its ledger and its findings by fingerprint. A run that no longer validates is skipped and said, never read as empty.
export function loadPriors(runDir, notes = []) {
  const listed = readJson(join(runDir, 'prior-runs.json')) ?? []
  const priors = []
  for (const p of Array.isArray(listed) ? listed.filter(e => isObj(e) && e.compatible === true && isText(e.path)) : []) {
    const ledgerFile = join(p.path, LEDGER_FILE), findingsFile = join(p.path, 'findings.json')
    const ledger = validateLedgerFile(ledgerFile).valid ? readJson(ledgerFile) : undefined
    const hasFindings = existsSync(findingsFile)
    const findings = hasFindings ? (validateFindingsFile(findingsFile).valid ? readJson(findingsFile) : undefined) : []
    if (!Array.isArray(ledger) || !Array.isArray(findings)) { notes.push(`earlier run ${p.run_id} no longer validates; it is skipped, not treated as empty coverage`); continue }
    priors.push({ run_id: p.run_id, commit: p.source_commit, ledger, records: new Map(findings.map(r => [r.fingerprint, r])) })
  }
  return priors
}

const fileOfRef = ref => String(ref).split('#')[0]
const unitPaths = u => [...u.reviewed_paths, ...u.starting_paths, fileOfRef(u.canonical_refs.boundary)]
const recordPaths = r => [...(r.trace ?? []), ...(r.evidence ?? [])].map(e => e?.file)

// A prior unit's prior_status, from its records first (a confirmed or needs_validation record whose source changed is work, not
// something to carry), then from its state. Upstream's list has no label for a needs_validation lead whose source changed or for a
// unit never reached: prior_blocked and prior_deferred are the nearest, and the real reason stays in prior_invalidated.
function priorLabel(unit, same, leads) {
  const has = (verdict, unchanged) => leads.some(l => l.record.verdict === verdict && l.same === unchanged)
  if (has('confirmed', false)) return 'prior_confirmed_changed_source'
  if (has('needs_validation', false)) return 'prior_blocked'
  if (has('confirmed', true)) return 'prior_confirmed_same_source'
  if (has('needs_validation', true)) return 'prior_needs_validation'
  const rejected = leads.filter(l => l.record.verdict === 'rejected')
  if (rejected.length) return rejected.every(l => l.same) ? 'prior_covered_same_source' : 'prior_rejected_claim_changed'
  return { blocked: 'prior_blocked', deferred: 'prior_deferred', out_of_scope: 'prior_out_of_scope', planned: 'prior_deferred', in_progress: 'prior_deferred' }[unit.status] ?? (same ? 'prior_covered_same_source' : 'prior_covered_changed_source')
}

// The current unit with what this prior unit adds: its prior_status, same-source coverage evidence (bookkeeping: a planned unit has
// none of its own; the fingerprints it linked are in prior_leads, each marked carried or not), the claims an unchanged rejection
// suppresses, and why changed evidence was dropped.
function withPrior(unit, prior, was, top, head) {
  const same = sourceUnchanged(top, prior.commit, head, unitPaths(was))
  const fingerprints = [...new Set([...was.result_fingerprints, ...was.attempts.flatMap(a => a.result_fingerprints)])]
  const leads = fingerprints.map(f => prior.records.get(f)).filter(Boolean).map(record => ({ record, same: same && sourceUnchanged(top, prior.commit, head, recordPaths(record)) }))
  const carry = unit.status === 'planned' ? leads.filter(l => l.same && VERDICTS.includes(l.record.verdict)) : []
  const stale = leads.filter(l => !l.same && l.record.verdict !== 'rejected').map(l => l.record.fingerprint)
  const evidence = same && ARCHIVABLE.includes(was.status)
  const staleUnit = !same && ARCHIVABLE.includes(was.status)
  const out = {
    ...unit, prior_status: priorLabel(was, same, leads),
    ...(evidence && { prior_evidence: clone({ run_id: prior.run_id, commit: prior.commit, wave: was.wave, status: was.status, reviewed_paths: was.reviewed_paths, local_checks: was.local_checks, unresolved: was.unresolved }) }),
    ...((staleUnit || stale.length) && { prior_invalidated: { run_id: prior.run_id, commit: prior.commit, reason: 'the source it rests on changed (git diff against this run\'s commit)', fingerprints: stale } }),
    ...(leads.some(l => VERDICTS.includes(l.record.verdict)) && { prior_leads: leads.filter(l => VERDICTS.includes(l.record.verdict)).map(l => ({ fingerprint: l.record.fingerprint, verdict: l.record.verdict, carried: carry.includes(l) })) }),
    ...(carry.some(l => l.record.verdict === 'confirmed') && { carried_exclusions: carry.filter(l => l.record.verdict === 'confirmed').map(l => ({ fingerprint: l.record.fingerprint, title: l.record.title, root_cause: l.record.root_cause })) }),
    ...(leads.some(l => l.record.verdict === 'rejected' && l.same) && { suppressed_claims: leads.filter(l => l.record.verdict === 'rejected' && l.same).map(l => l.record.fingerprint) }),
  }
  const entries = carry.map(({ record }) => {
    const { verdict, ...rest } = clone(record)
    return { fingerprint: record.fingerprint, proposed_verdict: verdict, hunter_ids: [], units: [unit.coverage_id], record: rest, carried_from: { run_id: prior.run_id, commit: prior.commit } }
  })
  return { unit: out, entries, stale: stale.length, evidence: evidence ? 1 : 0 }
}

// A prior unit this run's recon did not seed, as a unit of this run: planned work (never dropped), or not_applicable when none of
// its paths is in the snapshot any more, or out_of_scope when this run's scope excludes it.
function forceAdd(was, prior, ctx) {
  const present = was.starting_paths.filter(p => existsSync(join(ctx.runDir, 'tree', p)))
  const gone = present.length === 0
  const input = {
    canonical_refs: was.canonical_refs, surface: was.surface, boundary: was.boundary, subsystem: was.subsystem, attack_class: was.attack_class,
    ...(was.lifecycle !== undefined && { lifecycle: was.lifecycle }), starting_paths: gone ? was.starting_paths : present,
    ordinary_attack_class_block: was.ordinary_attack_class_block, selected_companion_blocks: was.selected_companion_blocks, excluded_blocks: was.excluded_blocks,
    priority_class: was.priority_class ?? 4, ...(typeof was.priority_why === 'string' && { priority_why: was.priority_why }),
    ...(gone && { status: 'not_applicable', reason: `none of its starting paths is in the audited snapshot; it was a unit of earlier run ${prior.run_id}` }),
  }
  const built = unitFromInput(input, { ...ctx, skipPathCheck: gone })
  return built.unit ? { ...built.unit, force_added_from: prior.run_id } : null
}

// The seeded units with every usable earlier run folded in, and the carried records for candidates.json. Later runs win a
// coverage_id they share. A unit this run's scope or recon made not-planned keeps that state: a record is carried only into a
// planned unit.
export function carryForward(meta, priors, seeded, ctx) {
  const notes = [], counts = { earlier_runs: priors.length, matched: 0, force_added: 0, records_carried: 0, records_stale: 0, evidence_kept: 0 }
  const units = new Map(seeded.map(u => [u.coverage_id, u]))
  const latest = new Map()
  for (const prior of priors) for (const was of prior.ledger) latest.set(was.coverage_id, { was, prior })
  const entries = []
  for (const { was, prior } of latest.values()) {
    if (was.status === 'not_applicable') continue   // a reasoned "does not apply" is not evidence; this run's recon decides again
    const base = units.get(was.coverage_id) ?? forceAdd(was, prior, ctx)
    if (!base) { notes.push(`earlier run ${prior.run_id}: unit ${was.coverage_id} could not be added to this run; it is not carried`); continue }
    counts[units.has(was.coverage_id) ? 'matched' : 'force_added'] += 1
    const carried = withPrior(base, prior, was, meta.target, meta.source_ref.commit)
    units.set(base.coverage_id, carried.unit)
    entries.push(...carried.entries)
    counts.records_stale += carried.stale
    counts.evidence_kept += carried.evidence
  }
  counts.records_carried = entries.length
  return { units: [...units.values()], pool: poolOf(entries), notes, counts }
}

// candidates.json entries, one per fingerprint, with every unit that carries it.
function poolOf(entries) {
  const byFingerprint = new Map()
  for (const e of entries) {
    const have = byFingerprint.get(e.fingerprint)
    byFingerprint.set(e.fingerprint, have ? { ...have, units: [...new Set([...have.units, ...e.units])].sort() } : e)
  }
  return [...byFingerprint.values()].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1))
}

// ---------- command line ----------
const USAGE = `usage: audit-ledger.mjs seed <run dir> <recon.json>
       audit-ledger.mjs plan-wave <run dir>
       audit-ledger.mjs merge-wave <run dir> <hunter-results.json>
       audit-ledger.mjs apply-critic <run dir> <critic.json> <mint.json>`
const COMMANDS = {
  seed: [1, seed], 'plan-wave': [0, planWave], 'merge-wave': [1, mergeWave], 'apply-critic': [2, applyCritic],
}

function inputFile(path) {
  const value = readJson(resolve(path))
  if (value === undefined) refuse(`${path} does not exist`)
  return value
}

export function main(argv) {
  const [cmd, runArg, ...files] = argv
  try {
    if (!Object.hasOwn(COMMANDS, cmd) || runArg === undefined || files.length !== COMMANDS[cmd][0]) throw new Usage()
    const out = COMMANDS[cmd][1](resolve(runArg), ...files.map(inputFile))
    for (const n of out.notes) console.log(`note: ${n}`)
    console.log(`AUDIT: OK ${cmd} ${out.summary}`)
    return 0
  } catch (e) {
    if (e instanceof Usage) { console.error(USAGE); return 2 }
    for (const p of e.problems ?? []) console.log(`ledger: ${p}`)
    console.log(`AUDIT: FAIL ${e.message}`)
    return 1
  }
}

// Run as a command, also through the ~/.claude/skills symlink install.sh makes.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
