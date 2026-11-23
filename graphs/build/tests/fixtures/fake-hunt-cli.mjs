#!/usr/bin/env node
// A stub for graphs/hunt/skills/bughunt/native-cli.mjs, for the Codex driver tests (wiring proof, not
// runtime certification: the real CLI has its own tests). Like the real one in fix mode it prepares the
// hunt itself (the real intake and fix worktree, through land.mjs), records its argv in $FAKE_HUNT_LOG,
// then acts out $FAKE_HUNT_STEP, a JSON object:
//   { commits: [{subject, files}], findings: [{severity, status, fix}], exit }   a finished hunt in the fix worktree
//   { none: true }                                                              a hunt that saved no ledger
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = name => argv[argv.indexOf(name) + 1]
appendFileSync(process.env.FAKE_HUNT_LOG, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`)
const step = JSON.parse(process.env.FAKE_HUNT_STEP || '{}')
const repo = realpathSync(flag('--repo'))
const { prepareHunt } = await import(join(here, '..', '..', '..', 'hunt', 'skills', 'bughunt', 'land.mjs'))
const target = execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
const prep = prepareHunt({ repo, target, base: flag('--base'), stamp: 'stub', log: console.log })
if (prep.error || prep.skip) { console.error(`hunt preparation: ${prep.error || prep.skip}`); process.exit(12) }
console.log(`Native hunt: fix; lenses=logic; state=${prep.stateDir}`)
const state = prep.stateDir
const fixDir = join(state, 'fix')
const inFix = (...a) => execFileSync('git', ['-C', fixDir, ...a], { stdio: 'pipe', encoding: 'utf8' })
const shas = []
for (const c of step.commits || []) {
  for (const [p, text] of Object.entries(c.files || {})) { mkdirSync(dirname(join(fixDir, p)), { recursive: true }); writeFileSync(join(fixDir, p), text) }
  inFix('add', '-A'); inFix('commit', '-q', '--no-verify', '-m', c.subject)
  shas.push(inFix('rev-parse', 'HEAD').trim())
}
if (!step.none) {
  const { mergeFindings, writeLedger, emptyLedger } = await import(join(here, '..', '..', '..', '..', 'core', 'skills', 'findings', 'findings.mjs'))
  const intake = JSON.parse(readFileSync(join(state, 'intake.json'), 'utf8'))
  const head = intake.target.head
  const cand = (f, i) => ({
    file_path: `src/f${i + 1}.js`, line_range: [1, 1], bug_category: 'logic', severity: f.severity || 'HIGH', confidence: 70, title: `bug ${i + 1}`, description: 'd',
    failure_scenario: { trigger: 't', path: 'p', observable: 'o' }, expected_behavior: 'e', actual_behavior: 'a', evidence: [{ file: `src/f${i + 1}.js`, line: 1, quote: 'x' }], source_agent: 'hunter:logic',
  })
  const found = step.findings || []
  let next = 0
  const findings = mergeFindings([], found.map(cand), head).findings.map((f, i) => {
    const fix = found[i].fix || 'none'
    return { ...f, verification_status: found[i].status || 'reproduced', fix_status: fix, fix_artifact: fix === 'verified' ? { mode: 'fix', commit: shas[next++] || null } : null }
  })
  writeLedger(join(state, 'ledger.json'), { ...emptyLedger(intake.key), target: intake.target, findings, coverage: [], status: 'done', runs: [{ at: 't', mode: 'fix', head, status: 'done', reason: 'r', added: [], merged: 0, dropped: 0, calls: 1 }] })
}
process.exitCode = step.exit || 0
