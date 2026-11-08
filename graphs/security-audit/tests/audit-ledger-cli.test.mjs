// audit-ledger-cli.test.mjs - audit-ledger.mjs end to end on the command line, with `audit-run.mjs next` and `check` between
// every step: the state contract the two files share, a whole run through two waves and both critics, and the symlinked skill dir.
import { dirname, join } from 'node:path'
import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { advanceState } from '../skills/security-audit/audit-run.mjs'
import { AUDIT_LEDGER, ENV, audit, fresh, ledgerCli, newRun, sandbox } from './audit-fixtures.mjs'
import { assignments, candidateOf, hunterResult, hunterUnit, readJsonFile, readLedger, reconInput, refsOf, seeded, unitInput } from './ledger-fixtures.mjs'

const named = (name, over = {}) => unitInput(name, { canonical_refs: refsOf(name, { subsystem: over.subsystem ?? 'src' }), ...over })
const inputs = fresh('cli-inputs')
let n = 0
const file = (value) => { const f = join(inputs, `in-${++n}.json`); writeFileSync(f, JSON.stringify(value)); return f }
const step = (runDir, expected) => {
  assert.equal(audit(['next', runDir]).last, expected)
  assert.equal(audit(['check', runDir]).last, `AUDIT: OK ${runDir} passes check`)
}
const ok = (r, prefix) => { assert.equal(r.status, 0, r.stdout + r.stderr); assert.ok(r.last.startsWith(`AUDIT: OK ${prefix}`), r.last) }
const critic = (over = {}) => ({ missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: false, ...over })
const saveCritic = (runDir, kind) => { advanceState(runDir, 'critic', { critic_kind: kind }); advanceState(runDir, 'mint') }

console.log('== a whole run on the command line')
await test('two waves, a reopened unit, a minted unit, both critics: next and check agree after every step, and the lead reaches validation', () => {
  const { runDir } = newRun()
  step(runDir, 'NEXT: seed run=helper')
  ok(ledgerCli(['seed', runDir, file(reconInput([named('a'), named('b', { subsystem: 'web' })]))]), 'seed units=2')
  step(runDir, 'NEXT: plan-wave run=helper wave=1')
  ok(ledgerCli(['plan-wave', runDir]), 'plan-wave wave=1 hunters=2 assigned=2')
  step(runDir, 'NEXT: hunt run=workflow wave=1')
  advanceState(runDir, 'hunt')
  const first = assignments(runDir)
  const ids = Object.fromEntries(readLedger(runDir).map(u => [u.canonical_refs.surface.split('#')[1], u]))
  const results = Object.fromEntries(Object.entries(first).map(([agent, [id]]) => [agent, hunterResult([hunterUnit(id, agent)])]))
  results[ids.a.agent_id] = hunterResult([hunterUnit(ids.a.coverage_id, ids.a.agent_id, { disposition: 'candidate', candidate_fingerprints: ['fp-lead'] })], { candidates: [candidateOf('fp-lead')], uncovered: [{ surface: 'queue', boundary: 'b', subsystem: 's', attack_class: 'a', starting_paths: ['src/db.js'], reason: 'nobody owns the consumer' }] })
  ok(ledgerCli(['merge-wave', runDir, file(results)]), 'merge-wave wave=1 merged=2 failed=0 deferred=0 candidates=1 uncovered_queued=1')
  step(runDir, 'NEXT: critic run=workflow kind=post-wave wave=1')
  saveCritic(runDir, 'post-wave')
  step(runDir, 'NEXT: apply-critic run=helper wave=1')
  const minted = named('queue', { reason: 'nobody owns the consumer', starting_paths: ['src/db.js'] })
  ok(ledgerCli(['apply-critic', runDir, file(critic({ reassign_ids: [ids.a.coverage_id] })), file({ units: [minted] })]), 'apply-critic wave=1 kind=post-wave units_added=1 out_of_scope=0 reassigned=1')
  step(runDir, 'NEXT: plan-wave run=helper wave=2')
  ok(ledgerCli(['plan-wave', runDir]), 'plan-wave wave=2 hunters=1 assigned=2')
  advanceState(runDir, 'hunt')
  const second = assignments(runDir)
  assert.deepEqual(Object.keys(second), ['h2-01'])
  ok(ledgerCli(['merge-wave', runDir, file({ 'h2-01': hunterResult(second['h2-01'].map(id => hunterUnit(id, 'h2-01'))) })]), 'merge-wave wave=2 merged=2')
  saveCritic(runDir, 'post-wave')
  ok(ledgerCli(['apply-critic', runDir, file(critic()), file({ units: [] })]), 'apply-critic wave=2')
  step(runDir, 'NEXT: critic run=workflow kind=final-clean wave=2')
  saveCritic(runDir, 'final-clean')
  ok(ledgerCli(['apply-critic', runDir, file(critic({ stop: true })), file({ units: [] })]), 'apply-critic wave=2 kind=final-clean units_added=0')
  step(runDir, 'NEXT: validate run=workflow')
  const units = readLedger(runDir)
  assert.deepEqual(units.map(u => u.status).sort(), ['covered', 'covered', 'covered'])
  const reopened = units.find(u => u.attempts.length === 1)
  assert.deepEqual([reopened.attempts[0].status, reopened.attempts[0].agent_id, reopened.agent_id, reopened.wave], ['candidate', 'h1-01', 'h2-01', 2])
  assert.deepEqual(readJsonFile(runDir, 'candidates.json').map(c => c.fingerprint), ['fp-lead'])
  assert.deepEqual(readJsonFile(runDir, 'uncovered.json'), [])
})

