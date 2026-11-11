// Pure config inspection: no queue or provider access, including for doctor.
import { isAbsolute, normalize } from 'node:path'
import { exactRecord, validId } from './records.mjs'

export function validateDecisionConfig(input) {
  if (input === undefined) return undefined
  try {
    const value = exactRecord(input, ['store', 'runId', 'featureId', 'ids', 'timeoutMs'])
    if (typeof value.store !== 'string' || !isAbsolute(value.store) || value.store.includes('\0') ||
        normalize(value.store) !== value.store || !validId(value.runId) || !validId(value.featureId) ||
        !Number.isInteger(value.timeoutMs) || value.timeoutMs < 0 || value.timeoutMs > 2147483647 ||
        !Array.isArray(value.ids) || value.ids.length === 0 || Reflect.ownKeys(value.ids).length !== value.ids.length + 1) throw Error()
    const ids = Array.from({ length: value.ids.length }, (_, i) => {
      const field = Object.getOwnPropertyDescriptor(value.ids, String(i))
      if (!field?.enumerable || !Object.hasOwn(field, 'value') || !validId(field.value)) throw Error()
      return field.value
    })
    if (new Set(ids).size !== ids.length) throw Error()
    return { ...value, ids }
  } catch {
    throw Object.assign(new Error('Invalid decisions configuration (store, runId, featureId, ids, timeoutMs)'), { code: 'INVALID_DECISION' })
  }
}
