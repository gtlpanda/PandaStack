#!/usr/bin/env node
// audit-native.mjs - the Codex entry of the security-audit skill (the `## Codex runner` section of SKILL.md). It drives ONE full audit from
// `init` to the three reports on Codex, with the lifecycle the skill already has and no second one: `audit-run.mjs init` makes the run, `nextStep`
// (audit-run.mjs) names every step, a helper step runs the same command the skill's table gives, and a stage step runs through
// runNativeAuditStage (native-stage.mjs) with the Codex provider of native-codex.mjs. Budgets are finite and durable (the journal's grant and
// maximum), every leaf is a durable receipt, and a stopped run resumes from disk.
//
//   node audit-native.mjs run <target> --full --budget N [--max-budget M] [audit-run.mjs init flags] [--codex-bin P] [--auth-file P]
//                         [--stage-timeout-minutes T] [--concurrency N]
//   node audit-native.mjs resume <run dir> [--grant N] [--codex-bin P] [--auth-file P] [--stage-timeout-minutes T] [--concurrency N]
//
// Exit: 0 the run is complete and its three reports exist; 5 it ended incomplete (a partial pass: the reports say why); 3 it is paused (budget or an
// uncertain leaf: resume); 2 usage; 1 any other failure. Not a runtime certification: see docs/evidence/codex-security-audit-live-*.md.
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Refusal, Usage, loadRun, nextStep, parseInitArgs, raiseBudget, readJson, writeJson } from './audit-run.mjs'
import { openAuditJournal } from './dispatch-journal.mjs'
import { runNativeAuditStage } from './native-stage.mjs'
import { NATIVE_DIR, createNativeCodexHost } from './native-codex.mjs'
import { loadOfferingCatalog } from '../../../../core/skills/native-runtime/catalog.mjs'
import { loadWorkflowRegistry } from '../../../../core/skills/native-runtime/registry.mjs'

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const NATIVE_RUN_FILE = 'native-run.json'
const REPORTS = ['REPORT.md', 'NEEDS-VALIDATION.md', 'FINDINGS-DETAIL.md']
const MAX_SAME_STEP_REFUSALS = 3   // SKILL.md: a third identical failure in a row stops the run
const HELPER_TIMEOUT_MS = 10 * 60 * 1000
const USAGE = `usage: audit-native.mjs run <target> --full --budget N [--max-budget M] [--profile quick|standard|deep] [--scope p,..] [--out dir] [--prior dir]...
                              [--max-parallel N] [--max-units-per-hunter N] [--codex-bin P] [--auth-file P] [--stage-timeout-minutes T] [--concurrency N]
       audit-native.mjs resume <run dir> [--grant N] [--codex-bin P] [--auth-file P] [--stage-timeout-minutes T] [--concurrency N]`

// The helper steps and the commands that run them: SKILL.md's table, argument for argument (a test compares the two).
export const HELPER_COMMANDS = Object.freeze({
  seed: (run) => ['audit-ledger.mjs', 'seed', run, join(run, 'recon.json')],
  'plan-wave': (run) => ['audit-ledger.mjs', 'plan-wave', run],
  'merge-wave': (run) => ['audit-ledger.mjs', 'merge-wave', run, join(run, 'hunter-results.json')],
  'apply-critic': (run) => ['audit-ledger.mjs', 'apply-critic', run, join(run, 'critic.json'), join(run, 'mint.json')],
  'write-findings': (run) => ['audit-findings.mjs', 'write', run],
  report: (run) => ['audit-report.mjs', 'report', run],
})

const oneLine = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim().slice(0, 400)
const positive = (value, max) => {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Usage()
  return Math.min(Number(value), max)
}

// ---------------------------------------------------------------- arguments

