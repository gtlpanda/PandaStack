#!/usr/bin/env node
// audit-stage.mjs - the session's side of one Workflow stage of a security-audit run: `plan` writes the stage's input and a
// runnable copy of the workflow, `apply` checks what the workflow returned and saves it. The workflow
// (workflows/security-audit-flow.js) has no filesystem, so everything that reads or writes a run file happens here.
//
//   node audit-stage.mjs plan  <run dir>
//   node audit-stage.mjs apply <run dir> <returned.json>     returned.json: what the Workflow tool returned, as JSON
//
// Both run only when `audit-run.mjs next` names a Workflow stage (this version builds `recon`), so a stage cannot be planned or
// applied out of order. A command's last line is "AUDIT: OK <cmd> ..." (exit 0) or "AUDIT: FAIL <reason>" (exit 1); bad usage is
// on stderr, exit 2.
//
// recon is two Workflow runs, because the file:line references the researchers return must be checked against tree/ before the
// synthesizer sees them, and the workflow cannot read tree/. `plan` picks the part from what is on disk: no recon-facts.json is
// the facts part (four researchers); with it, the synthesize part (one synthesizer reads the checked facts). `next` says `recon`
// both times. `apply` of the synthesize part writes recon.json, which `audit-ledger.mjs seed` takes, and saves the step.
//
// A stage lives in stages/<NN>-<name>/: input.json and run.js (plan), result.json (apply, written last, so a stage without one
// is planned and not applied). Every effect of apply is idempotent and the step is saved last, so a crash leaves the step behind its
// effects, never ahead: applying the same result again finishes the stage, and changes nothing if it had finished.
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNNERS, Usage, advanceState, appendEvent, formatNext, loadRun, markIncomplete, nextStep, readJson, recordSpend, reconGate, refuse, writeJson } from './audit-run.mjs'
import { seedProblems } from './audit-ledger.mjs'
import { RECON_IDS, checkFacts } from './audit-facts.mjs'
import { companions, ordinary, parts, resolve as resolveBlock } from './blocks.mjs'

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
const FEEDBACK_FILE = 'seed-feedback.json'
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

// The refused synthesizer attempts so far, one entry per stage (applying a stage again replaces its own entry, so it counts once).
function readFeedback(runDir) {
  const file = readJson(join(runDir, FEEDBACK_FILE))
  if (file === undefined) return []
  const ok = isObj(file) && Array.isArray(file.attempts) && file.attempts.every(a => isObj(a) && typeof a.stage === 'string' && Array.isArray(a.problems) && a.problems.every(x => typeof x === 'string'))
  if (!ok) refuse(`${FEEDBACK_FILE} is not what apply wrote ({attempts: [{stage, problems: [text]}]}); delete it to forget the refused attempts`)
  return file.attempts
}

// The stage input for one part of recon: plain data, the text upstream's own files hold (blocks.mjs slices it, nothing here retypes it).
export function reconInput(runDir, meta, part) {
  const base = { stage: 'recon', part, tree: join(runDir, 'tree'), maxParallel: meta.limits.max_parallel, execution: { capability: meta.execution_capability, blockers: meta.execution_blockers } }
  const p = parts()
  if (part === 'facts') return { ...base, parts: Object.fromEntries(RECON_IDS.map(id => [`recon${id}`, p[`recon${id}`].text])) }
  const refused = readFeedback(runDir)
  return {
    ...base, profile: meta.profile, scope_paths: meta.scope_paths, prior: priorSummary(runDir), facts: readFacts(runDir),
    ...(refused.length && { feedback: { attempt: refused.length, of: MAX_SYNTH_ATTEMPTS, problems: refused.at(-1).problems } }),
    parts: {
      ranking: resolveBlock(RANKING).text, architectureSummary: resolveBlock(ARCH_SUMMARY).text, ledger: resolveBlock(LEDGER_SPEC).text,
      registry: { ordinary: ordinary(), companions: companions().map(c => ({ file: c.file, whenToUse: resolveBlock(c.whenToUse).text, blocks: c.blocks })) },
    },
  }
}

// `step` may run only when `audit-run.mjs next` names it, and only a stage this version builds.
function expectStage(run) {
  const next = nextStep(run)
  if (RUNNERS[next.step] !== 'workflow') refuse(`the next step is not a Workflow stage: ${formatNext(next)}`)
  if (next.step !== 'recon') refuse(`stage ${next.step} is not built in this version of audit-stage.mjs (it plans recon only): ${formatNext(next)}`)
  return next
}

