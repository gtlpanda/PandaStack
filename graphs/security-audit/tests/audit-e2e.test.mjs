// audit-e2e.test.mjs - the first usable v1, offline: a whole audit of a fixture repository (the plan's toy notes API: a missing ownership check, a credential-shaped dummy
// string, an unsafe path join, permissive CORS) driven from `init` to `report` exactly as the entry skill says, by scripted agents through the workflow harness. What runs
// next is whatever `audit-run.mjs next` prints, dispatched through the skill's own table (e2e-driver.mjs reads SKILL.md); the real vendored validators run on every
// artifact inside the helpers. Two waves, a critic gap and its minter, a final-clean critic, consolidation, a rejected verdict, Phase 5, the three reports, a task and an export.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { audit, meta, mkRepo, sh } from './audit-fixtures.mjs'
import { answer } from './toy-agents.mjs'
import { driveAudit } from './e2e-driver.mjs'
import { PLANTED, TOY_FILES } from './toy-app.mjs'
import { runCommand, skillCommands, skillText } from './skill-commands.mjs'
import { validateFindingsFile, validateLedgerFile } from '../skills/security-audit/upstream.mjs'

const readJson = f => JSON.parse(readFileSync(f, 'utf8'))
console.log('== the whole audit, driven by the skill, offline')
const repo = mkRepo(TOY_FILES, 'toy')
const headBefore = sh(repo, 'rev-parse', 'HEAD')
const calls = {}
const driven = await driveAudit({ repo, answer, initArgs: ['--max-parallel', '2'], onStep: e => { for (const c of e.calls) calls[c.agentType] = (calls[c.agentType] ?? 0) + 1 } })
const { RUN, trace: steps } = driven
const vars = driven.vars
const next = () => audit(['next', RUN]).last

