import assert from 'node:assert/strict'
import { test } from '../scripts/workflow-harness.mjs'
import { createDecision, validateDecision } from '../core/skills/decisions/records.mjs'

const base = (patch = {}) => ({ schemaVersion: 1, id: 'choice-1', runId: 'workflow-1',
  repo: '/project/missing', revision: 'a'.repeat(40), question: 'Choose a mode', reason: 'Work is waiting',
  options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }], recommendation: null,
  evidence: [{ label: 'Local notes', uri: '/project/notes with spaces' }], kind: 'question', scope: null,
  createdAt: '2024-02-29T12:00:00Z', expiresAt: null, ...patch })
const approval = (patch = {}) => base({ kind: 'approval',
  options: [{ id: 'reject', label: 'Reject' }, { id: 'approve', label: 'Approve' }],
  scope: { action: 'deploy', resource: 'project/staging', revision: 'a'.repeat(40) }, ...patch })
function reject(value) {
  const errors = validateDecision(value)
  assert.ok(errors.length > 0)
  assert.ok(errors.every(item => typeof item === 'string' && !item.includes('PRIVATE_INPUT')))
  assert.throws(() => createDecision(value), error => error.code === 'INVALID_DECISION' &&
    !error.message.includes('PRIVATE_INPUT') && error.cause === undefined)
}

await test('decisions require every field and reject unexpected data at every object level', () => {
  for (const key of Object.keys(base())) {
    const input = base(); delete input[key]; reject(input)
    reject(base({ [key]: undefined }))
  }
  for (const value of [null, undefined, false, 0, 'PRIVATE_INPUT', [], new Date(), Object.create(base())]) reject(value)
  for (const select of [value => value, value => value.options[0], value => value.evidence[0], value => value.scope]) {
    for (const key of ['extra', Symbol('PRIVATE_INPUT')]) {
      const input = approval(); Object.defineProperty(select(input), key, { value: 'PRIVATE_INPUT' }); reject(input)
    }
  }
})

await test('decisions enforce identifier, revision, path and text boundaries', () => {
  for (const key of ['id', 'runId']) {
    for (const value of ['', '../x', 'x/y', '_x', 'a\n', 'a'.repeat(81), 1, null]) reject(base({ [key]: value }))
    assert.deepEqual(validateDecision(base({ [key]: 'A' + '_-0'.repeat(26) + 'z' })), [])
  }
  for (const revision of [null, 'a'.repeat(64), 'A'.repeat(40), 'a'.repeat(40) + '\n']) reject(base({ revision }))
  for (const repo of ['relative', '/a/../b', '/a/./b', '/a//b', '/a/', '/a\0b']) reject(base({ repo }))
  assert.deepEqual(validateDecision(base({ repo: '/' })), [])
  for (const key of ['question', 'reason']) {
    for (const value of ['', ' \n\t', 1, {}, 'x'.repeat(4097)]) reject(base({ [key]: value }))
    assert.deepEqual(validateDecision(base({ [key]: 'x'.repeat(4096) })), [])
  }
})

await test('decisions reject sparse arrays, extra array fields and invalid option/evidence members', () => {
  for (const key of ['options', 'evidence']) {
    for (const value of [null, {}, Array(2), [null, null], Array.from({ length: 21 }, () => ({}))]) reject(base({ [key]: value }))
    const input = base(); input[key].extra = 'PRIVATE_INPUT'; reject(input)
  }
  for (const id of ['../x', '', 'one']) reject(base({ options: [{ id: 'one', label: 'One' }, { id, label: 'Two' }] }))
  for (const label of ['', ' ', 'x'.repeat(257), 0]) {
    reject(base({ options: [{ id: 'one', label }, { id: 'two', label: 'Two' }] }))
    reject(base({ evidence: [{ label, uri: '/notes' }] }))
  }
  for (const uri of ['http://example.test', 'javascript:PRIVATE_INPUT', 'relative', 'https://', 'https:example.test', '/x\0y', 'https://example.test/\npath', '/' + 'x'.repeat(2048)]) {
    reject(base({ evidence: [{ label: 'Notes', uri }] }))
  }
  assert.deepEqual(validateDecision(base({ evidence: [{ label: 'x'.repeat(256), uri: '/' + 'x'.repeat(2047) }] })), [])
  reject(base({ recommendation: 'unknown' }))
})

await test('decision timestamps reject calendar rollover and compare UTC instants precisely', () => {
  for (const createdAt of ['2023-02-29T12:00:00Z', '2024-04-31T00:00:00Z', '2024-02-29T24:00:00Z',
    '2024-02-29T12:00:00+00:00', '2024-02-29', '2024-02-29T12:00:00Z\n']) reject(base({ createdAt }))
  for (const expiresAt of ['2024-02-29T12:00:00.000Z', '2024-02-29T11:59:59Z', 'bad']) reject(base({ expiresAt }))
  assert.deepEqual(validateDecision(base({ expiresAt: '2024-02-29T12:00:00.0001Z' })), [])
  assert.deepEqual(validateDecision(base({ createdAt: '2024-02-29T12:00:00.9Z', expiresAt: '2024-02-29T12:00:01Z' })), [])
})

await test('approval scope stays explicit and bound to the request revision', () => {
  assert.deepEqual(validateDecision(approval()), [])
  for (const action of ['merge', 'publish', 'deploy']) {
    const input = approval(); input.scope.action = action; input.scope.resource = 'r'.repeat(2048)
    assert.deepEqual(createDecision(input), input)
  }
  for (const scope of [null, {}, { action: 'delete', resource: 'r', revision: 'a'.repeat(40) },
    { action: 'merge', resource: '', revision: 'a'.repeat(40) },
    { action: 'merge', resource: 'r'.repeat(2049), revision: 'a'.repeat(40) },
    { action: 'merge', resource: 'r', revision: 'b'.repeat(40) }]) reject(approval({ scope }))
  reject(base({ scope: approval().scope }))
  reject(approval({ options: [...approval().options, { id: 'maybe', label: 'Maybe' }] }))
  reject(approval({ options: base().options }))
})

await test('decision snapshots detach all nested data without invoking getters or serialization hooks', () => {
  const input = approval(), before = structuredClone(input), output = createDecision(input)
  assert.deepEqual(input, before); assert.deepEqual(output, before)
  output.options[0].label = 'Changed'; output.evidence[0].uri = '/changed'; output.scope.resource = 'changed'
  assert.deepEqual(input, before)
  let invoked = 0
  for (const select of [value => value, value => value.options[0], value => value.evidence[0], value => value.scope]) {
    const value = approval(), target = select(value), key = Object.keys(target)[0]
    Object.defineProperty(target, key, { get() { invoked++; throw Error('PRIVATE_INPUT') } }); reject(value)
  }
  const value = base(); Object.defineProperty(value.options, '0', { get() { invoked++; throw Error('PRIVATE_INPUT') } }); reject(value)
  reject(base({ toJSON() { invoked++; return base() } }))
  assert.equal(invoked, 0)
  const proxy = Proxy.revocable({}, {}); proxy.revoke(); reject(proxy.proxy)
  const plain = Object.assign(Object.create(null), base())
  assert.deepEqual(createDecision(plain), base())
})