console.log('== the wave a unit carries')
await test('an assigned unit carries the wave it was hunted in, so the archive records that wave even when earlier waves did not close it', () => {
  const { runDir } = newRun()
  ok(ledgerCli(['seed', runDir, file(reconInput([named('a')]))]), 'seed units=1')
  const wave = (n, result) => {
    ok(ledgerCli(['plan-wave', runDir]), `plan-wave wave=${n}`)
    advanceState(runDir, 'hunt')
    const [unit] = readLedger(runDir)
    assert.deepEqual([unit.status, unit.wave, unit.agent_id], ['in_progress', n, `h${n}-01`], `assigned in wave ${n}`)
    ok(ledgerCli(['merge-wave', runDir, file({ [unit.agent_id]: result(unit) })]), `merge-wave wave=${n}`)
    saveCritic(runDir, 'post-wave')
  }
  wave(1, () => null)
  ok(ledgerCli(['apply-critic', runDir, file(critic()), file({ units: [] })]), 'apply-critic wave=1')
  wave(2, u => hunterResult([hunterUnit(u.coverage_id, u.agent_id)]))
  assert.equal(readLedger(runDir)[0].wave, 2, 'closed in the second wave, still wave 2 (the first failed)')
  ok(ledgerCli(['apply-critic', runDir, file(critic({ reassign_ids: [readLedger(runDir)[0].coverage_id] })), file({ units: [] })]), 'apply-critic wave=2')
  const [reopened] = readLedger(runDir)
  assert.deepEqual([reopened.attempts[0].wave, reopened.attempts[0].agent_id, reopened.wave, reopened.status], [2, 'h2-01', 3, 'planned'])
  wave(3, u => hunterResult([hunterUnit(u.coverage_id, u.agent_id)]))
  assert.deepEqual(readLedger(runDir)[0].attempts.map(a => a.wave), [2])
})

console.log('== through the symlink install.sh makes')
await test('audit-ledger.mjs runs through a symlinked skill directory, with its vendored validators found from the real file', () => {
  const link = join(fresh('linked'), 'security-audit')
  symlinkSync(dirname(AUDIT_LEDGER), link)
  const { runDir } = newRun()
  const viaLink = args => {
    const r = spawnSync(process.execPath, [join(link, 'audit-ledger.mjs'), ...args], { cwd: sandbox, encoding: 'utf8', env: { ...process.env, ...ENV } })
    return { status: r.status, out: r.stdout + r.stderr, last: r.stdout.trim().split('\n').at(-1) }
  }
  const seeded = viaLink(['seed', runDir, file(reconInput([named('a')]))])
  assert.deepEqual([seeded.status, seeded.last], [0, 'AUDIT: OK seed units=1 planned=1'], seeded.out)
  assert.equal(viaLink(['plan-wave', runDir]).last, 'AUDIT: OK plan-wave wave=1 hunters=1 assigned=1 deferred=0')
  assert.equal(viaLink([]).status, 2)
})

console.log('== a missing ledger is a refusal that says so')
await test('merge-wave, apply-critic and plan-wave refuse when coverage-ledger.json is missing, naming the file; none writes anything or fails with a JavaScript error', () => {
  const critic = '{"missing_units":[],"reassign_ids":[],"resolved_prior_leads":[],"stop":true}'
  for (const [step, cmd, inputs, extra] of [['hunt', 'merge-wave', ['{}'], {}], ['mint', 'apply-critic', [critic, '{"units":[]}'], { critic_kind: 'post-wave' }], ['seed', 'plan-wave', [], {}]]) {
    const { runDir } = seeded([unitInput('a')])
    advanceState(runDir, step, extra)
    const files = inputs.map((text, i) => { const f = join(runDir, `input-${i}.json`); writeFileSync(f, text); return f })
    rmSync(join(runDir, 'coverage-ledger.json'))
    const r = ledgerCli([cmd, runDir, ...files])
    assert.equal(r.status, 1, cmd)
    assert.match(r.last, /^AUDIT: FAIL coverage-ledger\.json is missing/, `${cmd}: ${r.last}`)
    assert.doesNotMatch(r.last, /Cannot read properties|undefined/, cmd)
  }
})
