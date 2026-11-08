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

// ---- a fuzzer for `apply`: one mutation of a good result at a time, in process ----
import { readFileSync, rmSync, mkdirSync } from 'node:fs'
import { applyStage } from '../skills/security-audit/audit-stage.mjs'
import { checkRun } from '../skills/security-audit/audit-run.mjs'

const REPLACEMENTS = [null, 0, -1, 1.5, 2 ** 53, '', 'x', 'a'.repeat(5000), [], {}, true, [null], [{}], { a: 1 }, { __proto__: null, x: 1 }, [[]], '__proto__']
// Every non-tree file of the run, so each mutation starts from the same disk.
export const snapshot = runDir => new Map(files(runDir).map(f => [f, readFileSync(join(runDir, f))]))
export function restore(runDir, snap) {
  for (const f of files(runDir)) if (!snap.has(f)) rmSync(join(runDir, f), { force: true })
  for (const [f, bytes] of snap) { mkdirSync(dirname(join(runDir, f)), { recursive: true }); writeFileSync(join(runDir, f), bytes) }
}
// Applies `n` single mutations of `good` (a workflow result) through applyStage and returns how each ended. The invariants: only a refusal is ever thrown
// (never a TypeError out of a hostile shape), and whatever the outcome the run still passes `check`.
export function fuzzApply(runDir, good, dir, n = 60, seed = 7) {
  let x = seed
  const rnd = k => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % k }
  const paths = []
  const walk = (v, p) => { if (v && typeof v === 'object') for (const k of Object.keys(v)) { paths.push([...p, k]); walk(v[k], [...p, k]) } }
  walk(good, [])
  const snap = snapshot(runDir)
  const outcomes = { ok: 0, refused: 0 }
  for (let i = 0; i < n; i++) {
    const m = JSON.parse(JSON.stringify(good))
    const path = paths[rnd(paths.length)]
    let at = m
    for (const k of path.slice(0, -1)) at = at[k]
    const last = path.at(-1)
    if (rnd(4) === 0) delete at[last]; else at[last] = REPLACEMENTS[rnd(REPLACEMENTS.length)]
    const file = join(dir, `fuzz-${i}.json`)
    writeFileSync(file, JSON.stringify(m))
    try { applyStage(runDir, file); outcomes.ok += 1 } catch (e) {
      assert.equal(e.constructor.name, 'Refusal', `mutation ${JSON.stringify(path)}: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`)
      outcomes.refused += 1
    }
    assert.deepEqual(checkRun(runDir), [], `after mutation ${JSON.stringify(path)} the run must still pass check`)
    restore(runDir, snap)
  }
  return outcomes
}
