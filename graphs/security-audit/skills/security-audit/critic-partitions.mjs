// Pure consistency bindings only. The host owns semantic validation, measurement,
// persistence, reader grants and scheduling; this module dispatches nothing.
import { createHash } from 'node:crypto'
import { canonical, fields, record } from './journal-data.mjs'
import { criticResultProblems, criticTransitionContext } from './audit-ledger.mjs'

const CAP = 500000
const DATA_LIMIT = 32 * 1024 * 1024
const INPUT = 'INVALID_PARTITION_INPUT', RESULT = 'INVALID_PARTITION_RESULT'
const fail = code => { throw Object.assign(new Error(`Audit critic partitions: ${code}`), { code }) }
const need = (ok, code) => { if (!ok) fail(code) }
const text = v => typeof v === 'string' && v.trim() !== ''
const id = v => text(v) && Buffer.byteLength(v) <= 128
const json = (v, code = INPUT) => canonical(v, DATA_LIMIT, code, 'STAGE_INPUT_TOO_LARGE')
const copy = (v, code = INPUT) => JSON.parse(json(v, code))
const digest = v => createHash('sha256').update(json(v)).digest('hex')
const equal = (a, b) => json(a) === json(b)
const exact = (v, keys, code) => fields(v, keys, code)
const metadata = ({ itemId, kind, owners, digest }) => ({ itemId, kind, owners, digest })

function base(input, code) {
  const { identity, shared, items } = exact(input, ['identity', 'shared', 'items'], code)
  exact(identity, ['runId', 'sourceRef', 'kind', 'wave', 'profile'], code)
  exact(identity.sourceRef, ['commit', 'tree'], code)
  const { commit, tree } = identity.sourceRef
  need(id(identity.runId) && typeof commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) &&
    typeof tree === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree) && commit.length === tree.length, code)
  need(['post-wave', 'final-clean'].includes(identity.kind) && Number.isSafeInteger(identity.wave) && identity.wave > 0 &&
    ['quick', 'standard', 'deep'].includes(identity.profile) && !(identity.kind === 'final-clean' && identity.profile === 'quick'), code)
  exact(shared, ['architecture_md', 'parts', 'execution', 'tree'], code)
  need(text(shared.architecture_md) && record(shared.parts) && record(shared.execution) && text(shared.tree), code)
  need(Array.isArray(items) && items.length > 0, code)
  const units = new Set(), ids = new Set()
  for (const item of items) {
    exact(item, ['itemId', 'kind', 'owners', 'value'], code)
    need(id(item.itemId) && !ids.has(item.itemId) && ['unit', 'candidate', 'prior'].includes(item.kind) && record(item.value), code)
    ids.add(item.itemId)
    if (item.kind === 'unit') units.add(item.itemId)
  }
  need(units.size > 0, code)
  for (const item of items) {
    need(Array.isArray(item.owners) && item.owners.length > 0 && new Set(item.owners).size === item.owners.length && item.owners.every(o => units.has(o)), code)
    if (item.kind === 'unit') need(item.owners.length === 1 && item.owners[0] === item.itemId, code)
  }
  const boundItems = items.map(item => ({ ...item, digest: digest(item.value) }))
  const inputDigest = digest({ identity, shared, items: boundItems })
  return { version: 1, batchId: 'critic-' + inputDigest, inputDigest, identity, shared, items: boundItems }
}

function graphInput(m, items, critic_context) {
  return { stage: 'critic', part: 'critic', tree: m.shared.tree, maxParallel: 1, execution: m.shared.execution,
    kind: m.identity.kind, wave: m.identity.wave, hunted: true, architecture_md: m.shared.architecture_md,
    profile: m.identity.profile, parts: m.shared.parts,
    ledger: items.filter(i => i.kind === 'unit').map(i => i.value),
    candidates: items.filter(i => i.kind === 'candidate').map(i => i.value),
    prior: { records: items.filter(i => i.kind === 'prior').map(i => i.value) }, critic_context,
    transitionContext: criticTransitionContext((critic_context.mode === 'reconciliation' ? m.items : items)
      .filter(i => i.kind === 'unit').map(i => ({ coverage_id: i.value.coverage_id, status: i.value.status }))) }
}

