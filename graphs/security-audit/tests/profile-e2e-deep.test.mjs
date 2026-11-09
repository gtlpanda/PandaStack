// profile-e2e-deep.test.mjs - P-10: a whole deep audit of the toy repository, offline, from `init --profile deep` to the reports, driven as the entry skill says, by scripted agents. The recon
// answer has one unit more than standard's, split off by a lifecycle mode; deep then runs standard's stage machine (critics to a clean pass, Phase 3 and Phase 5 as two passes). Acceptance
// test of the PR 9 profile contract (retro.md, entry 43), section P-10.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { audit, meta, mkRepo, sh } from './audit-fixtures.mjs'
import { driveAudit } from './e2e-driver.mjs'
import { TOY_FILES } from './toy-app.mjs'
import { validateFindingsFile, validateLedgerFile } from '../skills/security-audit/upstream.mjs'
import { SECOND_PASS_REASON } from './profile-support.mjs'
import { deepAnswer } from './profile-e2e-support.mjs'

console.log('== P-10: a whole deep audit, driven by the skill, offline')
const readJson = f => JSON.parse(readFileSync(f, 'utf8'))
const repo = mkRepo(TOY_FILES, 'toy')
const headBefore = sh(repo, 'rev-parse', 'HEAD')
const driven = await driveAudit({ repo, answer: deepAnswer, initArgs: ['--profile', 'deep', '--max-parallel', '2'] })
const { RUN, trace } = driven
const kinds = trace.map(s => `${s.step}${s.next.match(/kind=(\S+)/) ? `:${s.next.match(/kind=(\S+)/)[1]}` : ''}`)
const labels = trace.flatMap(s => s.calls.map(c => c.label))
const ledger = () => readJson(join(RUN, 'coverage-ledger.json'))

await test('the run is deep from init to done: complete, no budget, and the profile in the metadata and the status line', () => {
  assert.equal(audit(['next', RUN]).last, 'NEXT: done status=complete')
  const m = meta(RUN)
  assert.deepEqual([m.profile, m.run_status, m.incomplete_reason, m.budget], ['deep', 'complete', null, null])
  assert.match(audit(['status', RUN]).lines[0], /: profile deep, complete$/)
})
await test('the path is standard\'s stage machine: two waves with their critics and minters, a distinct final-clean critic, consolidate, validate, write, a separate verify stage, report', () => {
  assert.deepEqual(kinds, ['recon', 'recon', 'seed', 'plan-wave', 'hunt', 'merge-wave', 'critic:post-wave', 'mint', 'apply-critic', 'plan-wave', 'hunt', 'merge-wave', 'critic:post-wave', 'mint', 'apply-critic', 'critic:final-clean', 'mint', 'apply-critic', 'consolidate', 'validate', 'write-findings', 'verify', 'report', 'done'])
})
await test('the agents the run spent are the scripted calls: the lifecycle unit rides with its subsystem\'s hunter, so the count is standard\'s 22, with a Phase 3 verifier (v) and a different Phase 5 verifier (r) for each lead', () => {
  assert.deepEqual(labels, ['recon-1a', 'recon-1b', 'recon-1c', 'recon-1d', 'synth-recon', 'h1-01', 'h1-02', 'h1-03', 'c1', 'synth-mint1', 'h2-01', 'h2-02', 'c2', 'cf2', 'synth-cons', 'v01', 'v02', 'v03', 'v04', 'r02', 'r03', 'r04'])
  assert.equal(meta(RUN).agents_spent, 22)
})
await test('the ledger holds the lifecycle unit: its own coverage ID ending in the mode, the mode in the reference and the label, hunted and a candidate like its sibling; nothing is deferred; both validators pass', () => {
  const units = ledger()
  assert.equal(units.length, 7)
  const split = units.filter(u => u.lifecycle !== undefined)
  assert.equal(split.length, 1)
  assert.ok(split[0].lifecycle === 'delete' && split[0].canonical_refs.lifecycle === 'delete' && split[0].coverage_id.endsWith('::delete'))
  assert.equal(split[0].status, 'candidate')
  assert.notEqual(split[0].coverage_id, units.find(u => u.surface === 'GET /notes/:id').coverage_id, 'a lifecycle mode is a unit of its own')
  assert.ok(!units.some(u => u.status === 'deferred' || u.status === 'planned'))
  assert.ok(validateLedgerFile(join(RUN, 'coverage-ledger.json')).valid && validateFindingsFile(join(RUN, 'findings.json')).valid)
  assert.equal(audit(['check', RUN]).last, `AUDIT: OK ${RUN} passes check`)
})
await test('verification is two passes: each lead was verified in Phase 5 by an r verifier that is not its Phase 3 v verifier; nothing is marked merged', () => {
  const entries = readJson(join(RUN, 'decisions.json')).entries
  for (const e of entries.filter(e => e.decision === 'needs_validation')) {
    assert.equal(e.phase5.state, 'verified', e.fingerprint)
    assert.match(e.phase5.verifier_id, /^r\d{2}$/)
    assert.notEqual(e.phase5.verifier_id, e.verifier_id)
  }
  assert.ok(!entries.some(e => e.phase5?.state === 'merged'))
  assert.deepEqual(readJson(join(RUN, 'findings.json')).map(f => [f.fingerprint, f.verdict]), [['config-service-key-literal', 'rejected'], ['cors-origin-reflected-with-credentials', 'needs_validation'], ['files-name-unchecked-path-join', 'needs_validation'], ['notes-byid-no-owner-check', 'needs_validation']])
})
await test('the report says deep and is not a partial pass: the profile rules line, complete, source only, no partial pass and no "does not run the full method"', () => {
  const report = readFileSync(join(RUN, 'REPORT.md'), 'utf8')
  assert.ok(report.includes('- Profile rules: deep asked for units split per subsystem and lifecycle mode, ran critic waves to a clean pass'), 'the profile rules line')
  assert.ok(!report.includes('partial pass') && !report.includes('does not run the full method'), 'deep is more than standard, not less')
  assert.ok(report.includes('The run is **complete**') && report.includes('no target code was executed') && report.includes('Complete is not clean'))
  assert.ok(report.includes('The last critic was the final-clean critic of wave 2'))
})
await test('the audited repository was not touched: the same commit, a clean tree, nothing ignored', () => {
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), headBefore)
  assert.equal(sh(repo, 'status', '--porcelain', '--ignored'), '')
})

