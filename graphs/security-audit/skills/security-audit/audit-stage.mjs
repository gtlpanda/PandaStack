#!/usr/bin/env node
// audit-stage.mjs - the session's side of one Workflow stage of a security-audit run: `plan` writes the stage's input and a
// runnable copy of the workflow, `apply` checks what the workflow returned and saves it. The workflow
// (workflows/security-audit-flow.js) has no filesystem, so everything that reads or writes a run file happens here.
//
//   node audit-stage.mjs plan  <run dir>
//   node audit-stage.mjs apply <run dir> <returned.json>     returned.json: what the Workflow tool returned, as JSON
//
// Both run only when `audit-run.mjs next` names a Workflow stage this version builds (recon, hunt, critic, mint), so a stage cannot be
// planned or applied out of order. A command's last line is "AUDIT: OK <cmd> ..." (exit 0) or "AUDIT: FAIL <reason>" (exit 1); bad usage is
// on stderr, exit 2.
//
// recon is two Workflow runs, because the file:line references the researchers return must be checked against tree/ before the
// synthesizer sees them, and the workflow cannot read tree/. `plan` picks the part from what is on disk: no recon-facts.json is
// the facts part (four researchers); with it, the synthesize part (one synthesizer reads the checked facts). `next` says `recon`
// both times. `apply` of the synthesize part writes recon.json, which `audit-ledger.mjs seed` takes, and saves the step.
//
// hunt, critic and mint are one Workflow run each. hunt writes hunter-results.json, which `audit-ledger.mjs merge-wave` takes; critic writes
// critic.json; mint writes mint.json, and critic.json and mint.json are what `audit-ledger.mjs apply-critic` takes. Each saves its step.
//
// A stage lives in stages/<NN>-<name>/: input.json and run.js (plan), result.json (apply, written last, so a stage without one
// is planned and not applied). Every effect of apply is idempotent and the step is saved last, so a crash leaves the step behind its
// effects, never ahead: applying the same result again finishes the stage, and changes nothing if it had finished.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REASONS, RUNNERS, Usage, advanceState, appendEvent, formatNext, loadRun, markIncomplete, nextStep, readJson, recordSpend, reconGate, refuse, writeJson } from './audit-run.mjs'
import { applyCriticProblems, criticBudgetExhausted, criticResultProblems, seedProblems, stopHunting } from './audit-ledger.mjs'
import { RECON_IDS, checkFacts } from './audit-facts.mjs'
import { BlockError, companions, ordinary, parts, resolve as resolveBlock } from './blocks.mjs'

// Found from the real file, so the install symlink (~/.claude/skills/security-audit) does not matter, as in upstream.mjs.
const REPO_ROOT = join(dirname(realpathSync(fileURLToPath(import.meta.url))), '..', '..', '..', '..')
export const WORKFLOW_FILE = join(REPO_ROOT, 'graphs', 'security-audit', 'workflows', 'security-audit-flow.js')
export const RUN_SCRIPT = join(REPO_ROOT, 'core', 'skills', 'workflow-state', 'run-script.mjs')
export const SEAM = 'INJECTED_INPUT'
// MEASURED (retro entry 38, headless claude 2.1.319): the Workflow tool refuses a script file over 524,288 bytes ("exceeds 524288
// bytes") and ran one of 478,136. A run script over this is refused here, with room to spare, never handed to the tool.
export const MAX_SCRIPT_BYTES = 500_000
// A synthesizer result seed would refuse is sent back once with the reasons (plan section 4.2: "bounded feedback retry"); a second refusal
// ends the run. The reason string is PandaStack's own (the plan, 4.3), not one of upstream's five.
export const MAX_SYNTH_ATTEMPTS = 2
export const LEDGER_FAILED = 'ledger_validation_failed'
const SEED_FEEDBACK = 'seed-feedback.json'
const MINT_FEEDBACK = 'mint-feedback.json'   // the same for a minter result apply-critic would refuse, kept per wave
const MAX_DROPPED_LISTED = 200
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const show = v => String(JSON.stringify(v)).slice(0, 80)

// ---------- stage directories ----------
const STAGE_NAME = /^([0-9]{2,})-([a-z0-9-]+)$/
const stagesDir = runDir => join(runDir, 'stages')

