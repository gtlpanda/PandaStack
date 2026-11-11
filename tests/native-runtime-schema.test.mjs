import assert from 'node:assert/strict'
import { test } from '../scripts/workflow-harness.mjs'

const api = () => import('../core/skills/native-runtime/schema.mjs')
const coded = code => error => error.code === code
const textSchema = { type: 'string' }
const envelope = value => ({ json: JSON.stringify(value) })
const nest = count => { let value = 0; while (count--) value = [value]; return value }

await test('native schema accepts shared aliases but rejects cycles and exotic arrays without hooks', async () => {
  const { schemaProblems } = await api()
  const leaf = { x: [1, null] }
  assert.deepEqual(schemaProblems({ a: leaf, b: leaf }, { type: 'object' }), [])
  let calls = 0
  const getter = [0]
  Object.defineProperty(getter, '0', { get() { calls++; return 0 } })
  const setter = {}
  Object.defineProperty(setter, 'x', { enumerable: true, set() { calls++ } })
  const cyclic = []; cyclic.push(cyclic)
  for (const value of [getter, setter, cyclic, Object.assign([], { extra: 1 }),
    Object.setPrototypeOf([], null), new Date(0), new Number(1), new Map(),
    { toJSON() { calls++; return 1 } }]) {
    assert.ok(schemaProblems(value, { type: ['array', 'object'] }).length)
  }
  assert.equal(calls, 0)
})

await test('native schema rejects revoked and nested proxies before traps', async () => {
  const { schemaProblems, encodeOutputContract } = await api()
  let calls = 0
  const proxy = new Proxy([], {
    getPrototypeOf() { calls++; throw Error('private') },
    ownKeys() { calls++; throw Error('private') },
    getOwnPropertyDescriptor() { calls++; throw Error('private') },
    get() { calls++; throw Error('private') },
  })
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  for (const value of [proxy, revoked.proxy]) {
    assert.ok(schemaProblems([value], { type: 'array' }).length)
    assert.throws(() => encodeOutputContract({ type: 'string', enum: value }), coded('INVALID_SCHEMA'))
    assert.throws(() => encodeOutputContract(textSchema).decode({ json: value }), coded('INVALID_WIRE'))
  }
  assert.equal(calls, 0)
})

await test('native schema checks unvisited definitions and schema errors precede invalid values', async () => {
  const { schemaProblems, encodeOutputContract } = await api()
  for (const schema of [
    { type: 'boolean', minimum: 0 }, { type: 'number', minItems: 1 },
    { type: 'array', minItems: 1.5 }, { type: 'array', maxItems: 2 ** 53 },
    { type: 'object', required: [1] }, { type: 'string', enum: [0, -0] },
    { type: ['null', 1] }, { type: 'object', properties: { optional: {} } },
    { type: 'array', items: false }, { type: 'number', maximum: Infinity },
  ]) assert.throws(() => schemaProblems(undefined, schema), coded('INVALID_SCHEMA'))
  assert.throws(() => schemaProblems(undefined, { type: 'array', items: { type: 'string', format: 'x' } }), coded('UNSUPPORTED_SCHEMA'))
  const shared = { type: 'integer' }
  assert.deepEqual(encodeOutputContract({ type: 'object', properties: { a: shared, b: shared } })
    .decode(envelope({ a: 1, b: 2 })), { a: 1, b: 2 })
})

await test('native schema counts exact serialized bytes including escaping and whole envelope overhead', async () => {
  const { schemaProblems, encodeOutputContract } = await api()
  const limit = 1048576
  assert.deepEqual(schemaProblems('a'.repeat(limit - 2), textSchema), [])
  assert.ok(schemaProblems('a'.repeat(limit - 1), textSchema).length)
  assert.deepEqual(schemaProblems('é'.repeat((limit - 2) / 2), textSchema), [])
  assert.ok(schemaProblems('\n'.repeat(limit / 2), textSchema).length)
  const schema = { type: 'string', description: '' }
  schema.description = 'a'.repeat(limit - Buffer.byteLength(JSON.stringify(schema)))
  encodeOutputContract(schema)
  assert.throws(() => encodeOutputContract({ ...schema, description: schema.description + 'a' }), coded('INVALID_SCHEMA'))
  const overhead = Buffer.byteLength(JSON.stringify(envelope('')))
  const value = 'a'.repeat(limit - overhead)
  const contract = encodeOutputContract(textSchema)
  assert.equal(contract.decode(envelope(value)), value)
  assert.throws(() => contract.decode(envelope(value + 'a')), coded('INVALID_WIRE'))
})

await test('native schema container depth counts actual representation and open values', async () => {
  const { schemaProblems, encodeOutputContract } = await api()
  assert.deepEqual(schemaProblems(nest(64), { type: 'array' }), [])
  assert.ok(schemaProblems(nest(65), { type: 'array' }).length)
  let schema = textSchema
  for (let i = 1; i < 64; i++) schema = { type: 'array', items: schema }
  encodeOutputContract(schema)
  assert.throws(() => encodeOutputContract({ type: 'array', items: schema }), coded('INVALID_SCHEMA'))
  const contract = encodeOutputContract({ type: 'array' })
  assert.throws(() => contract.decode(envelope(nest(65))), coded('INVALID_RESULT'))
})

await test('native schema union constraints and mixed scalar enums remain exact', async () => {
  const { schemaProblems } = await api()
  const schema = { type: ['object', 'array', 'integer', 'null'], properties: { x: textSchema },
    required: ['x'], additionalProperties: false, items: { type: 'boolean' },
    minItems: 1, maxItems: 2, minimum: 2, maximum: 3 }
  for (const value of [{ x: 'ok' }, [true], 2, null]) assert.deepEqual(schemaProblems(value, schema), [])
  for (const value of [{}, { x: 'ok', y: 1 }, [], [0], 1, 2.5, '2']) assert.ok(schemaProblems(value, schema).length)
  const mixed = { type: ['string', 'boolean', 'number', 'null'], enum: ['1', 1, true, null] }
  for (const value of mixed.enum) assert.deepEqual(schemaProblems(value, mixed), [])
  for (const value of [false, 0, 'true']) assert.ok(schemaProblems(value, mixed).length)
})

await test('native schema wire descriptors and nonfinite JSON fail with safe distinct codes', async () => {
  const { encodeOutputContract } = await api()
  const contract = encodeOutputContract({ type: 'object' })
  let calls = 0
  const wire = { get json() { calls++; return '{}' } }
  assert.throws(() => contract.decode(wire), coded('INVALID_WIRE'))
  assert.equal(calls, 0)
  for (const json of ['{"private": [1e400]}', '{"private": -1e400}', 'private']) {
    assert.throws(() => contract.decode({ json }), error => error.code === 'INVALID_JSON' && !error.message.includes('private'))
  }
  assert.throws(() => contract.decode(envelope('{}')), coded('INVALID_RESULT'))
  assert.deepEqual(contract.decode(Object.assign(Object.create(null), { json: '{}' })), {})
})

await test('native schema diagnostics never expose dynamic names and stay bounded at deep paths', async () => {
  const { schemaProblems } = await api()
  let value = Object.fromEntries(Array.from({ length: 150 }, (_, i) => ['PRIVATE' + i, false]))
  let schema = { type: 'object', additionalProperties: false }
  for (let i = 0; i < 25; i++) {
    value = { PRIVATE: value }
    schema = { type: 'object', properties: { PRIVATE: schema } }
  }
  const errors = schemaProblems(value, schema)
  assert.equal(errors.length, 100)
  assert.ok(errors.every(error => error.length <= 256 && !error.includes('PRIVATE')))
})