function partition(m, owners, number) {
  const selected = new Set(owners)
  const items = m.items.filter(i => i.owners.some(o => selected.has(o)))
  const partId = 'part-' + number
  const input = graphInput(m, items, { version: 1, mode: 'partition', batchId: m.batchId, partId,
    index: m.items.map(metadata), items: items.map(metadata) })
  return { partId, itemIds: items.map(i => i.itemId), inputDigest: digest(input), input }
}

function measurer(options) {
  const { measureScript } = exact(options, ['measureScript'], INPUT)
  need(typeof measureScript === 'function', INPUT)
  return input => {
    // A trusted serializer gets a detached copy; its exceptions never expose data.
    let bytes
    try { bytes = measureScript(copy(input)) } catch { fail(INPUT) }
    need(Number.isSafeInteger(bytes) && bytes >= 0, INPUT)
    return bytes
  }
}

export function planCriticBatch(input, options) {
  const m = base(copy(input), INPUT), measure = measurer(options), partitions = []
  let owners = [], last = null
  for (const unit of m.items.filter(i => i.kind === 'unit')) {
    let next = partition(m, [...owners, unit.itemId], partitions.length + 1)
    next.scriptBytes = measure(next.input)
    if (next.scriptBytes > CAP && last) {
      partitions.push(last)
      owners = []
      next = partition(m, [unit.itemId], partitions.length + 1)
      next.scriptBytes = measure(next.input)
    }
    need(next.scriptBytes <= CAP, 'STAGE_INPUT_TOO_LARGE')
    owners.push(unit.itemId)
    last = next
  }
  partitions.push(last)
  return copy({ ...m, partitions })
}

// Rebuild every binding and bundle from raw manifest values. Hashes alone are not
// accepted as evidence that the supplied executable projection is consistent.
function manifest(value) {
  const m = copy(value, RESULT)
  exact(m, ['version', 'batchId', 'inputDigest', 'identity', 'shared', 'items', 'partitions'], RESULT)
  need(m.version === 1 && Array.isArray(m.items) && Array.isArray(m.partitions) && m.partitions.length > 0, RESULT)
  const raw = m.items.map(item => {
    exact(item, ['itemId', 'kind', 'owners', 'value', 'digest'], RESULT)
    const { digest: ignored, ...rest } = item
    return rest
  })
  const expected = base({ identity: m.identity, shared: m.shared, items: raw }, RESULT)
  need(m.batchId === expected.batchId && m.inputDigest === expected.inputDigest && equal(m.items, expected.items), RESULT)
  const units = m.items.filter(i => i.kind === 'unit').map(i => i.itemId), seen = []
  for (const [n, p] of m.partitions.entries()) {
    exact(p, ['partId', 'itemIds', 'inputDigest', 'input', 'scriptBytes'], RESULT)
    need(Array.isArray(p.itemIds) && Number.isSafeInteger(p.scriptBytes) && p.scriptBytes >= 0 && p.scriptBytes <= CAP, RESULT)
    const owners = p.itemIds.filter(id => units.includes(id))
    need(owners.length > 0 && equal(owners, units.slice(seen.length, seen.length + owners.length)), RESULT)
    seen.push(...owners)
    const expectedPart = partition(m, owners, n + 1)
    need(equal(p, { ...expectedPart, scriptBytes: p.scriptBytes }), RESULT)
  }
  need(equal(seen, units), RESULT)
  return m
}

function validateCritic(critic, m) {
  need(criticResultProblems(critic).length === 0 && critic.missing_units.every(record), RESULT)
  const units = new Set(m.items.filter(i => i.kind === 'unit').map(i => i.value.coverage_id))
  const prior = new Set(m.items.filter(i => i.kind === 'prior').map(i => i.value.fingerprint))
  need(critic.reassign_ids.every(id => units.has(id)) && critic.resolved_prior_leads.every(id => prior.has(id)), RESULT)
}