function listStages(runDir) {
  const dir = stagesDir(runDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && STAGE_NAME.test(e.name))
    .map(e => ({ name: e.name, seq: Number(STAGE_NAME.exec(e.name)[1]), label: STAGE_NAME.exec(e.name)[2], dir: join(dir, e.name), done: existsSync(join(dir, e.name, 'result.json')) }))
    .sort((a, b) => a.seq - b.seq)
}

// The newest stage, reused when it is this one and was never applied (a plan that ran twice); otherwise the next number.
function openStage(runDir, label) {
  const last = listStages(runDir).at(-1)
  if (last && !last.done && last.label === label) return last
  const name = `${String((last?.seq ?? 0) + 1).padStart(2, '0')}-${label}`
  const dir = join(stagesDir(runDir), name)
  mkdirSync(dir, { recursive: true })
  return { name, label, dir, done: false }
}

// ---------- plan ----------
const ARCH_SUMMARY = 'RECONNAISSANCE.md#Architecture summary and companion selection'
const LEDGER_SPEC = 'RECONNAISSANCE.md#Deterministic coverage ledger'
const RANKING = 'HUNTING.md#Phase 2: Run coverage-led hunting waves'

// What the synthesizer needs from the earlier runs, and no more: counts and, for each incompatible one, why. Bounded, since the reasons
// quote files that are not this run's.
function priorSummary(runDir) {
  const listed = readJson(join(runDir, 'prior-runs.json')) ?? []
  const runs = Array.isArray(listed) ? listed.filter(isObj) : []
  return {
    found: runs.length, compatible: runs.filter(r => r.compatible === true).length,
    incompatible: runs.filter(r => r.compatible !== true).slice(0, 5).map(r => ({ run_id: String(r.run_id).slice(0, 80), why: String(Array.isArray(r.reasons) ? r.reasons[0] : '').slice(0, 200) })),
  }
}

function readFacts(runDir) {
  const file = readJson(join(runDir, 'recon-facts.json'))
  const ok = isObj(file) && Array.isArray(file.facts) && file.facts.length === RECON_IDS.length && RECON_IDS.every((id, i) => isObj(file.facts[i]) && file.facts[i].agent === id && Array.isArray(file.facts[i].items) && Array.isArray(file.facts[i].limits))
  if (!ok) refuse('recon-facts.json is not what apply wrote (one {agent, items, limits} per researcher, in order); delete it to run the facts part again')
  return file.facts
}

// Every refused attempt recorded in `file`: { stage, scope?, problems } entries, one per stage (applying a stage again replaces its own entry, so it
// counts once). A mint attempt carries its scope, the wave and the kind of critic it follows ("1:post-wave"), so a later wave, and the final-clean
// critic's minter of the same wave, start with none.
function readAttempts(runDir, file) {
  const parsed = readJson(join(runDir, file))
  if (parsed === undefined) return []
  const ok = isObj(parsed) && Array.isArray(parsed.attempts) && parsed.attempts.every(a => isObj(a) && typeof a.stage === 'string' && (a.scope === undefined || typeof a.scope === 'string') && Array.isArray(a.problems) && a.problems.every(x => typeof x === 'string'))
  if (!ok) refuse(`${file} is not what apply wrote ({attempts: [{stage, scope?, problems: [text]}]}); delete it to forget the refused attempts`)
  return parsed.attempts
}
// What the next plan sends back to the agent: the last refused attempt (of this scope), or nothing.
function feedbackFor(runDir, file, scope) {
  const mine = readAttempts(runDir, file).filter(a => a.scope === scope)
  return mine.length ? { feedback: { attempt: mine.length, of: MAX_SYNTH_ATTEMPTS, problems: mine.at(-1).problems } } : {}
}

// The stage input for one part of recon: plain data, the text upstream's own files hold (blocks.mjs slices it, nothing here retypes it).
export function reconInput(runDir, meta, part) {
  const base = { stage: 'recon', part, tree: join(runDir, 'tree'), maxParallel: meta.limits.max_parallel, execution: { capability: meta.execution_capability, blockers: meta.execution_blockers } }
  const p = parts()
  if (part === 'facts') return { ...base, parts: Object.fromEntries(RECON_IDS.map(id => [`recon${id}`, p[`recon${id}`].text])) }
  return {
    ...base, profile: meta.profile, scope_paths: meta.scope_paths, prior: priorSummary(runDir), facts: readFacts(runDir), ...feedbackFor(runDir, SEED_FEEDBACK, undefined),
    parts: {
      ranking: resolveBlock(RANKING).text, architectureSummary: resolveBlock(ARCH_SUMMARY).text, ledger: resolveBlock(LEDGER_SPEC).text,
      registry: { ordinary: ordinary(), companions: companions().map(c => ({ file: c.file, whenToUse: resolveBlock(c.whenToUse).text, blocks: c.blocks })) },
    },
  }
}

