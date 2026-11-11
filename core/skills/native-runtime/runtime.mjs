// Trusted graph execution with library-only host ports. The graph owns routing;
// this layer owns admission, transport validation and bounded cancellation.
import { encodeOutputContract } from './schema.mjs'
import { registryWorkflow } from './registry.mjs'
import { fields, exact, json, fail, error, nonempty, record, sha, canonical, ownErrorCode } from './boundary.mjs'

const GRACE_MS = 1000
const PROFILES = new Set(['audit-source-only', 'source-review', 'build-workspace', 'release-controlled'])
const SafeMath = Object.create(Math)
SafeMath.random = () => { throw error('NONDETERMINISTIC_WORKFLOW') }
class SafeDate extends Date {
  constructor(...a) { if (!a.length) throw error('NONDETERMINISTIC_WORKFLOW'); super(...a) }
  static now() { throw error('NONDETERMINISTIC_WORKFLOW') }
}

function selectionFor(resolveLeaf, context) {
  let chosen
  try { chosen = json(resolveLeaf(json(context)), 'INVALID_SELECTION') }
  catch { fail('INVALID_SELECTION') }
  exact(chosen, ['selection', 'profile'], 'INVALID_SELECTION')
  exact(chosen.selection, ['provider', 'model', 'effort'], 'INVALID_SELECTION')
  if (!Object.values(chosen.selection).every(nonempty)) fail('INVALID_SELECTION')
  if (!PROFILES.has(chosen.profile) ||
    (context.workflowId === 'security-audit-flow' && chosen.profile !== 'audit-source-only') ||
    (context.workflowId !== 'release-flow' && chosen.profile === 'release-controlled') ||
    (context.workflowId === 'harness-repair' && !['source-review', 'build-workspace'].includes(chosen.profile))) fail('PROFILE_REFUSED')
  return chosen
}

function completionFor(value, selection) {
  const code = 'DISPATCH_UNCERTAIN', c = json(value, code)
  if (!record(c) || !['returned', 'failed'].includes(c.outcome)) fail(code)
  exact(c, c.outcome === 'returned' ? ['outcome', 'wire', 'usage', 'receipt'] : ['outcome', 'code', 'usage', 'receipt'], code)
  if (c.usage !== null && !record(c.usage)) fail(code)
  exact(c.receipt, ['provider', 'model', 'effort', 'invocationId'], code)
  if (!nonempty(c.receipt.invocationId) || Object.keys(selection).some(k => c.receipt[k] !== selection[k])) fail(code)
  if (c.outcome === 'returned') {
    exact(c.wire, ['json'], code)
    if (typeof c.wire.json !== 'string') fail(code)
  } else if (typeof c.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(c.code)) fail(code)
  return c
}

