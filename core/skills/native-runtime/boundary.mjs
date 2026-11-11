// Library port objects may contain functions; JSON data never may. Inspect port
// descriptors without executing getters, then validate each trusted capability.
import { types } from 'node:util'
import { createHash } from 'node:crypto'
import { copyJSON } from './schema.mjs'

export const error = code => Object.assign(new Error(`Native runtime: ${code}.`), { code })
export const fail = code => { throw error(code) }
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const nonempty = value => typeof value === 'string' && value.trim().length > 0
export const sha = value => createHash('sha256').update(value).digest('hex')
export function ownErrorCode(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || types.isProxy(value)) return undefined
  return Object.getOwnPropertyDescriptor(value, 'code')?.value
}
export function fields(value, code = 'INVALID_RUNTIME_INPUT') {
  if (!value || typeof value !== 'object' || types.isProxy(value)) fail(code)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail(code)
  const result = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !d?.enumerable || !Object.hasOwn(d, 'value')) fail(code)
    Object.defineProperty(result, key, { value: d.value, enumerable: true })
  }
  return result
}
export function exact(value, keys, code) {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail(code)
}
export function json(value, code = 'INVALID_RUNTIME_INPUT') {
  // Return ordinary detached objects for library consumers. copyJSON first
  // rejects hooks, exotic values and representation limits before serialization.
  return JSON.parse(JSON.stringify(copyJSON(value, code)))
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (record(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  return JSON.stringify(value)
}
