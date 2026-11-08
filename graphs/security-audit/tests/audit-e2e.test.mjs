// audit-e2e.test.mjs - the first usable v1, offline: a whole audit of a fixture repository (the plan's toy notes API: a missing ownership check, a credential-shaped dummy
// string, an unsafe path join, permissive CORS) driven from `init` to `report` exactly as the entry skill says, by scripted agents through the workflow harness. What runs
// next is whatever `audit-run.mjs next` prints, dispatched through the skill's own table (e2e-driver.mjs reads SKILL.md); the real vendored validators run on every
// artifact inside the helpers. Two waves, a critic gap and its minter, a final-clean critic, consolidation, a rejected verdict, Phase 5, the three reports, a task and an export.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { audit, meta, mkRepo, sh } from './audit-fixtures.mjs'
import { candidateOf, checkOf, hunterResult, hunterUnit, needsValidationRecord, rejectedRecord } from './ledger-fixtures.mjs'
import { RESEARCH, SYNTH, UNIT } from './stage-fixtures.mjs'
import { driveAudit } from './e2e-driver.mjs'
import { PLANTED, TOY_FILES, lineOf } from './toy-app.mjs'
import { runCommand, skillCommands, skillText } from './skill-commands.mjs'
import { validateFindingsFile, validateLedgerFile } from '../skills/security-audit/upstream.mjs'

const NOTES = 'src/routes/notes.js', FILES = 'src/routes/files.js', CONFIG = 'src/config.js', CORS = 'src/cors.js'
// The coverage units the synthesizer proposes: source-derived refs, each in the files it names. notes and files share a subsystem, so one hunter owns both.
const unit = (name, over) => UNIT(name, over)
const UNITS = [
  unit('notes', { canonical_refs: { surface: `${NOTES}#handleNotes`, boundary: 'src/db.js#notes', subsystem: 'src/routes', attack_class: 'ATTACK-CLASSES.md#Access control' }, surface: 'GET /notes/:id', boundary: 'the notes store', subsystem: 'routes', attack_class: 'Access control', starting_paths: [NOTES], ordinary_attack_class_block: 'ATTACK-CLASSES.md#Access control', priority_class: 1 }),
  unit('files', { canonical_refs: { surface: `${FILES}#handleFiles`, boundary: `${FILES}#ROOT`, subsystem: 'src/routes', attack_class: 'ATTACK-CLASSES.md#Resource and file handling' }, surface: 'GET /files?name=', boundary: 'the uploads directory', subsystem: 'routes', attack_class: 'Resource and file handling', starting_paths: [FILES], ordinary_attack_class_block: 'ATTACK-CLASSES.md#Resource and file handling', priority_class: 1 }),
  unit('config', { canonical_refs: { surface: `${CONFIG}#SERVICE_API_KEY`, boundary: `${CONFIG}#config`, subsystem: 'src/config', attack_class: 'ATTACK-CLASSES.md#Cryptography and secrets' }, surface: 'the service key constant', boundary: 'the config object', subsystem: 'config', attack_class: 'Cryptography and secrets', starting_paths: [CONFIG], ordinary_attack_class_block: 'ATTACK-CLASSES.md#Cryptography and secrets', priority_class: 2 }),
  unit('cors', { canonical_refs: { surface: `${CORS}#withCors`, boundary: 'src/server.js#server', subsystem: 'src/cors', attack_class: 'ATTACK-CLASSES.md#Feature abuse and data leakage' }, surface: 'the CORS headers', boundary: 'the HTTP server', subsystem: 'cors', attack_class: 'Feature abuse and data leakage', starting_paths: [CORS], ordinary_attack_class_block: 'ATTACK-CLASSES.md#Feature abuse and data leakage', priority_class: 2 }),
]
const ROUTING = { surface: 'request routing by URL prefix', boundary: 'src/server.js#server', subsystem: 'src/server', attack_class: 'Access control', starting_paths: ['src/server.js'], selected_companion_blocks: [], excluded_blocks: [], reason: 'no unit owns the dispatcher that decides which handler, and so which checks, run' }
const CALLER = { surface: 'who the caller is', boundary: 'src/auth.js#currentUser', subsystem: 'src/auth', attack_class: 'Access control', starting_paths: ['src/auth.js'], selected_companion_blocks: [], excluded_blocks: [], reason: 'the caller identity is a header nobody verifies' }
const MINTED = [
  { ...UNITS[0], canonical_refs: { surface: 'src/server.js#server', boundary: 'src/routes/notes.js#handleNotes', subsystem: 'src/server', attack_class: 'ATTACK-CLASSES.md#Access control' }, surface: 'URL prefix routing', boundary: 'the handlers', subsystem: 'server', starting_paths: ['src/server.js'], priority_class: 2 },
  { ...UNITS[0], canonical_refs: { surface: 'src/auth.js#currentUser', boundary: 'src/routes/notes.js#handleNotes', subsystem: 'src/auth', attack_class: 'ATTACK-CLASSES.md#Access control' }, surface: 'caller identity', boundary: 'the handlers', subsystem: 'auth', starting_paths: ['src/auth.js'], priority_class: 2 },
]