// ---------- the wave stages' inputs ----------
const CRITIC_SECTION = 'HUNTING.md#Coverage-critic waves'
const HUNT_PARTS = ['hunterMethod', 'promotion', 'validationRules', 'hunterResult', 'schema_confirmed', 'schema_needs_validation']

function baseInput(runDir, meta, stage) {
  return { stage, part: stage, tree: join(runDir, 'tree'), maxParallel: meta.limits.max_parallel, execution: { capability: meta.execution_capability, blockers: meta.execution_blockers } }
}
function architectureOf(runDir) {
  const file = join(runDir, 'architecture.md')
  if (!existsSync(file)) refuse('architecture.md is missing: seed writes it')
  return readFileSync(file, 'utf8')
}
const blockText = ref => {
  try { return resolveBlock(ref).text } catch (e) { if (e instanceof BlockError) return refuse(`the ledger names a block that does not resolve: ${e.message}`); throw e }
}
// hunter IDs h<wave>-<NN>, in numeric order (so h1-100 follows h1-99)
const hunterOrder = id => { const m = /^h(\d+)-(\d+)$/.exec(id); return m ? [Number(m[1]), Number(m[2])] : [Infinity, 0] }
const byHunter = (a, b) => { const [x, y] = [hunterOrder(a.agent_id), hunterOrder(b.agent_id)]; return x[0] - y[0] || x[1] - y[1] || (a.agent_id < b.agent_id ? -1 : 1) }
// What upstream's part 3 of the hunter prompt names: the coverage ID, subsystem, boundary, starting paths, and the unit's block map.
const assignmentOf = u => ({
  coverage_id: u.coverage_id, surface: u.surface, boundary: u.boundary, subsystem: u.subsystem, attack_class: u.attack_class, ...(u.lifecycle !== undefined && { lifecycle: u.lifecycle }),
  starting_paths: u.starting_paths, ordinary_attack_class_block: u.ordinary_attack_class_block, selected_companion_blocks: u.selected_companion_blocks, excluded_blocks: u.excluded_blocks, prior_status: u.prior_status,
})

// The hunt stage: one hunter per agent_id plan-wave assigned, each with its units, the ledger's carried exclusions (fingerprint, title and root
// cause only: HUNTING.md part 8) and the coverage IDs its peers own. The shared upstream parts go in once, and each distinct block once, by reference:
// the script is the size of the blocks the wave names, not of the hunters times the blocks (retro entry 38 records why not files the agent reads).
export function huntInput(runDir, run, next) {
  const assigned = run.ledger.filter(u => u.status === 'in_progress')
  if (!assigned.length) refuse('no unit is in_progress: plan-wave assigns the units a wave hunts')
  const owners = new Map()
  for (const u of assigned) owners.set(u.agent_id, [...(owners.get(u.agent_id) ?? []), u])
  // Part 8: the root causes of same-source prior confirmed findings, for every hunter. The unit that carries such a record is its verifier's, not a
  // hunter's (it stays planned), so the list is the whole ledger's: a hunter must not report what an earlier run confirmed on source that has not changed.
  const exclusions = [...new Map(run.ledger.flatMap(u => u.carried_exclusions ?? []).map(e => [e.fingerprint, { fingerprint: e.fingerprint, title: e.title, root_cause: e.root_cause }])).values()]
    .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0))
  const hunters = [...owners].map(([agent_id, units]) => ({
    agent_id, units: units.map(assignmentOf), exclusions,
    peers: assigned.filter(u => u.agent_id !== agent_id).map(u => u.coverage_id).sort(),
  })).sort(byHunter)
  const refs = [...new Set(assigned.flatMap(u => [u.ordinary_attack_class_block, ...u.selected_companion_blocks]).filter(r => typeof r === 'string'))].sort()
  const p = parts()
  return {
    ...baseInput(runDir, run.meta, 'hunt'), wave: next.wave, architecture_md: architectureOf(runDir), hunters,
    blocks: Object.fromEntries(refs.map(r => [r, blockText(r)])), parts: Object.fromEntries(HUNT_PARTS.map(k => [k, p[k].text])),
  }
}

