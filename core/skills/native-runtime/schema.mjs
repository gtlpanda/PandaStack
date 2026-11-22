// Pure native output boundary. Original graph and vendored validators remain
// authoritative; the transport envelope never rewrites their schemas.
import { types } from 'node:util'

const MAX_BYTES = 1048576
const MAX_DEPTH = 64
const MAX_ERRORS = 100
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'minimum', 'maximum', 'minItems', 'maxItems', 'title', 'description', '$comment'])
// strictOutputSchema classifies every keyword exactly once: rebuilt structure,
// copied as is, or dropped (NR-01 decode still enforces dropped ones).
const STRICT_STRUCTURE = ['type', 'properties', 'required', 'additionalProperties', 'items']
const STRICT_KEPT = ['enum', 'description']
const STRICT_DROPPED = ['minimum', 'maximum', 'minItems', 'maxItems', 'title', '$comment']
const has = (value, key) => Object.hasOwn(value, key)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const reject = code => { throw Object.assign(new Error('Native output contract rejected.'), { code }) }
{
  const classified = [...STRICT_STRUCTURE, ...STRICT_KEPT, ...STRICT_DROPPED]
  if (classified.length !== KEYWORDS.size || new Set(classified).size !== classified.length ||
    classified.some(key => !KEYWORDS.has(key))) {
    throw new Error('schema.mjs: every KEYWORDS entry needs exactly one strict class.')
  }
}

// Inspect only data descriptors, never user property reads or serialization
// hooks. Count the exact serialized representation as we copy, including keys,
// escaping and repeated aliases; the active path detects cycles, not sharing.
export function copyJSON(input, code) {
  let bytes = 0
  const active = new WeakSet()
  const count = size => { bytes += size; if (bytes > MAX_BYTES) reject(code) }
  const stringBytes = value => {
    if (value.length > MAX_BYTES) reject(code)
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  }
  function visit(value, depth) {
    if (value === null) { count(4); return null }
    if (typeof value === 'string') { count(stringBytes(value)); return value }
    if (typeof value === 'boolean') { count(value ? 4 : 5); return value }
    if (typeof value === 'number' && Number.isFinite(value)) {
      count(JSON.stringify(value).length)
      return value
    }
    if (typeof value !== 'object' || types.isProxy(value)) reject(code)
    if (depth >= MAX_DEPTH || active.has(value)) reject(code)
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) reject(code)
    const keys = Reflect.ownKeys(value)
    const descriptors = []
    // Check descriptors before using their values, including array indices.
    for (const key of keys) {
      if (typeof key !== 'string') reject(code)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !has(descriptor, 'value') || (!descriptor.enumerable && !(array && key === 'length'))) reject(code)
      descriptors.push([key, descriptor.value])
    }
    let length = 0
    if (array) {
      length = Object.getOwnPropertyDescriptor(value, 'length').value
      if (keys.length !== length + 1) reject(code)
      for (let i = 0; i < length; i++) if (keys[i] !== String(i)) reject(code)
    }
    count(2)
    active.add(value)
    const result = array ? [] : Object.create(null)
    let index = 0
    for (const [key, item] of descriptors) {
      if (array && key === 'length') continue
      if (index++) count(1)
      if (!array) count(stringBytes(key) + 1)
      Object.defineProperty(result, key, { value: visit(item, depth + 1),
        enumerable: true, writable: true, configurable: true })
    }
    active.delete(value)
    return result
  }
  return visit(input, 0)
}

function validateSchema(schema) {
  const invalid = () => reject('INVALID_SCHEMA')
  if (!record(schema)) invalid()
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) reject('UNSUPPORTED_SCHEMA')
  const declared = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (!declared.length || declared.some(type => !TYPES.has(type)) || new Set(declared).size !== declared.length) invalid()
  const applicable = (...names) => { if (!names.some(name => declared.includes(name))) invalid() }
  for (const key of ['title', 'description', '$comment']) {
    if (has(schema, key) && typeof schema[key] !== 'string') invalid()
  }
  if (has(schema, 'properties')) {
    applicable('object')
    if (!record(schema.properties)) invalid()
    for (const child of Object.values(schema.properties)) validateSchema(child)
  }
  if (has(schema, 'required')) {
    applicable('object')
    if (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string') ||
      new Set(schema.required).size !== schema.required.length) invalid()
  }
  if (has(schema, 'additionalProperties')) {
    applicable('object')
    if (record(schema.additionalProperties)) reject('UNSUPPORTED_SCHEMA')
    if (typeof schema.additionalProperties !== 'boolean') invalid()
  }
  if (has(schema, 'items')) { applicable('array'); validateSchema(schema.items) }
  if (has(schema, 'enum')) {
    if (!Array.isArray(schema.enum) || !schema.enum.length) invalid()
    if (schema.enum.some(value => value !== null && typeof value === 'object')) reject('UNSUPPORTED_SCHEMA')
    if (new Set(schema.enum).size !== schema.enum.length) invalid()
  }
  for (const [low, high, kinds] of [
    ['minimum', 'maximum', ['number', 'integer']], ['minItems', 'maxItems', ['array']],
  ]) {
    for (const key of [low, high]) if (has(schema, key)) {
      applicable(...kinds)
      if (typeof schema[key] !== 'number' || !Number.isFinite(schema[key])) invalid()
      if (low === 'minItems' && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) invalid()
    }
    if (has(schema, low) && has(schema, high) && schema[low] > schema[high]) invalid()
  }
}