const OWN_FLAGS = {
  '--max-budget': ['maxBudget', v => positive(v, 100000)], '--codex-bin': ['codexBin', v => v], '--auth-file': ['authFile', v => v],
  '--stage-timeout-minutes': ['stageTimeoutMinutes', v => positive(v, 24 * 60)], '--concurrency': ['concurrency', v => positive(v, 16)],
  '--grant': ['grant', v => positive(v, 100000)],
}

// Splits this command's own flags from the init flags it passes on untouched.
export function parseNativeArgs(argv) {
  const [command, ...rest] = argv
  if (!['run', 'resume'].includes(command)) throw new Usage()
  const own = {}, passed = []
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (Object.hasOwn(OWN_FLAGS, flag)) {
      const value = rest[++i]
      const [name, parse] = OWN_FLAGS[flag]
      if (value === undefined || value === '' || value.startsWith('--') || Object.hasOwn(own, name)) throw new Usage()
      own[name] = parse(value)
    } else passed.push(flag)
  }
  if (command === 'resume') {
    if (passed.length !== 1 || own.maxBudget !== undefined || passed[0].startsWith('-')) throw new Usage()
    return { command, runDir: resolve(passed[0]), own }
  }
  if (own.grant !== undefined) throw new Usage()
  const init = parseInitArgs(passed)
  // New native runs need a finite budget: nothing else bounds what a Codex run may spend.
  if (init.budget === null) throw Object.assign(new Error('a native run needs --budget N, a finite cap on agent invocations'), { name: 'NativeRefusal' })
  if (own.maxBudget !== undefined && own.maxBudget < init.budget) throw Object.assign(new Error('--max-budget cannot be below --budget'), { name: 'NativeRefusal' })
  return { command, passed, init, own }
}

function findCodex(explicit) {
  if (explicit !== undefined) return explicit
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, 'codex')
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate) } catch { /* next */ }
  }
  throw Object.assign(new Error('codex is not on PATH: pass --codex-bin'), { name: 'NativeRefusal' })
}

function findAuthFile(explicit) {
  const file = explicit ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
  if (!isAbsolute(file) || !existsSync(file)) throw Object.assign(new Error('no Codex login found: sign in with codex, or pass --auth-file'), { name: 'NativeRefusal' })
  return file
}

// ---------------------------------------------------------------- registry

// The workflow pins come from the v2 offering catalog, as the graph host reads them; a workflow file that no longer matches its pin is refused.
function loadRegistry() {
  const catalog = loadOfferingCatalog({ installationRoot: REPO_ROOT })
  const pins = {}
  for (const row of catalog.workflows) pins[/\/([a-z0-9-]+)\.js$/.exec(row.source)[1]] = row.sha256
  return loadWorkflowRegistry({ installationRoot: REPO_ROOT, workflowHashes: pins })
}

// ---------------------------------------------------------------- one run

function runHelper(step, runDir, log) {
  const [script, ...args] = HELPER_COMMANDS[step](runDir)
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], { encoding: 'utf8', timeout: HELPER_TIMEOUT_MS, maxBuffer: 16 * 1048576 })
  const last = (r.stdout ?? '').trim().split('\n').at(-1) ?? ''
  log(`${step}: ${oneLine(last)}`)
  return r.status === 0 && /^AUDIT: OK /.test(last)
}

function openJournal(runDir, native, grant, log) {
  const journal = openAuditJournal({ runDir, invocationLimit: native.maxBudget })
  // A refusal below must not leave the journal open (the owner lock would block the next open in this process).
  try {
    if (!journal.getControl()) journal.initControl({ initialGrant: native.grant })
    const control = journal.getControl()
    if (grant !== undefined) {
      if (!control.blockers.includes('paused_budget')) throw Object.assign(new Error('--grant applies only to a run paused for its budget'), { name: 'NativeRefusal' })
      // Never above the caller's maximum, never a silent raise, and the planners' budget moves with the grant: they gate on run-metadata, not the journal.
      // The run's budget is raised first: a retry after a failure between the two writes finds it already there (raising to the same value is a no-op).
      if (grant > native.maxBudget || grant <= control.currentGrant) throw Object.assign(new Error(`--grant must be above the current grant ${control.currentGrant} and at most the maximum ${native.maxBudget}`), { name: 'NativeRefusal' })
      raiseBudget(runDir, grant)
      journal.adjustGrant({ expectedRevision: control.revision, currentGrant: grant, reason: 'operator_increase' })
      journal.resumeBudget({ expectedRevision: journal.getControl().revision })
      log(`budget grant raised to ${grant} (maximum ${native.maxBudget})`)
    }
    return journal
  } catch (e) { journal.close(); throw e }
}