// A unit as the critic needs it: the semantic fields, the block map, the state and the evidence's shape. A check's `result` prose is dropped (up to 4,096
// characters a check), nothing else is cut or reworded; the full ledger stays on disk.
const compactUnit = u => ({
  coverage_id: u.coverage_id, surface: u.surface, boundary: u.boundary, subsystem: u.subsystem, attack_class: u.attack_class, ...(u.lifecycle !== undefined && { lifecycle: u.lifecycle }),
  starting_paths: u.starting_paths, ordinary_attack_class_block: u.ordinary_attack_class_block, selected_companion_blocks: u.selected_companion_blocks, excluded_blocks: u.excluded_blocks,
  prior_status: u.prior_status, status: u.status, wave: u.wave, agent_id: u.agent_id, reviewed_paths: u.reviewed_paths,
  checks: u.local_checks.map(c => ({ agent_id: c.agent_id, reviewed_paths: c.reviewed_paths, invariant: c.invariant, method: c.method })),
  result_fingerprints: u.result_fingerprints, unresolved: u.unresolved, attempts: u.attempts.map(a => ({ wave: a.wave, status: a.status, agent_id: a.agent_id, result_fingerprints: a.result_fingerprints })),
  ...(u.prior_leads && { prior_leads: u.prior_leads }),
})

export function criticInput(runDir, run, next) {
  const pool = readJson(join(runDir, 'candidates.json')) ?? []
  return {
    ...baseInput(runDir, run.meta, 'critic'), kind: next.kind, wave: next.wave, architecture_md: architectureOf(runDir), ledger: run.ledger.map(compactUnit),
    candidates: (Array.isArray(pool) ? pool : []).map(c => ({ fingerprint: c.fingerprint, proposed_verdict: c.proposed_verdict, units: c.units, hunter_ids: c.hunter_ids })),
    prior: priorSummary(runDir), parts: { criticSection: blockText(CRITIC_SECTION) },
  }
}

// What the critic returned, as apply saved it.
function readCritic(runDir) {
  const critic = readJson(join(runDir, 'critic.json'))
  if (critic === undefined || criticResultProblems(critic).length) refuse('critic.json is missing or not what apply wrote (the critic JSON); plan and apply the critic stage again')
  return critic
}

// The gaps to mint: the critic's missing_units and the hunters' queued `uncovered`, in that order (apply-critic counts them the same way), each tagged with where it came from.
export function mintInput(runDir, run, next) {
  const critic = readCritic(runDir)
  const kind = run.state.critic_kind   // the critic whose gaps these are: set when its result was saved
  const queue = readJson(join(runDir, 'uncovered.json')) ?? []
  const proposals = [
    ...critic.missing_units.map(u => ({ ...u, source: `the wave ${next.wave} critic` })),
    ...(Array.isArray(queue) ? queue : []).map(({ hunter_id, wave, ...rest }) => ({ ...rest, source: `hunter ${hunter_id}, wave ${wave}` })),
  ]
  return {
    ...baseInput(runDir, run.meta, 'mint'), wave: next.wave, kind, profile: run.meta.profile, scope_paths: run.meta.scope_paths, architecture_md: architectureOf(runDir), proposals,
    existing: run.ledger.map(u => u.coverage_id), ...feedbackFor(runDir, MINT_FEEDBACK, `${next.wave}:${kind}`),
    parts: { ledger: blockText(LEDGER_SPEC), registry: { ordinary: ordinary(), companions: companions().map(c => ({ file: c.file, whenToUse: blockText(c.whenToUse), blocks: c.blocks })) } },
  }
}

// `step` may run only when `audit-run.mjs next` names it, and only a stage this version builds.
const BUILT = ['recon', 'hunt', 'critic', 'mint']
function expectStage(run) {
  const next = nextStep(run)
  if (RUNNERS[next.step] !== 'workflow') refuse(`the next step is not a Workflow stage: ${formatNext(next)}`)
  if (!BUILT.includes(next.step)) refuse(`stage ${next.step} is not built in this version of audit-stage.mjs (it plans ${BUILT.join(', ')}): ${formatNext(next)}`)
  return next
}