export function planStage(runDir) {
  const started = Date.now()
  const run = loadRun(runDir)
  expectStage(run)
  const part = existsSync(join(runDir, 'recon-facts.json')) ? 'synthesize' : 'facts'
  // The strict gate before any agent runs, again for this part: a retry must not spend past a budget the run was given (SKILL.md: never exceed it silently).
  const gate = reconGate(run.meta.profile, run.meta.budget, run.meta.agents_spent, part)
  if (!gate.ok) {
    markIncomplete(runDir, gate.reason)
    appendEvent(runDir, { cmd: 'plan', stage: 'recon', result: 'refused', reason: gate.reason, part })
    refuse(`${gate.reason}: the ${part === 'facts' ? 'researchers need' : 'synthesizer needs'} ${gate.needed} more calls with the reserves and ${run.meta.budget - run.meta.agents_spent} are left (--budget ${run.meta.budget}, ${run.meta.agents_spent} spent); no agent was launched and the run is marked incomplete`)
  }
  const stage = openStage(runDir, `recon-${part}`)
  const input = join(stage.dir, 'input.json'), script = join(stage.dir, 'run.js')
  writeJson(input, reconInput(runDir, run.meta, part))
  const r = spawnSync(process.execPath, [RUN_SCRIPT, SEAM, input, WORKFLOW_FILE, script], { encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout.startsWith('run-script: wrote')) refuse(`run-script.mjs did not write the run script: ${(r.stdout + r.stderr).trim().split('\n').at(-1)}`)
  const bytes = statSync(script).size
  if (bytes > MAX_SCRIPT_BYTES) {
    rmSync(script)
    refuse(`the run script would be ${bytes} bytes; the Workflow tool refuses a script file over 524288 bytes and this version stops at ${MAX_SCRIPT_BYTES} (input: ${statSync(input).size} bytes). If the facts are the cause, delete recon-facts.json and plan again to run the facts part afresh`)
  }
  appendEvent(runDir, { cmd: 'plan', stage: 'recon', result: 'ok', duration_ms: Date.now() - started, part, stage_dir: stage.name, script_bytes: bytes })
  return { part, stage, script, bytes, returned: join(stage.dir, 'returned.json') }
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

export function applyStage(runDir, returnedFile) {
  const started = Date.now()
  const run = loadRun(runDir)
  expectStage(run)
  // The newest stage, applied or not: a stage whose result.json is saved but whose step was not (a crash between the two) is finished by
  // applying the very same result again, and only that.
  const stage = listStages(runDir).at(-1)
  if (!stage) refuse('no stage is planned: run `audit-stage.mjs plan` first')
  const input = readJson(join(stage.dir, 'input.json'))
  if (!isObj(input)) refuse(`${stage.name} has no input.json: plan it again`)
  const result = readJson(resolve(returnedFile))
  if (result === undefined) refuse(`${returnedFile} does not exist`)
  if (stage.done && !isDeepStrictEqual(readJson(join(stage.dir, 'result.json')), result)) refuse(`${stage.name} was already applied with a different result: plan the stage again`)
  const problems = resultProblems(result, input)
  if (problems.length) refuse(`the result is not the workflow's: ${problems.join('; ')}; nothing was changed`)
  const notes = []
  const event = (outcome, extra = {}, reason = null) => appendEvent(runDir, { cmd: 'apply', stage: 'recon', result: outcome, reason, duration_ms: Date.now() - started, part: input.part, stage_dir: stage.name, agents: result.budgetSpent, ...extra })
  // The agents ran whatever they returned, so what they cost is recorded for an escalation too, and the result is kept.
  if (result.status === 'escalate') {
    recordSpend(runDir, stage.name, result.budgetSpent)
    writeJson(join(stage.dir, 'result.json'), result)
    event('escalated', {}, result.reason)
    return refuse(`recon ${input.part} escalated: ${result.reason} (${result.budgetSpent} agent(s) spent; plan the stage again to retry it)`)
  }
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
  // What seed would do with it, asked now: a result seed would refuse is never saved as the step's, so the run is not left at `seed` with no way back.
  const refused = seedProblems(runDir, recon)
  if (refused.length) {
    const attempts = [...readFeedback(runDir).filter(a => a.stage !== stage.name), { stage: stage.name, problems: refused.slice(0, 20).map(x => x.slice(0, 400)) }]
    writeJson(join(runDir, FEEDBACK_FILE), { version: 1, attempts })
    recordSpend(runDir, stage.name, result.budgetSpent)
    writeJson(join(stage.dir, 'result.json'), result)
    const giveUp = attempts.length >= MAX_SYNTH_ATTEMPTS
    if (giveUp) markIncomplete(runDir, LEDGER_FAILED)
    event(giveUp ? 'failed' : 'refused', { counts: { problems: refused.length, attempt: attempts.length } }, giveUp ? LEDGER_FAILED : 'the ledger would not accept the units')
    return refuse(`the synthesizer's units would not seed (${refused.length} problem(s)): ${refused[0].slice(0, 200)}${refused.length > 1 ? ` (and ${refused.length - 1} more, in ${FEEDBACK_FILE})` : ''} (attempt ${attempts.length} of ${MAX_SYNTH_ATTEMPTS}${giveUp ? `: the run is marked incomplete (${LEDGER_FAILED}), and the reasons are in ${FEEDBACK_FILE}` : '; plan the stage again: it is sent these reasons'})`)
  }
  writeJson(join(runDir, 'recon.json'), recon)
  recordSpend(runDir, stage.name, result.budgetSpent)
  writeJson(join(stage.dir, 'result.json'), result)
  advanceState(runDir, 'recon')   // last: a crash leaves the step behind its effects, never ahead of them
  event('ok', { counts: { units: units.length, focused_recon: focused_recon.length } })
  if (focused_recon.length) notes.push(`${focused_recon.length} area(s) the synthesizer says need their own reconnaissance agent were recorded in recon.json and not investigated: this version runs no focused reconnaissance`)
  return { summary: `recon part=synthesize units=${units.length} focused_recon=${focused_recon.length} agents=${result.budgetSpent}`, notes, then: `node audit-ledger.mjs seed ${runDir} ${join(runDir, 'recon.json')}` }
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
      console.log(`AUDIT: OK plan recon part=${out.part} script=${out.script} bytes=${out.bytes} returned=${out.returned}`)
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
