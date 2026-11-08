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
import { CARRIED, REASONS, Usage, advanceState, appendEvent, countStatuses, formatNext, loadRun, nextStep, readJson, refuse, waveAllowance, writeJson } from './audit-run.mjs'
import { canonicalCoverageId, isSafeRelativePath, validateLedgerDocument, validateLedgerFile } from './upstream.mjs'

export const LEDGER_FILE = 'coverage-ledger.json'
export const ARCHITECTURE_WORD_CAP = 1100          // RECONNAISSANCE.md: "a hard cap of about 1,000 words"; my reading of "about" is 10%
export const MAX_UNIT_ATTEMPTS = 2                 // PandaStack's: a hunter result that fails twice defers its unit (plan section 4.3)
export const FAILED_TWICE = 'hunter_result_invalid_twice'   // PandaStack's own reason string, not upstream's (so not in REASONS)
const MAX_PROBLEMS = 40
const MAX_HARDENING = 100                          // the validator rejects any nested array past 1,000 entries
const SEED_STATES = ['planned', 'not_applicable', 'out_of_scope', 'deferred']   // the states a unit can start in
const VERDICTS = ['confirmed', 'needs_validation']

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const clone = v => JSON.parse(JSON.stringify(v))   // what the file will hold: no undefined keys, no shared references
const plain = message => message.replace(/^\$\[0\]\.?/, '')   // a one-unit document's errors, without their position
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
    if (typeof p === 'string' && isSafeRelativePath(p) && !existsSync(join(ctx.runDir, 'tree', p))) problems.push(`starting path ${p} is not in tree/ (the audited snapshot)`)
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
  const ctx = { runDir, scope: run.meta.scope_paths, priorStatus: 'none' }
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
  commitLedger(runDir, units, () => writeText(join(runDir, 'architecture.md'), `${input.architecture_md.trim()}\n`))
  const counts = countStatuses(units)
  finish(runDir, 'seed', started, counts)
  return { summary: `units=${units.length} ${Object.entries(counts).filter(([, n]) => n).map(([s, n]) => `${s}=${n}`).join(' ')}`, notes: [] }
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
  if (entry.disposition !== 'candidate' && linked.length) return { reason: `only a candidate unit carries fingerprints (this one is ${entry.disposition})` }
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
// has failed MAX_UNIT_ATTEMPTS times, so a unit that no hunter can answer cannot loop forever.
function returnToPlanned(unit, reason) {
  const failed = (unit.failed_attempts ?? 0) + 1
  const back = { ...unit, agent_id: null, reviewed_paths: [], local_checks: [], result_fingerprints: [], failed_attempts: failed, last_failure: reason }
  return failed >= MAX_UNIT_ATTEMPTS ? { ...back, status: 'deferred', unresolved: [FAILED_TWICE] } : { ...back, status: 'planned', unresolved: [] }
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
      const hardening = i === 0 ? result.hardening.filter(isText).slice(0, MAX_HARDENING) : []
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
  const ctx = { runDir, scope: meta.scope_paths, priorStatus: 'none' }
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
