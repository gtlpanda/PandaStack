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
import { advanceState, appendEvent, readJson, recordSpend, refuse, writeJson } from './audit-run.mjs'
import { commitLedger } from './audit-ledger.mjs'
import { CLIP, architectureOf, baseInput, blockText, clipText, clipValue, encodedSize } from './audit-inputs.mjs'
import { VERDICTS } from './audit-findings.mjs'

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const show = v => String(JSON.stringify(v)).slice(0, 80)
const text = v => (typeof v === 'string' ? clipText(v) : null)
const sortedUnique = list => [...new Set(list)].sort()

export const CANDIDATES_FILE = 'candidates.json'
export const CONSOLIDATION_FILE = 'consolidation.json'

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