function results(value, m) {
  const rows = copy(value, RESULT)
  need(Array.isArray(rows), RESULT)
  const byId = new Map()
  for (const row of rows) {
    exact(row, ['batchId', 'partId', 'inputDigest', 'critic', 'summary'], RESULT)
    const part = m.partitions.find(p => p.partId === row.partId)
    need(part && !byId.has(row.partId) && row.batchId === m.batchId && row.inputDigest === part.inputDigest, RESULT)
    exact(row.summary, ['text', 'itemIds'], RESULT)
    need(typeof row.summary.text === 'string' && Buffer.byteLength(row.summary.text) <= 4096 && equal(row.summary.itemIds, part.itemIds), RESULT)
    validateCritic(row.critic, m)
    byId.set(row.partId, row)
  }
  return { rows: m.partitions.filter(p => byId.has(p.partId)).map(p => byId.get(p.partId)),
    missingPartIds: m.partitions.filter(p => !byId.has(p.partId)).map(p => p.partId) }
}

function reconciliation(m, rows) {
  const index = m.items.map(item => {
    const entry = metadata(item)
    if (item.kind === 'unit') {
      entry.coverage_id = item.value.coverage_id
      entry.status = item.value.status
    } else if (Object.hasOwn(item.value, 'fingerprint')) entry.fingerprint = item.value.fingerprint
    return entry
  })
  const partitions = rows.map(({ partId, inputDigest, summary, critic }) => ({ partId, inputDigest, summary, critic,
    itemIds: m.partitions.find(p => p.partId === partId).itemIds }))
  const input = graphInput(m, [], { version: 1, mode: 'reconciliation', batchId: m.batchId, index, partitions })
  return { batchId: m.batchId, inputDigest: digest(input), input }
}

export function planCriticReconciliation(input, options) {
  const args = exact(input, ['manifest', 'results'], RESULT)
  const m = manifest(args.manifest), r = results(args.results, m), measure = measurer(options)
  if (r.missingPartIds.length) return { complete: false, missingPartIds: r.missingPartIds, plan: null }
  const plan = reconciliation(m, r.rows)
  plan.scriptBytes = measure(plan.input)
  need(plan.scriptBytes <= CAP, 'STAGE_INPUT_TOO_LARGE')
  return { complete: true, missingPartIds: [], plan: copy(plan) }
}

export function acceptCriticReconciliation(input) {
  const args = exact(input, ['manifest', 'results', 'plan', 'result'], RESULT)
  const m = manifest(args.manifest), r = results(args.results, m)
  if (r.missingPartIds.length) return { complete: false, critic: null }
  const plan = copy(args.plan, RESULT)
  exact(plan, ['batchId', 'inputDigest', 'input', 'scriptBytes'], RESULT)
  need(Number.isSafeInteger(plan.scriptBytes) && plan.scriptBytes >= 0 && plan.scriptBytes <= CAP &&
    equal(plan, { ...reconciliation(m, r.rows), scriptBytes: plan.scriptBytes }), RESULT)
  if (args.result === null || args.result === undefined) return { complete: false, critic: null }
  const result = copy(args.result, RESULT)
  exact(result, ['batchId', 'inputDigest', 'critic'], RESULT)
  need(result.batchId === m.batchId && result.inputDigest === plan.inputDigest, RESULT)
  validateCritic(result.critic, m)
  const critics = [...r.rows.map(row => row.critic), result.critic]
  const missing = new Map()
  for (const c of critics) for (const unit of c.missing_units) missing.set(json(unit), unit)
  const requested = new Set(critics.flatMap(c => c.reassign_ids))
  const reassign_ids = [...new Set(m.items.filter(i => i.kind === 'unit' && requested.has(i.value.coverage_id)).map(i => i.value.coverage_id))]
  // A fingerprint can occur in multiple prior records. Every partition owning
  // any such record must agree, not merely the owners of one matching record.
  const priorItems = m.items.filter(i => i.kind === 'prior')
  const resolved_prior_leads = [...new Set(priorItems.map(i => i.value.fingerprint))].filter(fp => {
    if (!result.critic.resolved_prior_leads.includes(fp)) return false
    const ids = new Set(priorItems.filter(i => i.value.fingerprint === fp).map(i => i.itemId))
    return r.rows.filter(row => m.partitions.find(p => p.partId === row.partId).itemIds.some(id => ids.has(id)))
      .every(row => row.critic.resolved_prior_leads.includes(fp))
  })
  const missing_units = [...missing.values()]
  return copy({ complete: true, critic: { missing_units, reassign_ids, resolved_prior_leads,
    stop: critics.every(c => c.stop) && !missing_units.length && !reassign_ids.length } })
}