// The budget gate for a stage that needs the final critic's reserve: when it is gone, no agent is launched, every planned unit is deferred and the
// run ends incomplete with upstream's reason (SKILL.md, "Cost budget").
function stopOnCriticBudget(runDir, run, step, who) {
  if (!criticBudgetExhausted(run.meta)) return
  const deferred = stopHunting(runDir, REASONS.critic, run)
  appendEvent(runDir, { cmd: 'plan', stage: step, result: 'refused', reason: REASONS.critic, counts: { deferred } })
  refuse(`${REASONS.critic}: the budget no longer covers ${who} (--budget ${run.meta.budget}, ${run.meta.agents_spent} spent); no agent was launched, ${deferred} planned unit(s) were deferred and the run is marked incomplete`)
}

// How each step is planned: the stage directory's label, the part, and the input. A gate that stops the stage refuses here, before anything is written.
const PLANNERS = {
  recon(runDir, run) {
    const part = existsSync(join(runDir, 'recon-facts.json')) ? 'synthesize' : 'facts'
    // The strict gate before any agent runs, again for this part: a retry must not spend past a budget the run was given (SKILL.md: never exceed it silently).
    const gate = reconGate(run.meta.profile, run.meta.budget, run.meta.agents_spent, part)
    if (!gate.ok) {
      markIncomplete(runDir, gate.reason)
      appendEvent(runDir, { cmd: 'plan', stage: 'recon', result: 'refused', reason: gate.reason, part })
      refuse(`${gate.reason}: the ${part === 'facts' ? 'researchers need' : 'synthesizer needs'} ${gate.needed} more calls with the reserves and ${run.meta.budget - run.meta.agents_spent} are left (--budget ${run.meta.budget}, ${run.meta.agents_spent} spent); no agent was launched and the run is marked incomplete`)
    }
    return { label: `recon-${part}`, part, input: reconInput(runDir, run.meta, part) }
  },
  hunt: (runDir, run, next) => ({ label: `hunt-w${next.wave}`, part: 'hunt', input: huntInput(runDir, run, next) }),
  critic(runDir, run, next) {
    stopOnCriticBudget(runDir, run, 'critic', 'the critic')
    return { label: `critic-${next.kind}-w${next.wave}`, part: 'critic', input: criticInput(runDir, run, next) }
  },
  mint(runDir, run, next) {
    const input = mintInput(runDir, run, next)
    if (input.proposals.length) stopOnCriticBudget(runDir, run, 'mint', 'the minter')   // with nothing to mint no agent is called, so nothing is gated
    return { label: `mint-${input.kind}-w${next.wave}`, part: 'mint', input }
  },
}