const FP = Object.keys(PLANTED)
const trace = fp => [
  { kind: 'entrypoint', file: PLANTED[fp].file, line: 1, scope: 'module', description: 'The module the request reaches.' },
  { kind: 'sink', file: PLANTED[fp].file, line: PLANTED[fp].line, scope: 'handler', description: PLANTED[fp].title },
]
const evidenceOf = fp => [{ file: PLANTED[fp].file, line: PLANTED[fp].line, description: 'The line the weakness is on.' }]
const candidate = fp => candidateOf(fp, { title: PLANTED[fp].title, description: `${PLANTED[fp].title}.`, claimed_root_cause: `${fp} is as the source shows.`, trace: trace(fp), evidence: evidenceOf(fp), blockers: ['No sandbox exists to run the service.'], validation_plan: { local: 'Run the handler against a local fixture as a second user.' } })
const record = fp => ({ ...needsValidationRecord(fp, PLANTED[fp].file), title: PLANTED[fp].title, description: `${PLANTED[fp].title}.`, claimed_root_cause: `${fp} is as the source shows.`, trace: trace(fp), evidence: evidenceOf(fp) })
const FOUND = { [`${NOTES}`]: 'notes-byid-no-owner-check', [`${FILES}`]: 'files-name-unchecked-path-join', [`${CONFIG}`]: 'config-service-key-literal', [`${CORS}`]: 'cors-origin-reflected-with-credentials' }
const REJECTED = 'config-service-key-literal'   // the verifier finds the string is a placeholder: a rejected record

// What each scripted agent returns, by the label of its call. A wrong answer for a stage is refused by the helpers, so the run could not get past it.
function answer(label, { stage, input }) {
  if (stage === 'recon' && input.part === 'facts') return RESEARCH(label.replace('recon-', ''), { items: [{ text: `fact ${label}`, refs: [`${NOTES}:${lineOf(NOTES, 'handleNotes')}`, `${CORS}:${lineOf(CORS, 'withCors')}`] }] })
  if (label === 'synth-recon') return SYNTH({ architecture_md: 'A notes API: one HTTP server dispatches by URL prefix to a notes handler and a file handler, with a CORS wrapper and a config module.', units: UNITS })
  if (/^h\d+-\d+$/.test(label)) {
    const hunter = input.hunters.find(h => h.agent_id === label)
    const results = hunter.units.map(u => {
      const path = u.starting_paths
      const fp = FOUND[path[0]]
      const gap = path[0] === FILES ? [CALLER] : []
      return { u, fp, gap, check: checkOf(label, path) }
    })
    const found = results.filter(r => r.fp)
    return hunterResult(results.map(({ u, fp, check }) => hunterUnit(u.coverage_id, label, { reviewed_paths: u.starting_paths, checks: [check], ...(fp && { disposition: 'candidate', candidate_fingerprints: [fp] }) })), {
      candidates: found.map(r => candidate(r.fp)), uncovered: results.flatMap(r => r.gap), hardening: found.some(r => r.fp === FOUND[NOTES]) ? ['no rate limit on /notes'] : [],
    })
  }
  if (/^c1$/.test(label)) return { missing_units: [ROUTING], reassign_ids: [], resolved_prior_leads: [], stop: false }
  if (/^c\d+$|^cf\d+$/.test(label)) return { missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: true }
  if (/^synth-mintf?\d+$/.test(label)) return { units: input.proposals.map((p, i) => MINTED[i]).slice(0, input.proposals.length) }
  if (label === 'synth-cons') return { groups: input.candidates.map(c => ({ keep: c.fingerprint, merge: [], reason: '' })) }
  if (/^v\d+/.test(label)) {
    const c = input.candidates.find(x => x.agent_id === label)
    return c.fingerprint === REJECTED ? { decision: 'rejected', record: { ...rejectedRecord(c.fingerprint, PLANTED[c.fingerprint].file), trace: trace(c.fingerprint), evidence: evidenceOf(c.fingerprint), reason: 'The string is a placeholder: DUMMY and EXAMPLE are in it, and nothing reads it for a real service.' } } : { decision: 'needs_validation', record: record(c.fingerprint) }
  }
  if (/^r\d+/.test(label)) { const item = input.items.find(x => x.agent_id === label); return { decision: 'verified', fingerprint: item.fingerprint } }
  throw new Error(`no scripted answer for ${label} (${stage})`)
}

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
