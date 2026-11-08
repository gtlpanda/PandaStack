// stage-fixtures.mjs - shared by the audit-stage tests: the audit-stage.mjs command line, a fixture repo, scripted recon answers, and a run
// taken from init to a seeded ledger through plan and apply. Not a test file: scripts/test-workflow.mjs runs only *.test.mjs.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { load, run } from '../../../scripts/workflow-harness.mjs'
import { RECON_IDS } from '../skills/security-audit/audit-facts.mjs'
import { ENV, init, ledgerCli, listFiles, mkRepo } from './audit-fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const STAGE = join(here, '..', 'skills', 'security-audit', 'audit-stage.mjs')
export const stage = (args, cwd = process.cwd()) => {
  const r = spawnSync(process.execPath, [STAGE, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } })
  const lines = r.stdout.trim().split('\n')
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, last: lines.at(-1), lines }
}
export const FILES = { 'src/app.js': 'export const a = 1\n', 'src/db.js': 'export const q = s => s\n', 'src/lines.js': 'one\ntwo\nthree\nfour\nfive\n', 'src/bare.txt': 'one\ntwo', 'src/empty.txt': '', 'README.md': '# fixture\n' }
export const newInit = (args = []) => { const repo = mkRepo(FILES); const r = init([repo, '--full', ...args]); assert.ok(r.ok, r.stdout + r.stderr); return { repo, runDir: r.runDir } }
export const RESEARCH = (id, over = {}) => ({ agent: id, items: [{ text: `fact ${id}`, refs: ['src/app.js:1'] }], limits: [`limit ${id}`], ...over })
// A synthesizer unit: `subsystem` is also the hunter group (units of one subsystem share a hunter), `path` its starting path.
export const UNIT = (name, over = {}) => ({
  canonical_refs: { surface: `src/app.js#${name}`, boundary: 'src/db.js#q', subsystem: over.subsystemRef ?? 'src', attack_class: 'ATTACK-CLASSES.md#Access control' },
  surface: `Route ${name}`, boundary: 'Query helper', subsystem: 'Source', attack_class: 'Access control', starting_paths: ['src/app.js'],
  ordinary_attack_class_block: 'ATTACK-CLASSES.md#Access control', selected_companion_blocks: [], excluded_blocks: [], priority_class: 2, priority_why: 'a lower-trust entry', ...over,
})
export const SYNTH = (over = {}) => ({ architecture_md: 'The fixture app routes requests to handlers and a tiny data layer.', units: [UNIT('a')], focused_recon: [], ...over })

// Runs the run script `plan` wrote, the way the Workflow tool would, against scripted agents; returns what the workflow returned.
export async function runScript(scriptFile, script) {
  const { fn } = load(scriptFile)
  return run(fn, script, undefined)
}
export const returnedFile = (dir, result) => { const f = join(dir, 'returned.json'); writeFileSync(f, JSON.stringify(result)); return f }
export const files = runDir => listFiles(runDir).filter(f => !f.startsWith('tree/')).sort()
export const stageDirs = runDir => (existsSync(join(runDir, 'stages')) ? readdirSync(join(runDir, 'stages')).sort() : [])
export const stageDirOf = (plan, runDir) => join(runDir, 'stages', plan.last.match(/script=\S*\/stages\/([^/]+)\/run\.js/)[1])

// plan, run the generated script against `script`, apply: { plan, apply, dir, ran }.
export async function runStage(runDir, script) {
  const plan = stage(['plan', runDir])
  assert.equal(plan.status, 0, plan.stdout)
  const dir = stageDirOf(plan, runDir)
  const ran = await runScript(join(dir, 'run.js'), script)
  return { plan, dir, ran, apply: stage(['apply', runDir, returnedFile(dir, ran.result)]) }
}

// A run taken from init through recon (both parts) to a seeded ledger, with `units` as the synthesizer's answer: { repo, runDir }.
export async function reconToSeed(units, args = []) {
  const { repo, runDir } = newInit(args)
  const facts = await runStage(runDir, { 'audit-researcher': RECON_IDS.map(id => RESEARCH(id)) })
  assert.equal(facts.apply.status, 0, facts.apply.stdout)
  const synth = await runStage(runDir, { 'audit-synthesizer': [SYNTH({ units })] })
  assert.equal(synth.apply.status, 0, synth.apply.stdout)
  const seed = ledgerCli(['seed', runDir, join(runDir, 'recon.json')])
  assert.equal(seed.status, 0, seed.stdout)
  return { repo, runDir }
}