function summary(runDir) {
  const { meta } = loadRun(runDir)
  return `status=${meta.run_status} agents_spent=${meta.agents_spent}${meta.budget === null ? '' : ` budget=${meta.budget}`}`
}

// The end of a run: its three reports exist and are not empty, and the status says whether the pass was complete.
function finished(runDir) {
  const missing = REPORTS.filter(f => !existsSync(join(runDir, f)) || statSync(join(runDir, f)).size === 0)
  if (missing.length) return { code: 1, line: `AUDIT: FAIL the run is done but ${missing.join(', ')} is missing` }
  const { meta } = loadRun(runDir)
  return { code: meta.run_status === 'complete' ? 0 : 5, line: `AUDIT: DONE ${summary(runDir)} reports=${REPORTS.map(f => join(runDir, f)).join(',')}` }
}

async function drive(runDir, own, log) {
  const native = readJson(join(runDir, NATIVE_DIR, NATIVE_RUN_FILE))
  if (!native || !Number.isSafeInteger(native.maxBudget) || !Number.isSafeInteger(native.grant)) throw Object.assign(new Error(`${runDir} is not a native run (no ${NATIVE_RUN_FILE})`), { name: 'NativeRefusal' })
  // A finished run needs no journal, no Codex and no preflight: report where it ended.
  if (nextStep(loadRun(runDir)).step === 'done') return finished(runDir)
  const registry = loadRegistry()
  const host = createNativeCodexHost({ runDir, codexBin: findCodex(own.codexBin), authFile: findAuthFile(own.authFile) })
  const journal = openJournal(runDir, native, own.grant, log)
  // The first signal asks the run to stop between stages, which keeps it resumable; an in-flight leaf aborted mid-call is held as uncertain and this
  // version has no way to reconcile that (the journal clears only a budget pause). A second signal aborts at once.
  const controller = new AbortController()
  let stopRequested = false
  const stop = () => {
    if (stopRequested) { controller.abort(); return }
    stopRequested = true
    log('signal received: stopping after the current stage (signal again to abort now; an aborted leaf leaves the run unresumable)')
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  try {
    const prepared = await host.prepare()
    log(`source-only wire preflight passed for ${prepared.models.join(', ')} on codex ${prepared.codexVersion}${prepared.versionPinned ? '' : ' (not a pinned version; the preflight is the only proof)'}`)
    const provider = host.provider()
    const stageMs = (own.stageTimeoutMinutes ?? 60) * 60000
    const concurrency = Math.min(own.concurrency ?? 2, loadRun(runDir).meta.limits.max_parallel)
    let lastRefused = null, refusals = 0
    for (;;) {
      const next = nextStep(loadRun(runDir))
      if (next.step === 'done') break
      if (stopRequested || controller.signal.aborted) return { code: 3, line: `AUDIT: PAUSED interrupted between stages; resume with: audit-native.mjs resume ${runDir}` }
      if (Object.hasOwn(HELPER_COMMANDS, next.step)) {
        if (!runHelper(next.step, runDir, log)) return { code: 1, line: `AUDIT: FAIL the ${next.step} helper refused; run ${runDir} is left as it is` }
        // A helper that said OK must have moved the run on; one that did not would be asked again forever.
        if (JSON.stringify(nextStep(loadRun(runDir))) === JSON.stringify(next)) return { code: 1, line: `AUDIT: FAIL the ${next.step} helper did not advance the run; run ${runDir} is left as it is` }
        continue
      }
      try {
        const done = await runNativeAuditStage({ runDir, journal, registry, provider, resolveLeaf: host.resolveLeaf, maxConcurrentSubagents: concurrency,
          deadlineMs: Date.now() + stageMs, signal: controller.signal })
        log(`${done.stageName}: ${done.result.status} ${oneLine(done.result.reason)}`)
        lastRefused = null; refusals = 0
      } catch (e) {
        if (e?.code === 'CONTROL_PAUSED') {
          const blockers = e.blockers ?? []
          // Only a budget pause is resumable here. An uncertain leaf stays held (the journal has no reconciliation): the run keeps what it has.
          const how = blockers.includes('paused_uncertain') ? 'a leaf is held as uncertain and this version cannot reconcile it: the run cannot continue; its retained evidence is in the run directory'
            : `resume with: audit-native.mjs resume ${runDir}${blockers.includes('paused_budget') ? ' --grant <more, up to the maximum>' : ''}`
          return { code: 3, line: `AUDIT: PAUSED blockers=${blockers.join(',')}; ${how}` }
        }
        if (!(e instanceof Refusal)) return { code: 1, line: `AUDIT: FAIL ${oneLine(e?.code ?? e?.message)} at ${next.step}; run ${runDir} is left as it is` }
        // A refusal is a rejected result or a gate: ask `next` again, as the skill says, and stop on a third identical failure in a row.
        refusals = lastRefused === next.step ? refusals + 1 : 1
        lastRefused = next.step
        log(`${next.step}: refused: ${oneLine(e.message)}`)
        if (refusals >= MAX_SAME_STEP_REFUSALS) return { code: 1, line: `AUDIT: FAIL ${next.step} was refused ${refusals} times in a row; run ${runDir} is left as it is` }
      }
    }
    return finished(runDir)
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
    host.close()
    journal.close()
  }
}

function startRun(parsed, log) {
  // The run is made by the skill's own init, so the snapshot, the gates and the notes are the ones a Claude run has.
  const r = spawnSync(process.execPath, [join(HERE, 'audit-run.mjs'), 'init', ...parsed.passed], { encoding: 'utf8', timeout: HELPER_TIMEOUT_MS })
  for (const line of (r.stdout ?? '').trim().split('\n').filter(l => l.startsWith('note:'))) log(line)
  const lines = (r.stdout ?? '').trim().split('\n')
  if (r.status !== 0 || !/^AUDIT: OK /.test(lines.at(-1) ?? '')) throw Object.assign(new Error(`init refused: ${oneLine(lines.at(-1) || r.stderr)}`), { name: 'NativeRefusal' })
  const runDir = lines[0]
  const budget = parsed.init.budget
  const maxBudget = parsed.own.maxBudget ?? budget
  mkdirSync(join(runDir, NATIVE_DIR), { recursive: true, mode: 0o700 })
  writeJson(join(runDir, NATIVE_DIR, NATIVE_RUN_FILE), { version: 1, grant: budget, maxBudget, created: new Date().toISOString() })
  log(`native run ${runDir}: grant ${budget} agent invocation(s), maximum ${maxBudget}`)
  return runDir
}

export async function main(argv, out = console) {
  const log = line => out.log(line)
  try {
    const parsed = parseNativeArgs(argv)
    const runDir = parsed.command === 'run' ? startRun(parsed, log) : parsed.runDir
    const { code, line } = await drive(runDir, parsed.own, log)
    log(line)
    return code
  } catch (e) {
    if (e instanceof Usage) { console.error(USAGE); return 2 }
    log(`AUDIT: FAIL ${oneLine(e?.message ?? e)}${Array.isArray(e?.problems) ? `\n${e.problems.map(p => `  ${oneLine(p)}`).join('\n')}` : ''}`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
