// lifecycle-status-types.test.mjs - SA-LT01 lifecycle feedback: a transition status must be a string. A value that is not a string but
// converts to a legal status (['covered'] names the key 'covered') is a property-key coercion, not a status. The owner
// (audit-ledger.mjs criticTransitionContext / inspectCriticTransitions) and the workflow's check of the serialized public context
// (security-audit-flow.js transitionProblem) must both refuse it. Ordinary in-memory records and scripted agents only: no run files,
// provider, target code or process control. Run by scripts/test-workflow.mjs.
import assert from 'node:assert/strict'
import { test, load, run } from '../../../scripts/workflow-harness.mjs'
import { criticTransitionContext, inspectCriticTransitions } from '../skills/security-audit/audit-ledger.mjs'

const { fn } = load(new URL('../workflows/security-audit-flow.js', import.meta.url))

const LEGAL = ['blocked', 'covered', 'candidate', 'deferred', 'planned', 'in_progress', 'out_of_scope', 'not_applicable']
const NON_REASSIGNABLE_CODES = { deferred: 'DEFERRED_NOT_REOPENABLE', planned: 'NO_LIVE_EVIDENCE', in_progress: 'NO_LIVE_EVIDENCE', out_of_scope: 'TERMINAL_SCOPE', not_applicable: 'TERMINAL_SCOPE' }
// Not strings, and either converting to a legal status ([s] and [[s]] stringify to s) or to a key that is never one.
const notStrings = status => [[status], [[status]]]
const OTHER_NON_STRINGS = [null, 0, 1, true, false, {}, []]
const invalidInput = e => e.code === 'INVALID_INPUT'
const critic = (extra = {}) => ({ missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: false, ...extra })

const rowsOf = statuses => statuses.map(status => ({ coverage_id: `id-${status}`, status }))
const workflowInput = transitionContext => ({
  stage: 'critic', kind: 'post-wave', wave: 1, hunted: true, tree: '/inert/tree', profile: 'standard', maxParallel: 1,
  execution: { capability: 'none', blockers: ['source only'] }, architecture_md: 'ordinary architecture',
  parts: { criticSection: 'ordinary methodology' }, ledger: rowsOf(['covered', 'deferred']), candidates: [], prior: { records: [] }, transitionContext,
})
const escalatesBeforeAgent = async (context, why) => {
  const out = await run(fn, {}, workflowInput(context))
  assert.equal(out.result.status, 'escalate', why)
  assert.match(out.result.reason, /^args\.transitionContext is malformed$/, why)
  assert.equal(out.calls.length, 0, `${why}: no agent may be called`)
}

await test('criticTransitionContext still maps every string status to its existing vocabulary', () => {
  const c = criticTransitionContext(rowsOf(LEGAL))
  assert.equal(c.maxSemanticAttempts, 2)
  assert.deepEqual(c.reassignableIds, ['id-blocked', 'id-candidate', 'id-covered'])
  assert.deepEqual(c.nonReassignable.map(r => [r.coverageId, r.status, r.code]), [
    ['id-deferred', 'deferred', 'DEFERRED_NOT_REOPENABLE'], ['id-in_progress', 'in_progress', 'NO_LIVE_EVIDENCE'],
    ['id-not_applicable', 'not_applicable', 'TERMINAL_SCOPE'], ['id-out_of_scope', 'out_of_scope', 'TERMINAL_SCOPE'],
    ['id-planned', 'planned', 'NO_LIVE_EVIDENCE'],
  ])
})

await test('criticTransitionContext refuses a non-string status that converts to a legal one, for every legal status', () => {
  for (const status of LEGAL) for (const bad of notStrings(status)) {
    assert.throws(() => criticTransitionContext([{ coverage_id: 'x', status: bad }]), invalidInput, `status ${JSON.stringify(bad)}`)
  }
})

