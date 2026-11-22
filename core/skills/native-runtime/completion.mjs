// The one builder of a runtime-conformant `failed` completion
// (spec/contracts/codex-parity-cp-05b.md). Given the selection the runtime resolved
// for a leaf, its result passes runtime.mjs completionFor and replays as a failed
// leaf (LEAF_FAILED inside the workflow). The reconcile CLI uses it to close a held
// call; CP-02g uses it to settle an oversize prompt.
import { exact, fail, fields, nonempty } from './boundary.mjs'

const INPUT = 'INVALID_RUNTIME_INPUT'
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/

// A plain object (no proxy, getter, symbol key or foreign prototype; a null
// prototype is allowed) with exactly `keys`. Returns a detached shallow copy.
function exactFields(value, keys) {
  const input = fields(value, INPUT)
  exact(input, keys, INPUT)
  return input
}

// failedCompletion({selection, code, invocationId}) -> {outcome: 'failed', code,
// usage: null, receipt: {provider, model, effort, invocationId}}. A new ordinary
// object that shares nothing with its input. Bad input throws the boundary's
// INVALID_RUNTIME_INPUT, whose fixed message never echoes a value.
export function failedCompletion(options) {
  const { selection, code, invocationId } = exactFields(options, ['selection', 'code', 'invocationId'])
  const { provider, model, effort } = exactFields(selection, ['provider', 'model', 'effort'])
  if (![provider, model, effort, invocationId].every(nonempty)) fail(INPUT)
  if (typeof code !== 'string' || !CODE.test(code)) fail(INPUT)
  return { outcome: 'failed', code, usage: null, receipt: { provider, model, effort, invocationId } }
}