function captureSchema(schema) {
  const copy = copyJSON(schema, 'INVALID_SCHEMA')
  validateSchema(copy)
  return copy
}

function problems(value, schema) {
  const errors = []
  const fail = path => {
    if (errors.length < MAX_ERRORS) errors.push(`${path.slice(0, 220)}: invalid value`)
  }
  function visit(item, rule, path) {
    if (errors.length >= MAX_ERRORS) return
    const actual = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item
    const declared = Array.isArray(rule.type) ? rule.type : [rule.type]
    if (!declared.some(type => type === actual || (type === 'integer' && Number.isInteger(item)))) {
      fail(path); return
    }
    if (has(rule, 'enum') && !rule.enum.includes(item)) fail(path)
    if (actual === 'object') {
      for (const key of rule.required || []) {
        if (!has(item, key)) fail(path)
        if (errors.length >= MAX_ERRORS) return
      }
      let index = 0
      for (const key of Object.keys(item)) {
        const childPath = `${path}[${index++}]`
        if (rule.properties && has(rule.properties, key)) visit(item[key], rule.properties[key], childPath)
        else if (rule.additionalProperties === false) fail(childPath)
        if (errors.length >= MAX_ERRORS) return
      }
    } else if (actual === 'array') {
      if (item.length < rule.minItems || item.length > rule.maxItems) fail(path)
      if (rule.items) for (let i = 0; i < item.length && errors.length < MAX_ERRORS; i++) visit(item[i], rule.items, `${path}[${i}]`)
    } else if (actual === 'number') {
      if (item < rule.minimum || item > rule.maximum) fail(path)
    }
  }
  visit(value, schema, '$')
  return errors
}

export function schemaProblems(value, schema) {
  const captured = captureSchema(schema)
  let copy
  try { copy = copyJSON(value, 'INVALID_RESULT') }
  catch { return ['$: invalid JSON value'] }
  return problems(copy, captured)
}

// JSON.parse permits numeric overflow. Inspect parsed data iteratively so this
// classification does not depend on stack depth or expose parser diagnostics.
function rejectNonfinite(value) {
  const pending = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'number' && !Number.isFinite(item)) reject('INVALID_JSON')
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) pending.push(child)
    }
  }
}

// A frozen ordinary object or array. defineProperty keeps a key named __proto__ an
// own property instead of setting the prototype.
function frozenRecord(entries) {
  const result = {}
  for (const [key, value] of entries) {
    Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return Object.freeze(result)
}

// The single kind a strict node describes: a single type, or exactly [x, 'null'].
function strictKind(type, root) {
  if (typeof type === 'string') return root && type !== 'object' ? reject('UNSUPPORTED_SCHEMA') : type
  if (root || type.length !== 2 || type[0] === 'null' || type[1] !== 'null') reject('UNSUPPORTED_SCHEMA')
  return type[0]
}

function strictNode(node, root) {
  const kind = strictKind(node.type, root)
  const entries = [['type', Array.isArray(node.type) ? Object.freeze([...node.type]) : node.type]]
  for (const key of STRICT_KEPT) {
    if (has(node, key)) entries.push([key, Array.isArray(node[key]) ? Object.freeze([...node[key]]) : node[key]])
  }
  if (kind === 'object') {
    const keys = has(node, 'properties') ? Object.keys(node.properties) : []
    const required = has(node, 'required') ? node.required : []
    // validateSchema made `required` unique, so equal length plus membership is set equality.
    if (!keys.length || required.length !== keys.length || required.some(key => !has(node.properties, key)) ||
      node.additionalProperties === true) reject('UNSUPPORTED_SCHEMA')
    entries.push(['properties', frozenRecord(keys.map(key => [key, strictNode(node.properties[key], false)]))],
      ['required', Object.freeze([...keys])], ['additionalProperties', false])
  }
  if (kind === 'array') {
    if (!has(node, 'items')) reject('UNSUPPORTED_SCHEMA')
    entries.push(['items', strictNode(node.items, false)])
  }
  return frozenRecord(entries)
}

/** The strict subset of a leaf schema that Codex `--output-schema` takes (CP-02h). */
export function strictOutputSchema(schema) {
  return strictNode(captureSchema(schema), true)
}

export function encodeOutputContract(schema) {
  const captured = captureSchema(schema)
  const wireSchema = Object.freeze({ type: 'object',
    properties: Object.freeze({ json: Object.freeze({ type: 'string' }) }),
    required: Object.freeze(['json']), additionalProperties: false })
  return { wireSchema, decode(wire) {
    const checked = copyJSON(wire, 'INVALID_WIRE')
    if (!record(checked) || Object.keys(checked).length !== 1 || !has(checked, 'json') ||
      typeof checked.json !== 'string' || Buffer.byteLength(checked.json, 'utf8') > MAX_BYTES) reject('INVALID_WIRE')
    let parsed
    try { parsed = JSON.parse(checked.json) }
    catch { reject('INVALID_JSON') }
    rejectNonfinite(parsed)
    const copy = copyJSON(parsed, 'INVALID_RESULT')
    if (problems(copy, captured).length) reject('INVALID_RESULT')
    return parsed
  } }
}