await test('criticTransitionContext refuses other non-string statuses, an absent status and near-miss or prototype-key strings', () => {
  for (const bad of OTHER_NON_STRINGS) assert.throws(() => criticTransitionContext([{ coverage_id: 'x', status: bad }]), invalidInput, `status ${JSON.stringify(bad)}`)
  assert.throws(() => criticTransitionContext([{ coverage_id: 'x' }]), invalidInput, 'absent status')
  for (const bad of ['Covered', ' covered', 'covered ', 'covered\n', '', ' ', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.throws(() => criticTransitionContext([{ coverage_id: 'x', status: bad }]), invalidInput, `status ${JSON.stringify(bad)}`)
  }
})

await test('one wrongly typed status refuses the whole ledger instead of leaving a partial context from its siblings', () => {
  const siblings = rowsOf(['covered', 'deferred'])
  assert.throws(() => criticTransitionContext([...siblings, { coverage_id: 'wrapped', status: ['covered'] }]), invalidInput)
  assert.throws(() => criticTransitionContext([{ coverage_id: 'wrapped', status: ['deferred'] }, ...siblings]), invalidInput)
  const before = JSON.stringify(siblings)
  assert.deepEqual(criticTransitionContext(siblings).reassignableIds, ['id-covered'])
  assert.equal(JSON.stringify(siblings), before, 'the sibling rows are never mutated')
})

await test('inspectCriticTransitions shares the status rule and does not accept a wrapped ID as a reassignment', () => {
  const rows = rowsOf(['covered', 'deferred'])
  assert.deepEqual(inspectCriticTransitions(rows, critic({ reassign_ids: ['id-covered', 'id-deferred'] })),
    { acceptedReassignIds: ['id-covered'], rejected: [{ coverageId: 'id-deferred', code: 'DEFERRED_NOT_REOPENABLE' }] })
  assert.throws(() => inspectCriticTransitions([...rows, { coverage_id: 'wrapped', status: ['covered'] }], critic({ reassign_ids: ['id-covered'] })), invalidInput)
  assert.throws(() => inspectCriticTransitions(rows, critic({ reassign_ids: [['id-covered']] })), invalidInput)
})

await test('the workflow delivers a context the owner produced, string statuses included, to exactly one critic call', async () => {
  const context = criticTransitionContext(rowsOf(['covered', 'deferred', 'planned']))
  const out = await run(fn, { 'audit-researcher': [prompt => {
    assert.ok(prompt.includes('untrusted-transition-context'))
    for (const text of ['id-covered', 'DEFERRED_NOT_REOPENABLE', 'NO_LIVE_EVIDENCE']) assert.ok(prompt.includes(text), text)
    return critic()
  }] }, workflowInput(context))
  assert.equal(out.result.status, 'done')
  assert.equal(out.calls.length, 1)
})

await test('the workflow escalates before any agent call on a non-string status in the public context, for every non-reassignable status', async () => {
  const good = criticTransitionContext(rowsOf(['covered', ...Object.keys(NON_REASSIGNABLE_CODES)]))
  for (const [status, code] of Object.entries(NON_REASSIGNABLE_CODES)) {
    for (const bad of notStrings(status)) {
      const context = { ...good, nonReassignable: [{ coverageId: 'held', status: bad, code }] }
      await escalatesBeforeAgent(context, `status ${JSON.stringify(bad)} with code ${code}`)
    }
  }
})

await test('the workflow escalates before any agent call on other non-string statuses', async () => {
  const good = criticTransitionContext(rowsOf(['covered', 'deferred']))
  for (const bad of OTHER_NON_STRINGS) {
    await escalatesBeforeAgent({ ...good, nonReassignable: [{ coverageId: 'held', status: bad, code: 'DEFERRED_NOT_REOPENABLE' }] }, `status ${JSON.stringify(bad)}`)
  }
})

await test('the workflow still refuses a wrong code and a reassignable status listed as non-reassignable', async () => {
  const good = criticTransitionContext(rowsOf(['covered', 'deferred']))
  await escalatesBeforeAgent({ ...good, nonReassignable: [{ coverageId: 'held', status: 'deferred', code: 'TERMINAL_SCOPE' }] }, 'wrong code')
  await escalatesBeforeAgent({ ...good, nonReassignable: [{ coverageId: 'held', status: 'covered', code: 'DEFERRED_NOT_REOPENABLE' }] }, 'a reassignable status')
  assert.deepEqual(good.reassignableIds, ['id-covered'])
  await escalatesBeforeAgent({ ...good, nonReassignable: [{ coverageId: 'id-covered', status: 'deferred', code: 'DEFERRED_NOT_REOPENABLE' }] }, 'an overlapping ID')
})
