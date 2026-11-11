// completed-stage-rejection.test.mjs - SA-AR01 implementation checks the frozen acceptance does not make: the completed-rejection brand is
// reachable only through applyStage's own context, a copy or wrapper of a branded error is never branded, the module exports no branding
// capability, and the command-line messages are unchanged. Ordinary fixtures and in-memory results only; no provider and no I/O injection.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '../../../scripts/workflow-harness.mjs'
import { newInit, returnedFile, stage as stageCli, stageDirOf } from './stage-fixtures.mjs'
import { atVerify, toValidate } from './verdict-fixtures.mjs'
import * as auditStage from '../skills/security-audit/audit-stage.mjs'
import { applyValidate } from '../skills/security-audit/audit-verdicts.mjs'
import { applyVerify } from '../skills/security-audit/audit-verify.mjs'
import { loadRun, nextStep } from '../skills/security-audit/audit-run.mjs'

const { applyStage, completedStageRejection, planStage } = auditStage
const DEFS = [{ name: 'ordinary', candidates: ['ordinary-fp'] }]
const thrown = work => { try { work() } catch (e) { return e } assert.fail('expected a refusal') }
const ALL_NULL = /^every verifier of the round returned nothing \(fixture: nothing returned\); no try was used \(1 agent\(s\) spent\): plan the stage again to retry it$/

// A fresh validate or verify round where every verifier returned null: the completed all-null branch of each applier.
async function allNullRound(kind) {
  const { runDir } = kind === 'validate' ? toValidate(DEFS) : await atVerify(DEFS)
  assert.equal(nextStep(loadRun(runDir)).step, kind)
  const plan = planStage(runDir)
  const input = JSON.parse(readFileSync(join(plan.stage.dir, 'input.json'), 'utf8'))
  const ids = (kind === 'validate' ? input.candidates : input.items).map(x => x.agent_id)
  const result = { status: 'done', reason: 'fixture: nothing returned', stage: kind, history: [], budgetSpent: ids.length,
    results: { part: input.part, verifiers: Object.fromEntries(ids.map(id => [id, null])) } }
  const events = []
  const ctx = { runDir, run: loadRun(runDir), stage: plan.stage, input, result, event: (...a) => events.push(a), notes: [] }
  return { runDir, plan, result, ctx, events, decisions: readFileSync(join(runDir, 'decisions.json')) }
}

for (const [kind, applier] of [['validate', applyValidate], ['verify', applyVerify]]) {
  await test(`${kind} all-null round: a direct applier call refuses unbranded; only applyStage's context brands the same round`, async () => {
    const r = await allNullRound(kind)
    const direct = thrown(() => applier(r.ctx))
    assert.equal(direct.constructor.name, 'Refusal')
    assert.match(direct.message, ALL_NULL)
    assert.equal(completedStageRejection(direct), null, 'no capability, no brand')
    assert.deepEqual(r.events.map(e => e[0]), ['escalated'], 'the existing completed-round event still precedes the refusal')
    assert.deepEqual(readFileSync(join(r.runDir, 'decisions.json')), r.decisions, 'no try was consumed')

    // A caller cannot hand in a branding capability of its own: an applier given a different function just calls that function.
    const foreign = thrown(() => applier({ ...r.ctx, rejectCompleted: message => { throw new Error(message) } }))
    assert.equal(completedStageRejection(foreign), null)

    // The same saved round through applyStage (the host path) is branded escalation with an unchanged message and Refusal class.
    const owned = thrown(() => applyStage(r.runDir, returnedFile(r.plan.stage.dir, r.result)))
    assert.equal(completedStageRejection(owned), 'escalation')
    assert.equal(owned.constructor.name, 'Refusal')
    assert.equal(owned.message, direct.message)
    assert.equal(loadRun(r.runDir).meta.agents_spent, r.ctx.run.meta.agents_spent + 1, 'the round is charged once, by stage key')
    assert.deepEqual(readFileSync(join(r.runDir, 'decisions.json')), r.decisions)
  })
}

await test('copies, wrappers and look-alikes of a branded rejection are not branded; the original object stays branded', async () => {
  const r = await allNullRound('validate')
  const branded = thrown(() => applyStage(r.runDir, returnedFile(r.plan.stage.dir, r.result)))
  assert.equal(completedStageRejection(branded), 'escalation')
  const wrapper = new Error('wrapped', { cause: branded })
  for (const value of [Object.create(branded), { ...branded }, structuredClone(branded), new Error(branded.message),
    Object.assign(new Error(branded.message), { constructor: branded.constructor }), wrapper, [branded], () => branded])
    assert.equal(completedStageRejection(value), null)
  assert.equal(completedStageRejection(wrapper.cause), 'escalation', 'a retained cause is the very object')
  assert.equal(completedStageRejection(branded), 'escalation', 'querying never consumes or changes the brand')
})

await test('audit-stage exports the classifier and no constructor, marker or branding capability', () => {
  assert.deepEqual(Object.keys(auditStage).filter(k => /reject|brand|refus|completed/i.test(k)), ['completedStageRejection'])
  assert.equal(completedStageRejection.length, 1)
  for (const k of Object.keys(auditStage)) assert.notEqual(auditStage[k] instanceof WeakMap, true, `${k} must not expose the identity map`)
})

await test('command-line apply of an escalation prints the existing refusal unchanged and exits 1', () => {
  const { runDir } = newInit()
  const plan = stageCli(['plan', runDir])
  assert.equal(plan.status, 0, plan.stdout)
  const dir = stageDirOf(plan, runDir)
  const out = stageCli(['apply', runDir, returnedFile(dir, { status: 'escalate', reason: 'fixture escalation', stage: 'recon', history: [], budgetSpent: 0 })])
  assert.equal(out.status, 1, out.stdout + out.stderr)
  assert.equal(out.last, 'AUDIT: FAIL recon facts escalated: fixture escalation (0 agent(s) spent; plan the stage again to retry it)')
  assert.equal(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')).status, 'escalate', 'the escalated result is still kept')
})
