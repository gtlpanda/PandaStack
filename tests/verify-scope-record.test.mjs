import assert from 'node:assert/strict'
import { test } from '../scripts/workflow-harness.mjs'
import { parseScopeRecord, validateScopeJoin } from '../core/skills/verify/scope-record.mjs'

const scopeId = '11111111-2222-3333-4444-555555555555'
const bootId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const fields = () => ['1', scopeId, bootId, '101', '9007199254740993', '202', '9007199254740995', '202']
const record = () => parseScopeRecord(fields().join('\t') + '\n')
const row = (pid, parentPid, start, pgid = 202, state = 'S') => ({ pid, parentPid, start, pgid, state })
const facts = () => {
  const owner = row(101, 0, '9007199254740993', 90)
  const anchor = row(202, 101, '9007199254740995')
  const current = row(404, 303, '9007199254740999')
  return { bootId, owner, anchor, current, lineage: [{ ...current }, row(303, 202, '9007199254740997'), { ...anchor }] }
}

await test('scope parser preserves boundary integers and exact string birth identities', () => {
  const a = record(), b = record()
  assert.notStrictEqual(a, b)
  assert.equal(a.ownerStart, '9007199254740993')
  a.ownerPid = 1
  assert.equal(b.ownerPid, 101)
  const values = fields(); values[3] = '2147483647'; values[4] = '9'.repeat(20)
  assert.equal(parseScopeRecord(values.join('\t') + '\n').ownerPid, 2147483647)
  assert.equal(parseScopeRecord(values.join('\t') + '\n').ownerStart, '9'.repeat(20))
})

await test('scope parser rejects every scalar field grammar and malformed wire delimiter', () => {
  const line = fields().join('\t') + '\n'
  const invalid = [undefined, null, {}, Buffer.from(line), line.slice(0, -1), line + '\n', '\ufeff' + line,
    line.replace('\n', '\r\n'), line.replace('\t', ' '), line.replace('\t', '\t\t'), 'PRIVATE_SCOPE'.repeat(30)]
  for (const index of [3, 5, 7]) {
    for (const value of ['0', '01', '-1', '+1', '1.0', '2147483648', '1\r', '1 ', '1\n']) {
      const values = fields(); values[index] = value; invalid.push(values.join('\t') + '\n')
    }
  }
  for (const index of [4, 6]) {
    for (const value of ['0', '01', '-1', '+1', '1.0', '1'.repeat(21), '1\n']) {
      const values = fields(); values[index] = value; invalid.push(values.join('\t') + '\n')
    }
  }
  for (const index of [1, 2]) {
    const values = fields(); values[index] = 'AAAAAAAA-bbbb-cccc-dddd-eeeeeeeeeeee'; invalid.push(values.join('\t') + '\n')
  }
  for (const input of invalid) assert.throws(() => parseScopeRecord(input), error =>
    error.code === 'INVALID_SCOPE' && !error.message.includes('PRIVATE_SCOPE') && error.cause === undefined)
})

await test('scope join accepts live snapshots and the full lineage bound without modifying inputs', () => {
  const f = facts(), before = structuredClone(f)
  assert.equal(validateScopeJoin(record(), f), true)
  assert.deepEqual(f, before)
  for (const state of ['R', 'S', 'D', 'T', 't', 'I', 'W', 'P']) {
    const value = facts(); value.current = { ...value.anchor, state }; value.anchor.state = state
    value.lineage = [{ ...value.anchor }]
    assert.equal(validateScopeJoin(record(), value), true)
  }
  const value = facts()
  value.lineage = Array.from({ length: 255 }, (_, i) => row(1000 + i, i === 254 ? 202 : 1001 + i, String(i + 1)))
  value.lineage.push({ ...value.anchor }); value.current = { ...value.lineage[0] }
  assert.equal(validateScopeJoin(record(), value), true)
  value.lineage.unshift(row(999, 1000, '1')); value.current = { ...value.lineage[0] }
  assert.equal(validateScopeJoin(record(), value), false)
})