export function planStage(runDir) {
  const started = Date.now()
  const run = loadRun(runDir)
  const next = expectStage(run)
  const planned = PLANNERS[next.step](runDir, run, next)
  const stage = openStage(runDir, planned.label)
  const input = join(stage.dir, 'input.json'), script = join(stage.dir, 'run.js')
  writeJson(input, planned.input)
  const r = spawnSync(process.execPath, [RUN_SCRIPT, SEAM, input, WORKFLOW_FILE, script], { encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout.startsWith('run-script: wrote')) refuse(`run-script.mjs did not write the run script: ${(r.stdout + r.stderr).trim().split('\n').at(-1)}`)
  const bytes = statSync(script).size
  if (bytes > MAX_SCRIPT_BYTES) {
    rmSync(script)
    refuse(`the run script would be ${bytes} bytes; the Workflow tool refuses a script file over 524288 bytes and this version stops at ${MAX_SCRIPT_BYTES} (input: ${statSync(input).size} bytes).${next.step === 'recon' ? ' If the facts are the cause, delete recon-facts.json and plan again to run the facts part afresh' : " This stage's input is architecture.md, the ledger and the blocks it names; this version sends one prompt per stage and cannot split a ledger this large"}`)
  }
  appendEvent(runDir, { cmd: 'plan', stage: next.step, result: 'ok', duration_ms: Date.now() - started, part: planned.part, stage_dir: stage.name, script_bytes: bytes })
  return { step: next.step, part: planned.part, stage, script, bytes, returned: join(stage.dir, 'returned.json') }
}

// ---------- apply ----------
// What the workflow returns, as an untrusted value: the contract of security-audit-flow.js.
function resultProblems(result, input) {
  if (!isObj(result)) return ['the result is not a JSON object']
  const p = []
  if (result.status !== 'done' && result.status !== 'escalate') p.push(`status is ${show(result.status)}, not done or escalate`)
  if (typeof result.reason !== 'string') p.push('reason is not a string')
  if (result.stage !== input.stage) p.push(`stage is ${show(result.stage)}, but the stage planned is ${input.stage}`)
  if (!Array.isArray(result.history)) p.push('history is not an array')
  if (!Number.isSafeInteger(result.budgetSpent) || result.budgetSpent < 0 || result.budgetSpent > 1000) p.push(`budgetSpent is ${show(result.budgetSpent)}, not an integer from 0 to 1000 (a workflow runs at most 1000 agents)`)
  if (result.status === 'done' && !(isObj(result.results) && result.results.part === input.part)) p.push(`a done result must carry results for part ${input.part}`)
  return p
}

// A synthesizer or minter result the ledger would refuse is not saved as the step's, so the run is not left at a step with no way back: the cost is
// recorded, the reasons kept in `file` (one entry per stage, so applying one twice counts once; a mint entry carries its scope) and sent back by the next
// plan, and a second refusal ends the run. `giveUp` does what ending it means for this stage. Always refuses.
function refuseResult({ runDir, stage, result, event, file, scope, problems, what, then, giveUp }) {
  const attempts = readAttempts(runDir, file)
  const others = attempts.filter(a => a.stage !== stage.name)
  const mine = [...others.filter(a => a.scope === scope), { stage: stage.name, ...(scope !== undefined && { scope }), problems: problems.slice(0, 20).map(x => x.slice(0, 400)) }]
  writeJson(join(runDir, file), { version: 1, attempts: [...others.filter(a => a.scope !== scope), ...mine] })
  recordSpend(runDir, stage.name, result.budgetSpent)
  writeJson(join(stage.dir, 'result.json'), result)
  const last = mine.length >= MAX_SYNTH_ATTEMPTS
  if (last) giveUp()
  event(last ? 'failed' : 'refused', { counts: { problems: problems.length, attempt: mine.length } }, last ? LEDGER_FAILED : 'the ledger would not accept the units')
  return refuse(`${what} (${problems.length} problem(s)): ${problems[0].slice(0, 200)}${problems.length > 1 ? ` (and ${problems.length - 1} more, in ${file})` : ''} (attempt ${mine.length} of ${MAX_SYNTH_ATTEMPTS}${last ? `: the run is marked incomplete (${LEDGER_FAILED}), and the reasons are in ${file}` : `; ${then}`})`)
}

// One applier per step: it checks the part of the result that is its own, writes the files `then` names, records the cost, saves result.json, and
// saves the step last. It returns {summary, notes, then}, or refuses.
const APPLIERS = {
  recon({ runDir, stage, input, result, event, notes }) {
    if (input.part === 'facts') {
      const { facts, dropped } = checkFacts(join(runDir, 'tree'), result.results.facts)
      const kept = facts.reduce((n, f) => n + f.items.length, 0)
      for (const f of facts) {
        const mine = dropped.filter(d => d.agent === f.agent)
        if (mine.length) notes.push(`recon-${f.agent}: dropped ${mine.length} (${mine.filter(d => d.kind === 'item').length} item(s), ${mine.filter(d => d.kind === 'limit').length} limit(s)), first: ${mine[0].reason}`)
      }
      if (kept === 0) {
        recordSpend(runDir, stage.name, result.budgetSpent)
        writeJson(join(stage.dir, 'result.json'), result)
        event('refused', { dropped: dropped.length }, 'no fact held')
        return refuse(`not one fact the researchers returned holds (${dropped.length} dropped); recon-facts.json is not written. Plan the stage again to retry it`)
      }
      writeJson(join(runDir, 'recon-facts.json'), { version: 1, facts, dropped: dropped.slice(0, MAX_DROPPED_LISTED), dropped_total: dropped.length })
      recordSpend(runDir, stage.name, result.budgetSpent)
      writeJson(join(stage.dir, 'result.json'), result)
      event('ok', { counts: { kept, dropped: dropped.length } })
      return { summary: `recon part=facts kept=${kept} dropped=${dropped.length} agents=${result.budgetSpent}`, notes, then: `node audit-stage.mjs plan ${runDir}` }
    }
    // synthesize: recon.json is what `audit-ledger.mjs seed` takes. An empty ordinary block is the schema's way of saying "none applies".
    const { architecture_md, units, focused_recon } = result.results
    if (!isText(architecture_md) || !Array.isArray(units) || units.length === 0 || !units.every(isObj) || !Array.isArray(focused_recon)) refuse('the synthesizer result needs architecture_md text, a non-empty list of unit objects and a focused_recon list; nothing was changed')
    const recon = { architecture_md, units: units.map(u => (u.ordinary_attack_class_block === '' ? { ...u, ordinary_attack_class_block: null } : u)), focused_recon }
    // What seed would do with it, asked now: a result seed would refuse is never saved as the step's.
    const problems = seedProblems(runDir, recon)
    if (problems.length) return refuseResult({ runDir, stage, result, event, file: SEED_FEEDBACK, scope: undefined, problems, what: "the synthesizer's units would not seed", then: 'plan the stage again: it is sent these reasons', giveUp: () => markIncomplete(runDir, LEDGER_FAILED) })
    writeJson(join(runDir, 'recon.json'), recon)
    recordSpend(runDir, stage.name, result.budgetSpent)
    writeJson(join(stage.dir, 'result.json'), result)
    advanceState(runDir, 'recon')   // last: a crash leaves the step behind its effects, never ahead of them
    event('ok', { counts: { units: units.length, focused_recon: focused_recon.length } })
    if (focused_recon.length) notes.push(`${focused_recon.length} area(s) the synthesizer says need their own reconnaissance agent were recorded in recon.json and not investigated: this version runs no focused reconnaissance`)
    return { summary: `recon part=synthesize units=${units.length} focused_recon=${focused_recon.length} agents=${result.budgetSpent}`, notes, then: `node audit-ledger.mjs seed ${runDir} ${join(runDir, 'recon.json')}` }
  },

  // hunt: one entry per planned hunter, each a result or null. merge-wave judges each result, unit by unit; a null returns that hunter's units to planned.
  hunt({ runDir, stage, input, result, event, notes }) {
    const ids = input.hunters.map(h => h.agent_id)
    const got = result.results.hunters
    if (!isObj(got) || Object.keys(got).length !== ids.length || !ids.every(id => Object.hasOwn(got, id) && (got[id] === null || isObj(got[id])))) refuse(`results.hunters must have exactly one entry per planned hunter (${ids.join(', ')}), each a result object or null; nothing was changed`)
    const ordered = Object.fromEntries(ids.map(id => [id, got[id]]))
    writeJson(join(runDir, 'hunter-results.json'), ordered)
    recordSpend(runDir, stage.name, result.budgetSpent)
    writeJson(join(stage.dir, 'result.json'), result)
    advanceState(runDir, 'hunt')
    const usable = ids.filter(id => ordered[id] !== null).length
    event('ok', { counts: { hunters: ids.length, usable } })
    if (usable < ids.length) notes.push(`${ids.length - usable} of ${ids.length} hunter(s) returned nothing usable (${result.reason}); merge-wave returns their units to planned and counts the failure`)
    return { summary: `hunt wave=${input.wave} hunters=${ids.length} usable=${usable} agents=${result.budgetSpent}`, notes, then: `node audit-ledger.mjs merge-wave ${runDir} ${join(runDir, 'hunter-results.json')}` }
  },

  critic({ runDir, stage, input, result, event, notes }) {
    const critic = result.results.critic
    const bad = criticResultProblems(critic)
    if (bad.length || result.results.kind !== input.kind) refuse(`the critic result is not upstream's JSON for a ${input.kind} critic: ${bad.join('; ') || `its kind is ${show(result.results.kind)}`}; nothing was changed`)
    writeJson(join(runDir, 'critic.json'), critic)
    recordSpend(runDir, stage.name, result.budgetSpent)
    writeJson(join(stage.dir, 'result.json'), result)
    advanceState(runDir, 'critic', { critic_kind: input.kind })
    event('ok', { counts: { missing_units: critic.missing_units.length, reassign_ids: critic.reassign_ids.length, resolved_prior_leads: critic.resolved_prior_leads.length }, critic_stop: critic.stop })
    return { summary: `critic kind=${input.kind} id=${result.results.id} missing_units=${critic.missing_units.length} reassign_ids=${critic.reassign_ids.length} resolved_prior_leads=${critic.resolved_prior_leads.length} stop=${critic.stop} agents=${result.budgetSpent}`, notes, then: `node audit-stage.mjs plan ${runDir}` }
  },

  mint({ runDir, run, stage, input, result, event, notes }) {
    const units = result.results.units
    if (!Array.isArray(units) || !units.every(isObj)) refuse('the minter result needs a units list of objects; nothing was changed')
    const mint = { units: units.map(u => (u.ordinary_attack_class_block === '' ? { ...u, ordinary_attack_class_block: null } : u)) }
    // What apply-critic would do with it, asked now: upstream says fail on a collision and the parent never mints more than it was given.
    const problems = applyCriticProblems(runDir, readCritic(runDir), mint)
    if (problems.length) return refuseResult({ runDir, stage, result, event, file: MINT_FEEDBACK, scope: `${input.wave}:${input.kind}`, problems, what: "the minter's units would not apply", then: 'plan the stage again: it is sent these reasons', giveUp: () => stopHunting(runDir, LEDGER_FAILED, run) })
    writeJson(join(runDir, 'mint.json'), mint)
    recordSpend(runDir, stage.name, result.budgetSpent)
    writeJson(join(stage.dir, 'result.json'), result)
    advanceState(runDir, 'mint')
    event('ok', { counts: { proposals: input.proposals.length, units: units.length } })
    return { summary: `mint wave=${input.wave} proposals=${input.proposals.length} units=${units.length} agents=${result.budgetSpent}`, notes, then: `node audit-ledger.mjs apply-critic ${runDir} ${join(runDir, 'critic.json')} ${join(runDir, 'mint.json')}` }
  },
}

export function applyStage(runDir, returnedFile) {
  const started = Date.now()
  const run = loadRun(runDir)
  const next = expectStage(run)
  // The newest stage, applied or not: a stage whose result.json is saved but whose step was not (a crash between the two) is finished by
  // applying the very same result again, and only that.
  const stage = listStages(runDir).at(-1)
  if (!stage) refuse('no stage is planned: run `audit-stage.mjs plan` first')
  const input = readJson(join(stage.dir, 'input.json'))
  if (!isObj(input)) refuse(`${stage.name} has no input.json: plan it again`)
  if (input.stage !== next.step) refuse(`${stage.name} was planned for ${show(input.stage)}, and the next step is ${next.step}: plan it again`)
  const result = readJson(resolve(returnedFile))
  if (result === undefined) refuse(`${returnedFile} does not exist`)
  if (stage.done && !isDeepStrictEqual(readJson(join(stage.dir, 'result.json')), result)) refuse(`${stage.name} was already applied with a different result: plan the stage again`)
  const problems = resultProblems(result, input)
  if (problems.length) refuse(`the result is not the workflow's: ${problems.join('; ')}; nothing was changed`)
  const notes = []
  const event = (outcome, extra = {}, reason = null) => appendEvent(runDir, { cmd: 'apply', stage: next.step, result: outcome, reason, duration_ms: Date.now() - started, part: input.part, stage_dir: stage.name, agents: result.budgetSpent, ...extra })
  // The agents ran whatever they returned, so what they cost is recorded for an escalation too, and the result is kept.
  if (result.status === 'escalate') {
    recordSpend(runDir, stage.name, result.budgetSpent)
    writeJson(join(stage.dir, 'result.json'), result)
    event('escalated', {}, result.reason)
    return refuse(`${next.step} ${input.part} escalated: ${result.reason} (${result.budgetSpent} agent(s) spent; plan the stage again to retry it)`)
  }
  return APPLIERS[next.step]({ runDir, run, stage, input, result, event, notes })
}

// ---------- command line ----------
const USAGE = `usage: audit-stage.mjs plan <run dir>
       audit-stage.mjs apply <run dir> <returned.json>`

export function main(argv) {
  const [cmd, runArg, ...rest] = argv
  try {
    if (cmd === 'plan' && runArg !== undefined && rest.length === 0) {
      const out = planStage(resolve(runArg))
      console.log(`Call the Workflow tool with scriptPath ${out.script} and no args, then save the JSON it returns to ${out.returned}`)
      console.log(`AUDIT: OK plan ${out.step} part=${out.part} script=${out.script} bytes=${out.bytes} returned=${out.returned}`)
      return 0
    }
    if (cmd === 'apply' && runArg !== undefined && rest.length === 1) {
      const out = applyStage(resolve(runArg), rest[0])
      for (const n of out.notes) console.log(`note: ${n}`)
      console.log(`then: ${out.then}`)
      console.log(`AUDIT: OK apply ${out.summary}`)
      return 0
    }
    throw new Usage()
  } catch (e) {
    if (e instanceof Usage) { console.error(USAGE); return 2 }
    console.log(`AUDIT: FAIL ${e.message}`)
    return 1
  }
}

// Run as a command, also through the ~/.claude/skills symlink install.sh makes.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
