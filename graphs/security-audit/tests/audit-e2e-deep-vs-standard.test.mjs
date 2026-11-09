// audit-e2e-deep-vs-standard.test.mjs - P-10's whole offline deep audit of the toy repository, driven next to a standard audit with the same scripted agents (deepAnswer: the toy's
// units plus one lifecycle unit, which standard accepts too, SPEC M9). P-10's frozen test pins deep's path and agents as literal lists; this file pins that they are the ones a
// standard run takes, and that the second pass is the one thing a second audit of the same commit does differently in deep.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { mkRepo } from './audit-fixtures.mjs'
import { driveAudit } from './e2e-driver.mjs'
import { TOY_FILES } from './toy-app.mjs'
import { SECOND_PASS_REASON } from '../skills/security-audit/audit-ledger.mjs'
import { deepAnswer } from './profile-e2e-support.mjs'

console.log('== deep and standard end to end, the same scripted agents')

const readJson = f => JSON.parse(readFileSync(f, 'utf8'))
const stepOf = s => `${s.step}${s.next.match(/kind=(\S+)/) ? `:${s.next.match(/kind=(\S+)/)[1]}` : ''}`
const unitRow = u => [u.coverage_id, u.status, u.agent_id, u.wave, u.attempts.length]

function summarize(d) {
  return {
    path: d.trace.map(stepOf),
    labels: d.trace.flatMap(s => s.calls.map(c => c.label)),
    units: readJson(join(d.RUN, 'coverage-ledger.json')),
    findings: readJson(join(d.RUN, 'findings.json')).map(f => [f.fingerprint, f.verdict]),
  }
}

// Each profile audits its own copy of the toy repository twice: the second audit finds the first as its earlier run.
async function twoAudits(profile) {
  const repo = mkRepo(TOY_FILES, `toy-${profile}`)
  const initArgs = ['--profile', profile, '--max-parallel', '2']
  const first = summarize(await driveAudit({ repo, answer: deepAnswer, initArgs }))
  const second = summarize(await driveAudit({ repo, answer: deepAnswer, initArgs }))
  return { first, second }
}

const deep = await twoAudits('deep')
const standard = await twoAudits('standard')

await test('a first deep audit takes standard\'s path and spends standard\'s agents, call for call', () => {
  assert.deepEqual(deep.first.path, standard.first.path)
  assert.deepEqual(deep.first.labels, standard.first.labels)
  assert.equal(deep.first.labels.length, 22)
})

await test('a first deep audit ends with standard\'s ledger and findings: the same units in the same states, the same verdicts', () => {
  assert.deepEqual(deep.first.units.map(unitRow), standard.first.units.map(unitRow))
  assert.deepEqual(deep.first.findings, standard.first.findings)
})

// The second audits, measured: both hunt the two units the first run covered in wave 1 (an earlier run's same-source unit is hunted, last, in every profile);
// deep then archives that pass and hunts them again in wave 2, which costs two hunters and that wave's post-wave critic.
const WAVE = ['plan-wave', 'hunt', 'merge-wave', 'critic:post-wave', 'mint', 'apply-critic']
const SECOND_PASSED = ['src/auth.js#currentUser', 'src/server.js#server']
const secondPassed = r => r.units.filter(u => u.attempts.some(a => a.reassignment_reason === SECOND_PASS_REASON))

await test('a second audit of the same commit: standard runs one wave and 19 agents, deep one wave more for the second pass and 22 agents', () => {
  assert.deepEqual(standard.second.path, ['recon', 'recon', 'seed', ...WAVE, 'critic:final-clean', 'mint', 'apply-critic', 'consolidate', 'validate', 'write-findings', 'verify', 'report', 'done'])
  assert.deepEqual(deep.second.path, ['recon', 'recon', 'seed', ...WAVE, ...WAVE, 'critic:final-clean', 'mint', 'apply-critic', 'consolidate', 'validate', 'write-findings', 'verify', 'report', 'done'])
  const tail = ['synth-cons', 'v01', 'v02', 'v03', 'v04', 'r02', 'r03', 'r04']
  assert.deepEqual(standard.second.labels, ['recon-1a', 'recon-1b', 'recon-1c', 'recon-1d', 'synth-recon', 'h1-01', 'h1-02', 'h1-03', 'c1', 'synth-mint1', 'cf1', ...tail])
  assert.deepEqual(deep.second.labels, ['recon-1a', 'recon-1b', 'recon-1c', 'recon-1d', 'synth-recon', 'h1-01', 'h1-02', 'h1-03', 'c1', 'synth-mint1', 'h2-01', 'h2-02', 'c2', 'cf2', ...tail])
})

await test('a second audit of the same commit: standard gives no second pass; deep archives exactly the pass standard keeps live, and nothing else differs', () => {
  assert.deepEqual(secondPassed(standard.second), [])
  const passed = secondPassed(deep.second)
  assert.deepEqual(passed.map(u => u.canonical_refs.surface).sort(), SECOND_PASSED)
  for (const u of passed) {
    const kept = standard.second.units.find(s => s.coverage_id === u.coverage_id)
    assert.deepEqual([kept.prior_status, kept.status, kept.wave, kept.attempts.length], ['prior_covered_same_source', 'covered', 1, 0], u.coverage_id)
    assert.deepEqual([u.attempts[0].status, u.attempts[0].agent_id, u.attempts[0].wave], [kept.status, kept.agent_id, kept.wave], u.coverage_id)
    assert.deepEqual([u.status, u.wave, /^h2-\d+$/.test(u.agent_id)], ['covered', 2, true], u.coverage_id)
  }
  const others = r => r.units.filter(u => !SECOND_PASSED.includes(u.canonical_refs.surface)).map(unitRow)
  assert.deepEqual(others(deep.second), others(standard.second))
  assert.deepEqual(deep.second.findings, standard.second.findings)
})