console.log('== P-10: a second deep audit of the same commit')
// The first audit above is the earlier run: it finds this repository's runs by itself (the git directory's security-audit/run-*). Its two units that were covered (the gaps the critic and the
// hunter found, minted in wave 1 and hunted in wave 2) are what the second audit's recon does not seed again, so they come back as prior_covered_same_source.
const second = await driveAudit({ repo, answer: deepAnswer, initArgs: ['--profile', 'deep', '--max-parallel', '2'] })
await test('the second run is complete and its report counts the earlier run; both validators and check pass', () => {
  const m = meta(second.RUN)
  assert.deepEqual([second.RUN === RUN, m.profile, m.run_status, m.incomplete_reason], [false, 'deep', 'complete', null])
  assert.ok(readFileSync(join(second.RUN, 'REPORT.md'), 'utf8').includes('- Earlier runs: 1 found, 1 compatible.'))
  assert.ok(validateLedgerFile(join(second.RUN, 'coverage-ledger.json')).valid && validateFindingsFile(join(second.RUN, 'findings.json')).valid)
  assert.equal(audit(['check', second.RUN]).last, `AUDIT: OK ${second.RUN} passes check`)
})
await test('deep gives the units the first run covered an independent second pass: archived with the contract\'s reason, hunted again in wave 2 by a fresh owner, once; no other unit is archived', () => {
  const units = readJson(join(second.RUN, 'coverage-ledger.json'))
  const passed = units.filter(u => u.attempts.some(a => a.reassignment_reason === SECOND_PASS_REASON))
  assert.deepEqual(passed.map(u => u.canonical_refs.surface).sort(), ['src/auth.js#currentUser', 'src/server.js#server'])
  for (const u of passed) assert.deepEqual([u.prior_status, u.status, u.wave, u.attempts.length, u.attempts[0].status, /^h2-\d+$/.test(u.agent_id)], ['prior_covered_same_source', 'covered', 2, 1, 'covered', true], u.canonical_refs.surface)
  assert.ok(units.filter(u => !passed.includes(u)).every(u => u.attempts.length === 0), 'nothing else was reopened')
})