// A run has one cancellation latch shared by nested workflows and all leaves.
// Pending checkpoint work is never assumed rolled back; after its bound no
// further checkpoint/provider work may start, even if a late promise resolves.
function runScope({ deadlineMs, nowMs, signal, onEvent, cap }) {
  const controller = new AbortController(), operations = new Set(), providers = new Set(), leaves = new Set(), queue = []
  const lifetimes = new Map()
  let pauseError = null
  let fatal = null, blocked = false, closing = false, active = 0, timer
  const observe = event => { try { Promise.resolve(onEvent(event)).catch(() => {}) } catch {} }
  const left = () => {
    let now
    try { now = nowMs() } catch { fail('INVALID_RUNTIME_INPUT') }
    if (typeof now !== 'number' || !Number.isFinite(now)) fail('INVALID_RUNTIME_INPUT')
    return deadlineMs - now
  }
  function stop(code) {
    if (!fatal) fatal = error(code)
    controller.abort()
    for (const waiter of queue.splice(0)) waiter.reject(fatal)
    return fatal
  }
  function abort() { stop(operations.size ? 'CHECKPOINT_UNCERTAIN' : 'RUNTIME_ABORTED') }
  function ensure() {
    if (fatal) throw fatal
    let remaining
    try { remaining = left() } catch { throw stop('INVALID_RUNTIME_INPUT') }
    if (signal?.aborted || remaining <= 0) { abort(); throw fatal }
  }
  function arm() {
    let remaining
    try { remaining = left() } catch { stop('INVALID_RUNTIME_INPUT'); return }
    if (remaining <= 0) { abort(); return }
    timer = setTimeout(arm, Math.min(remaining, 2147483647))
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  arm()

  function pause(value) {
    const p = json(value, 'CHECKPOINT_ERROR')
    exact(p, ['state', 'blockers'], 'CHECKPOINT_ERROR')
    if (p.state !== 'paused' || !Array.isArray(p.blockers) || !p.blockers.length ||
      p.blockers.some((b, i) => !['paused_budget', 'paused_uncertain', 'report_stale'].includes(b) || (i && p.blockers[i - 1] >= b))) fail('CHECKPOINT_ERROR')
    const blockers = [...new Set([...(pauseError?.blockers || []), ...p.blockers])].sort()
    pauseError = Object.assign(error('CONTROL_PAUSED'), { blockers })
    for (const waiter of queue.splice(0)) waiter.reject(pauseError)
    return pauseError
  }
  async function acquire() {
    ensure()
    if (pauseError) throw pauseError
    if (active < cap) { active++; return }
    await new Promise((resolve, reject) => queue.push({ resolve, reject }))
    ensure()
  }
  function release() {
    active--
    if (!fatal && !pauseError && queue.length) { active++; queue.shift().resolve() }
  }

  async function checkpoint(kind, callId, callback, cleanup = false) {
    if (blocked || closing || (cleanup && (signal?.aborted || left() <= 0))) throw fatal || error('CHECKPOINT_UNCERTAIN')
    if (!cleanup) ensure()
    const remaining = left()
    if (remaining <= 0) { abort(); throw fatal }
    const op = new AbortController()
    let onAbort, timeout, expired = false
    const pending = new Promise((resolve, reject) => {
      onAbort = () => {
        if (expired) return
        expired = true
        blocked = true
        observe({ operation: kind, callId, operationPending: true })
        op.abort()
        reject(stop('CHECKPOINT_UNCERTAIN'))
      }
      operations.add(onAbort)
      if (!cleanup) controller.signal.addEventListener('abort', onAbort, { once: true })
      else signal?.addEventListener('abort', onAbort, { once: true })
      timeout = setTimeout(onAbort, Math.min(remaining, 2147483647))
      // Install all listeners first: a trusted callback can synchronously abort.
      try { Promise.resolve(callback(op.signal)).then(resolve, reject) } catch (e) { reject(e) }
    })
    try {
      const value = await pending
      if (!cleanup) ensure()
      // Keep ownership linked until the leaf validates the reply and finishes.
      // Reading state here would invoke unvalidated accessors/Proxy traps.
      // Non-dispatch replies release this listener in the same leaf finally.
      if (kind === 'reserve') {
        const cancel = () => op.abort()
        controller.signal.addEventListener('abort', cancel, { once: true })
        lifetimes.set(callId, () => controller.signal.removeEventListener('abort', cancel))
      }
      return value
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', onAbort)
      signal?.removeEventListener('abort', onAbort)
      operations.delete(onAbort)
    }
  }

  async function dispatch(callback) {
    ensure()
    let cancel
    const aborted = new Promise((_, reject) => {
      cancel = () => reject(fatal || error('RUNTIME_ABORTED'))
      controller.signal.addEventListener('abort', cancel, { once: true })
    })
    let raw
    try { raw = Promise.resolve(callback(controller.signal)) } catch (e) { raw = Promise.reject(e) }
    providers.add(raw)
    raw.then(() => providers.delete(raw), () => providers.delete(raw))
    try { const value = await Promise.race([raw, aborted]); ensure(); return value }
    finally { controller.signal.removeEventListener('abort', cancel) }
  }

  async function drain() {
    await Promise.allSettled([...leaves])
    if (providers.size) {
      let timeout
      const joined = await Promise.race([
        Promise.allSettled([...providers]).then(() => true),
        new Promise(resolve => { timeout = setTimeout(() => resolve(false), GRACE_MS) }),
      ])
      clearTimeout(timeout)
      if (!joined) { fatal = error('CLEANUP_UNCONFIRMED'); controller.abort() }
    }
  }
  return { ensure, stop, pause, acquire, release, checkpoint, dispatch, drain, leaves,
    get pauseError() { return pauseError },
    finish(callId) { lifetimes.get(callId)?.(); lifetimes.delete(callId) },
    get fatal() { return fatal }, get blocked() { return blocked },
    close() { closing = true; abort(); for (const cancel of [...operations]) cancel() },
    dispose() { for (const remove of lifetimes.values()) remove(); lifetimes.clear(); clearTimeout(timer); signal?.removeEventListener('abort', abort) },
  }
}

export function createNativeRuntime(options) {
  const input = fields(options)
  const { registry, provider, resolveLeaf, checkpoints, maxConcurrentSubagents: cap, deadlineMs,
    nowMs = Date.now, signal, onEvent = () => {}, budget = null } = input
  if (Object.keys(input).some(k => !['registry', 'provider', 'resolveLeaf', 'checkpoints', 'maxConcurrentSubagents',
    'deadlineMs', 'nowMs', 'signal', 'onEvent', 'budget'].includes(k))) fail('INVALID_RUNTIME_INPUT')
  registryWorkflow(registry)
  const transport = fields(provider), store = fields(checkpoints)
  if (![transport.runLeaf, resolveLeaf, store.reserve, store.settle, store.uncertain, nowMs, onEvent].every(f => typeof f === 'function') ||
    !Number.isSafeInteger(cap) || cap < 1 || typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs)) fail('INVALID_RUNTIME_INPUT')
  // AbortSignal is the only accepted non-plain options value, alongside opaque
  // registry and trusted callbacks. A real signal is required, not JSON proof.
  if (signal !== undefined) {
    try { Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(signal) }
    catch { fail('INVALID_RUNTIME_INPUT') }
  }
  if (budget !== null) {
    const b = fields(budget)
    if (!(b.total === null || (typeof b.total === 'number' && Number.isFinite(b.total) && b.total >= 0)) ||
      typeof b.spent !== 'function' || typeof b.remaining !== 'function') fail('INVALID_RUNTIME_INPUT')
  }
  let closed = false, current = null, running = null, poison = null, closing

  async function execute(scope, workflowId, args, invocationId, path, occurrences) {
    scope.ensure()
    const template = registryWorkflow(registry, workflowId), argsHash = sha(canonical(args))
    const agent = (prompt, options) => {
      const leaf = (async () => {
        scope.ensure()
        let opts, schema, contract, chosen, context, occurrence, binding
        try {
          opts = fields(options)
          if (typeof prompt !== 'string' || Buffer.byteLength(prompt, 'utf8') > 1048576 ||
            ![opts.agentType, opts.label, opts.phase, opts.model, opts.effort].every(nonempty)) fail('INVALID_RUNTIME_INPUT')
          try { schema = json(opts.schema, 'INVALID_SCHEMA'); contract = encodeOutputContract(schema) }
          catch { fail('INVALID_SCHEMA') }
          context = { workflowId, workflowPath: [...path], agentType: opts.agentType, label: opts.label,
            phase: opts.phase, requestedModel: opts.model, requestedEffort: opts.effort }
          chosen = selectionFor(resolveLeaf, context)
          const key = JSON.stringify([path, opts.agentType, opts.label])
          occurrence = (occurrences.get(key) || 0) + 1; occurrences.set(key, occurrence)
          const callId = 'nr-' + sha(JSON.stringify([invocationId, path, opts.agentType, opts.label, occurrence]))
          binding = { callId, invocationId, workflowId, workflowPath: [...path], agentType: opts.agentType,
            label: opts.label, phase: opts.phase, occurrence, workflowHash: template.sha256, argsHash,
            promptHash: sha(prompt), schemaHash: sha(canonical(schema)), ...chosen }
        } catch (e) { throw scope.stop(ownErrorCode(e) || 'INVALID_RUNTIME_INPUT') }
        await scope.acquire()
        let dispatched = false, settled = false
        const { callId } = binding
        try {
          if (scope.pauseError) throw scope.pauseError
          let reservation
          try {
            // Bound the completion itself, not the checkpoint wrapper around it:
            // a previously accepted exact-limit envelope must remain replayable.
            reservation = fields(await scope.checkpoint('reserve', callId,
              opSignal => store.reserve.call(checkpoints, json(binding), { signal: opSignal })), 'CHECKPOINT_ERROR')
            exact(reservation, reservation?.state === 'completed' ? ['state', 'completion'] : reservation?.state === 'paused' ? ['state', 'blockers'] : ['state'], 'CHECKPOINT_ERROR')
            if (!['dispatch', 'completed', 'uncertain', 'paused'].includes(reservation.state)) fail('CHECKPOINT_ERROR')
          } catch (e) { throw scope.stop(ownErrorCode(e) === 'CONFLICT' ? 'CONFLICT' : 'CHECKPOINT_ERROR') }
          scope.ensure()
          if (reservation.state === 'paused') {
            let paused
            try { paused = scope.pause(reservation) }
            catch { throw scope.stop('CHECKPOINT_ERROR') }
            throw paused
          }
          if (reservation.state === 'uncertain') throw scope.stop('CHECKPOINT_UNCERTAIN')
          let completion
          if (reservation.state === 'completed') {
            try { completion = completionFor(reservation.completion, chosen.selection) }
            catch { throw scope.stop('DISPATCH_UNCERTAIN') }
          } else {
            dispatched = true
            try {
              const raw = await scope.dispatch(localSignal => transport.runLeaf.call(provider, {
                callId, ...json(context), invocationId, prompt, ...json(chosen), schema: json(schema),
                wireSchema: json(contract.wireSchema), deadlineMs, signal: localSignal,
              }))
              completion = completionFor(raw, chosen.selection)
            } catch { throw scope.stop('DISPATCH_UNCERTAIN') }
            scope.ensure()
            try {
              const result = await scope.checkpoint('settle', callId,
                opSignal => store.settle.call(checkpoints, callId, json(completion), { signal: opSignal }))
              settled = true
              if (result !== undefined) scope.pause(result)
            } catch { throw scope.stop('CHECKPOINT_ERROR') }
          }
          scope.ensure()
          if (completion.outcome === 'failed') throw error('LEAF_FAILED')
          // Semantic validation failure is ordinary graph-handled failure. Its
          // exact returned transport evidence has already been durably settled.
          return contract.decode(completion.wire)
        } catch (e) {
          if (dispatched && !settled && scope.fatal && !scope.blocked) {
            try {
              await scope.checkpoint('uncertain', callId,
                opSignal => store.uncertain.call(checkpoints, callId, { code: scope.fatal.code }, { signal: opSignal }), true)
            } catch { /* Charged intent remains held; never substitute success. */ }
          }
          throw scope.fatal || e
        } finally { scope.finish(callId); scope.release() }
      })()
      scope.leaves.add(leaf)
      leaf.then(() => scope.leaves.delete(leaf), () => scope.leaves.delete(leaf))
      return leaf
    }
    const parallel = thunks => Promise.all(thunks.map(async thunk => { try { return await thunk() } catch { return null } }))
    const pipeline = (items, ...stages) => Promise.all(items.map(async (item, index) => {
      let value = item
      for (const stage of stages) { try { value = await stage(value, item, index) } catch { return null } }
      return value
    }))
    const child = async (name, childArgs) => {
      scope.ensure()
      if (!template.children.includes(name)) throw scope.stop('UNKNOWN_WORKFLOW')
      let captured
      try { captured = json(childArgs) } catch { throw scope.stop('INVALID_RUNTIME_INPUT') }
      return execute(scope, name, captured, invocationId, [...path, name], occurrences)
    }
    const result = await template.fn(agent, parallel, pipeline, () => {}, () => {}, args, budget, child, SafeMath, SafeDate)
    scope.ensure()
    return result
  }

  async function run(workflowId, inputArgs, options) {
    if (closed) fail('CLOSED')
    if (running) fail('BUSY')
    if (poison) throw poison
    registryWorkflow(registry, workflowId)
    const opts = json(options)
    exact(opts, ['invocationId'], 'INVALID_RUNTIME_INPUT')
    if (!nonempty(opts.invocationId)) fail('INVALID_RUNTIME_INPUT')
    const args = json(inputArgs)
    const scope = runScope({ deadlineMs, nowMs, signal, onEvent, cap }); current = scope
    // Publish running before invoking any reentrant trusted port callback.
    running = Promise.resolve().then(async () => {
      let result, thrown
      try { result = await execute(scope, workflowId, args, opts.invocationId, [workflowId], new Map()) }
      catch (e) { thrown = e }
      try {
        await scope.drain()
        if (scope.fatal) { poison = scope.fatal; throw poison }
        scope.ensure()
        if (scope.pauseError) throw scope.pauseError
        if (thrown) throw thrown
        return result
      } finally { scope.dispose() }
    })
    try { return await running } finally { running = null; current = null }
  }
  function close() {
    if (closing) return closing
    closed = true
    current?.close()
    closing = (async () => {
      try { await running } catch (e) { if (e.code === 'CLEANUP_UNCONFIRMED') throw e }
      if (poison?.code === 'CLEANUP_UNCONFIRMED') throw poison
    })()
    return closing
  }
  return Object.freeze({ run, close })
}