await test('the skill drove init to done: next said done status=complete, and every step it printed was one the skill has a command or a stage procedure for', () => {
  assert.equal(next(), 'NEXT: done status=complete')
  assert.equal(steps.at(-1).next, 'NEXT: done status=complete')
  assert.ok(steps.length > 20, `${steps.length} steps`)
  assert.ok(steps.every(s => s.runner === 'workflow' || s.step === 'done' || s.commands.length === 1), 'a helper step ran exactly the one command the table gave')
  assert.ok(steps.every(s => s.runner !== 'workflow' || s.commands.length === 2), 'a Workflow step ran plan, then apply')
})
await test('the path is the stage machine of the plan: recon (two runs), seed, two waves with their critics and minters, the final-clean critic, consolidate, validate, write, verify, report', () => {
  const kinds = steps.map(s => `${s.step}${s.next.match(/kind=(\S+)/) ? `:${s.next.match(/kind=(\S+)/)[1]}` : ''}`)
  assert.deepEqual(kinds, ['recon', 'recon', 'seed', 'plan-wave', 'hunt', 'merge-wave', 'critic:post-wave', 'mint', 'apply-critic', 'plan-wave', 'hunt', 'merge-wave', 'critic:post-wave', 'mint', 'apply-critic', 'critic:final-clean', 'mint', 'apply-critic', 'consolidate', 'validate', 'write-findings', 'verify', 'report', 'done'])
  assert.deepEqual(steps.filter(s => s.step === 'plan-wave').map(s => s.next), ['NEXT: plan-wave run=helper wave=1', 'NEXT: plan-wave run=helper wave=2'])
})
await test('the agents the run spent are exactly the scripted calls the workflow made, by upstream-shaped IDs: no ID twice, no verifier that was a hunter, and the rejected claim has no Phase 5 verifier', () => {
  const m = meta(RUN)
  assert.equal(m.agents_spent, driven.agentsCalled)
  assert.equal(m.agents_spent, 22)
  assert.equal(m.run_status, 'complete')
  assert.equal(m.incomplete_reason, null)
  assert.equal(m.execution_capability, 'none')
  assert.deepEqual(calls, { 'audit-researcher': 10, 'audit-analyst': 9, 'audit-synthesizer': 3 })
  const labels = steps.flatMap(s => s.calls.map(c => c.label))
  assert.deepEqual(labels, ['recon-1a', 'recon-1b', 'recon-1c', 'recon-1d', 'synth-recon', 'h1-01', 'h1-02', 'h1-03', 'c1', 'synth-mint1', 'h2-01', 'h2-02', 'c2', 'cf2', 'synth-cons', 'v01', 'v02', 'v03', 'v04', 'r02', 'r03', 'r04'])
  assert.equal(new Set(labels).size, labels.length, 'no agent ID is used twice')
  assert.equal(Object.values(m.stage_spend).reduce((a, b) => a + b, 0), 22, 'the per-stage spend adds up to the total')
})
await test('the ledger and findings.json pass both of upstream\'s own validators, the run passes check, and nothing but a needs_validation lead and a rejected claim is in findings.json: no confirmed anywhere', () => {
  assert.ok(validateLedgerFile(join(RUN, 'coverage-ledger.json')).valid)
  assert.ok(validateFindingsFile(join(RUN, 'findings.json')).valid)
  assert.equal(audit(['check', RUN]).last, `AUDIT: OK ${RUN} passes check`)
  const findings = readJson(join(RUN, 'findings.json'))
  assert.deepEqual(findings.map(f => [f.fingerprint, f.verdict]).sort(), [['config-service-key-literal', 'rejected'], ['cors-origin-reflected-with-credentials', 'needs_validation'], ['files-name-unchecked-path-join', 'needs_validation'], ['notes-byid-no-owner-check', 'needs_validation']])
  for (const f of findings.filter(f => f.verdict === 'needs_validation')) assert.ok(!('severity' in f) && !('execution' in f), 'a lead has no severity')
  for (const file of ['findings.json', 'coverage-ledger.json', 'candidates.json', 'decisions.json']) assert.ok(!/"verdict": "confirmed"|"proposed_verdict": "confirmed"|"decision": "confirmed"/.test(readFileSync(join(RUN, file), 'utf8')), `${file} holds no confirmed verdict`)
})
await test('the three reports exist, are the run\'s own, say complete and source-only, count zero confirmed, name the three leads at their planted lines and the rejected claim nowhere as a finding', () => {
  for (const f of ['REPORT.md', 'NEEDS-VALIDATION.md', 'FINDINGS-DETAIL.md']) assert.ok(existsSync(join(RUN, f)) && readFileSync(join(RUN, f), 'utf8').length > 100, f)
  const report = readFileSync(join(RUN, 'REPORT.md'), 'utf8')
  const needs = readFileSync(join(RUN, 'NEEDS-VALIDATION.md'), 'utf8')
  assert.match(report, /The run is \*\*complete\*\*/)
  assert.match(report, /no target code was executed/)
  assert.match(report, /Complete is not clean/)
  for (const fp of ['notes-byid-no-owner-check', 'files-name-unchecked-path-join', 'cors-origin-reflected-with-credentials']) {
    assert.ok(needs.includes(fp.replace(/_/g, '\\_')) || needs.includes(fp), `${fp} is in NEEDS-VALIDATION.md`)
    assert.ok(needs.includes(`${PLANTED[fp].file}:${PLANTED[fp].line}`.replace(/_/g, '\\_')) || needs.includes(`${PLANTED[fp].file}:${PLANTED[fp].line}`), `${fp} is reported at its line`)
  }
  assert.ok(!/config-service-key-literal/.test(needs), 'a rejected claim is not a lead')
  assert.match(readFileSync(join(RUN, 'FINDINGS-DETAIL.md'), 'utf8'), /no confirmed|No confirmed|none/i)
  assert.ok(!/\| *confirmed *\|.*\| *(critical|high|medium) *\|/i.test(report), 'no confirmed row with a severity')
})
await test('the commands for a finding and for the export, taken from the skill, make an INVESTIGATION ONLY task for each lead and an index of three, in the run directory only', () => {
  const taskCmd = skillCommands(skillText()).find(c => /audit-report\.mjs" task /.test(c))
  const exportCmd = skillCommands(skillText()).find(c => /audit-report\.mjs" export-remediation /.test(c))
  const task = runCommand(taskCmd, { ...vars, FINGERPRINT: 'notes-byid-no-owner-check' }, repo)
  assert.equal(task.status, 0, task.stdout)
  assert.match(task.stdout, /INVESTIGATION ONLY: the security lead `notes-byid-no-owner-check` is unproven/)
  assert.match(task.last, /^AUDIT: OK task notes-byid-no-owner-check needs_validation$/)
  const rejected = runCommand(taskCmd, { ...vars, FINGERPRINT: 'config-service-key-literal' }, repo)
  assert.equal(rejected.status, 1, 'a rejected claim is not a task')
  const exported = runCommand(exportCmd, vars, repo)
  assert.match(exported.last, /^AUDIT: OK export-remediation tasks=0 investigations=3 /)
  assert.equal(readJson(join(RUN, 'remediation', 'index.json')).length, 3)
  assert.equal(readdirSync(join(RUN, 'remediation')).length, 4)
})
await test('the audited repository was not touched: the same commit, a clean tree, no file the audit made outside .git, and the run lives in .git/security-audit', () => {
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), headBefore)
  assert.equal(sh(repo, 'status', '--porcelain'), '')
  assert.equal(sh(repo, 'status', '--porcelain', '--ignored'), '')
  assert.ok(RUN.startsWith(join(repo, '.git', 'security-audit')))
  assert.equal(sh(repo, 'ls-files').split('\n').length, Object.keys(TOY_FILES).length)
})
await test('the skill at the end of the run still passes its own drift test against the code, and the driver used only commands that are in it (no helper the skill does not name)', () => {
  const named = new Set(skillCommands(skillText()))
  for (const s of steps) for (const c of s.commands) assert.ok(named.has(c.command), `${c.command} is in SKILL.md`)
})
