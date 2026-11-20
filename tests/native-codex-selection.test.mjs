// CP-02c implementation edges the frozen acceptance does not pin: workflowPath
// read through own data descriptors (holes, getters, proxies, own method
// overrides), the accepted context shapes, the refusal's exact error shape, each
// accepted profile reaching CP-02b's single sandbox mapping, and the doctor still
// accepting exactly the shared effort list. Pure calls only: no file, process or
// provider.
import assert from 'node:assert/strict'
import { test } from '../scripts/workflow-harness.mjs'
import { readAgentConfig } from '../scripts/agent-config.mjs'

const api = () => import('../core/skills/native-runtime/codex-selection.mjs')
const MESSAGE = 'Native runtime: INVALID_SELECTION.'
const context = (overrides = {}) => ({ workflowId: 'harness-repair', workflowPath: ['harness-repair'], agentType: 'reviewer',
  label: 'reviewer: one', phase: 'Phase', requestedModel: 'sonnet', requestedEffort: 'high', ...overrides })

function refusal(fn) {
  try { fn() } catch (error) { return error }
  assert.fail('expected INVALID_SELECTION')
}
function assertRefused(fn) {
  const error = refusal(fn)
  assert.equal(error.code, 'INVALID_SELECTION')
  assert.equal(error.message, MESSAGE)
}

await test('a sparse workflowPath is refused: a hole is not a non-empty string', async () => {
  const { resolveLeaf } = await api()
  // eslint-disable-next-line no-sparse-arrays
  assertRefused(() => resolveLeaf(context({ workflowPath: [, 'harness-repair'] })))
  const tail = []; tail[1] = 'harness-repair'
  assertRefused(() => resolveLeaf(context({ workflowPath: tail })))
})

await test('a getter or proxy in workflowPath is refused without running caller code', async () => {
  const { resolveLeaf } = await api()
  let ran = false
  const getter = ['x', 'harness-repair']
  Object.defineProperty(getter, 0, { get() { ran = true; return 'dev-build' }, enumerable: true })
  assertRefused(() => resolveLeaf(context({ workflowPath: getter })))
  assert.equal(ran, false, 'the getter ran')
  const trapped = new Proxy(['harness-repair'], { get(target, key) { ran = true; return Reflect.get(target, key) } })
  assertRefused(() => resolveLeaf(context({ workflowPath: trapped })))
  assert.equal(ran, false, 'a proxy trap ran')
})

await test('own method overrides on workflowPath cannot hide a refused workflow', async () => {
  const { resolveLeaf } = await api()
  const path = ['release-flow', 'harness-repair']
  Object.defineProperties(path, {
    some: { value: () => false }, includes: { value: () => false }, at: { value: () => 'harness-repair' },
    every: { value: () => true },
  })
  assertRefused(() => resolveLeaf(context({ workflowPath: path })))
  // A refused workflow anywhere in a deeper path, too.
  assertRefused(() => resolveLeaf(context({ workflowPath: ['dev-build', 'security-audit-flow', 'harness-repair'] })))
  // The last element must be the workflowId even when it appears earlier.
  assertRefused(() => resolveLeaf(context({ workflowPath: ['harness-repair', 'dev-build'] })))
})

await test('null-prototype and frozen contexts are accepted and left unchanged', async () => {
  const { resolveLeaf } = await api()
  const expected = { selection: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, profile: 'source-review' }
  assert.deepEqual(resolveLeaf(Object.assign(Object.create(null), context())), expected)
  const frozen = Object.freeze({ ...context(), workflowPath: Object.freeze(['dev-build', 'harness-repair']) })
  assert.deepEqual(resolveLeaf(frozen), expected)
  assert.deepEqual(frozen, { ...context(), workflowPath: ['dev-build', 'harness-repair'] })
})

await test('a symbol key or a non-enumerable own key is refused', async () => {
  const { resolveLeaf } = await api()
  assertRefused(() => resolveLeaf({ ...context(), [Symbol('extra')]: 1 }))
  const hidden = context()
  Object.defineProperty(hidden, 'phase', { value: 'Phase', enumerable: false })
  assertRefused(() => resolveLeaf(hidden))
})

await test('the refusal is a fresh Error with only a code: no cause, no echo of the codexModel message', async () => {
  const { resolveLeaf } = await api()
  const error = refusal(() => resolveLeaf(context({ requestedModel: 'claude-secret-model-7' })))
  assert.ok(error instanceof Error)
  assert.deepEqual(Object.keys(error), ['code'])
  assert.equal(Object.hasOwn(error, 'cause'), false)
  assert.ok(!String(error.stack).includes('claude-secret-model-7'))
  assert.ok(!String(error.stack).includes('No Codex equivalent'))
  // A launcher refusal (NUL in the model) carries the same code, not the launcher's.
  assert.equal(refusal(() => resolveLeaf(context({ requestedModel: 'gpt-6\0x' }))).code, 'INVALID_SELECTION')
})

await test('every accepted role reaches the CP-02b sandbox: build-workspace writes, source-review reads', async () => {
  const { resolveLeaf, ROLE_PROFILES } = await api()
  const { sandboxForProfile } = await import('../core/skills/native-runtime/codex-provider.mjs')
  const { codexExecArgs } = await import('../core/skills/native-runtime/codex-exec.mjs')
  const sandboxes = { 'build-workspace': 'workspace-write', 'source-review': 'read-only' }
  let accepted = 0
  for (const [agentType, profile] of Object.entries(ROLE_PROFILES)) {
    if (!Object.hasOwn(sandboxes, profile)) {
      assertRefused(() => resolveLeaf(context({ agentType })))
      continue
    }
    const chosen = resolveLeaf(context({ agentType, workflowId: 'dev-build', workflowPath: ['dev-build'] }))
    assert.equal(chosen.profile, profile, agentType)
    assert.equal(sandboxForProfile(chosen.profile), sandboxes[profile], agentType)
    const args = codexExecArgs({ sandbox: sandboxForProfile(chosen.profile), model: chosen.selection.model, reasoningEffort: chosen.selection.effort })
    assert.equal(args[args.indexOf('--sandbox') + 1], sandboxes[profile], agentType)
    accepted++
  }
  assert.equal(accepted, 20)
})

await test('the doctor accepts exactly DOCTOR_EFFORTS, which no caller can change', async () => {
  const { DOCTOR_EFFORTS, resolveSettings } = await import('../core/skills/run-records/doctor.mjs')
  const central = readAgentConfig()
  for (const effort of DOCTOR_EFFORTS) {
    const settings = resolveSettings({ central, backend: 'codex', project: { codex: { reasoningEffort: effort } } })
    assert.equal(settings.values.effort, effort)
    const claude = resolveSettings({ central, backend: 'claude', project: { env: { vars: { CLAUDE_CODE_EFFORT_LEVEL: effort } } } })
    assert.equal(claude.values.effort, effort)
  }
  for (const effort of ['HIGH', 'extreme', 'auto', ' high']) {
    assert.throws(() => resolveSettings({ central, backend: 'codex', project: { codex: { reasoningEffort: effort } } }))
    const claude = resolveSettings({ central, backend: 'claude', project: { env: { vars: { CLAUDE_CODE_EFFORT_LEVEL: effort } } } })
    assert.equal(claude.values.effort, null)
  }
  assert.throws(() => { 'use strict'; DOCTOR_EFFORTS.push('extreme') })
  assert.equal(DOCTOR_EFFORTS.length, 8)
})