await test('scope join rejects missing, extra, custom and accessor-bearing records at every level', () => {
  let reads = 0
  for (const select of [x => x.r, x => x.f, x => x.f.owner, x => x.f.anchor, x => x.f.current, x => x.f.lineage[1]]) {
    for (const alteration of ['missing', 'extra', 'symbol', 'custom', 'accessor']) {
      const x = { r: record(), f: facts() }, target = select(x), key = Object.keys(target)[0]
      if (alteration === 'missing') delete target[key]
      if (alteration === 'extra') Object.defineProperty(target, 'extra', { value: true })
      if (alteration === 'symbol') target[Symbol('extra')] = true
      if (alteration === 'custom') Object.setPrototypeOf(target, { extra: true })
      if (alteration === 'accessor') Object.defineProperty(target, key, { enumerable: true, get() { reads++; throw Error('PRIVATE_SCOPE') } })
      assert.equal(validateScopeJoin(x.r, x.f), false)
    }
  }
  assert.equal(reads, 0)
})

await test('scope join rejects proxies without running traps, including lineage arrays and members', () => {
  let traps = 0
  const proxy = value => new Proxy(value, { getPrototypeOf() { traps++; throw Error('trap') }, get() { traps++; throw Error('trap') }, ownKeys() { traps++; throw Error('trap') } })
  for (const mutate of [x => { x.r = proxy(x.r) }, x => { x.f = proxy(x.f) },
    x => { x.f.owner = proxy(x.f.owner) }, x => { x.f.lineage = proxy(x.f.lineage) },
    x => { x.f.lineage[1] = proxy(x.f.lineage[1]) }]) {
    const x = { r: record(), f: facts() }; mutate(x)
    assert.equal(validateScopeJoin(x.r, x.f), false)
  }
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  assert.equal(validateScopeJoin(revoked.proxy, facts()), false)
  assert.equal(traps, 0)
})

await test('scope join rejects invalid proc scalars, dead rows, stale births and broken ancestry', () => {
  for (const select of [f => f.owner, f => f.anchor, f => f.current, f => f.lineage[1]]) {
    for (const [key, values] of Object.entries({ pid: [0, 1.5, '101', 2147483648], parentPid: [-1, '0', 2147483648],
      pgid: [0, 1.5, '202'], start: [0, '', '01', '1'.repeat(21)], state: ['Z', 'X', 's', '', 1] })) {
      for (const value of values) { const f = facts(); select(f)[key] = value; assert.equal(validateScopeJoin(record(), f), false) }
    }
  }
  for (const mutate of [f => { f.bootId = scopeId }, f => { f.owner.start = '1' }, f => { f.anchor.start = '1' },
    f => { f.owner.pgid = 202 }, f => { f.anchor.parentPid = 90 }, f => { f.lineage.reverse() },
    f => { f.lineage[1].pid = f.current.pid }, f => { f.lineage[1].parentPid = 1 },
    f => { f.lineage[1].pgid = 303 }, f => { f.lineage[0].state = 'R' }, f => { f.lineage.pop() }]) {
    const f = facts(); mutate(f); assert.equal(validateScopeJoin(record(), f), false)
  }
})

await test('scope join rejects sparse, decorated and accessor arrays without evaluating members', () => {
  let reads = 0
  for (const mutate of [f => { delete f.lineage[1] }, f => { f.lineage.extra = 1 },
    f => { f.lineage[Symbol('extra')] = 1 }, f => { Object.setPrototypeOf(f.lineage, null) },
    f => { Object.defineProperty(f.lineage, '1', { get() { reads++; throw Error('PRIVATE_SCOPE') } }) }]) {
    const f = facts(); mutate(f); assert.equal(validateScopeJoin(record(), f), false)
  }
  assert.equal(reads, 0)
})
