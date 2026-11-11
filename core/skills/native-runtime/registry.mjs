// Only these installed, host-pinned templates may execute. This is a trust
// boundary for installation bytes, not a sandbox for arbitrary JavaScript.
import { realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { TextDecoder } from 'node:util'
import { fields, exact, json, fail, nonempty, sha } from './boundary.mjs'

const PATHS = Object.freeze({
  'blueprint-design': 'graphs/blueprint/workflows/blueprint-design.js',
  'bughunt-flow': 'graphs/hunt/workflows/bughunt-flow.js',
  'dev-build': 'graphs/dev/workflows/dev-build.js',
  'harness-repair': 'graphs/qa/workflows/harness-repair.js',
  'release-flow': 'graphs/release/workflows/release-flow.js',
  'security-audit-flow': 'graphs/security-audit/workflows/security-audit-flow.js',
})
const registries = new WeakMap()
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const MAX_TEMPLATE_BYTES = 1048576

function capture(root, path, hash, id) {
  let fd
  try {
    const file = realpathSync(resolve(root, path)), rel = relative(root, file)
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) fail('REGISTRY_MISMATCH')
    fd = openSync(file, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_TEMPLATE_BYTES) fail('REGISTRY_MISMATCH')
    const bytes = Buffer.alloc(stat.size + 1)
    let offset = 0, n
    while (offset < bytes.length && (n = readSync(fd, bytes, offset, bytes.length - offset, null))) offset += n
    if (offset !== stat.size || sha(bytes.subarray(0, offset)) !== hash) fail('REGISTRY_MISMATCH')
    let source, meta, fn
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
      if (!source.startsWith('export const meta = {')) fail('REGISTRY_MISMATCH')
      const end = source.indexOf('\n}\n')
      if (end < 0) fail('REGISTRY_MISMATCH')
      const literal = source.slice('export const meta = '.length, end + 2)
      if (literal.includes('${')) fail('REGISTRY_MISMATCH')
      meta = new Function(`"use strict"; return (${literal})`)()
      if (meta.name !== id) fail('REGISTRY_MISMATCH')
      fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'Math', 'Date',
        source.replace(/^export const meta/, 'const meta'))
    } catch { fail('REGISTRY_MISMATCH') }
    return Object.freeze({ id, sha256: hash, children: Object.freeze(id === 'dev-build' ? ['harness-repair'] : []), fn })
  } catch (e) {
    if (e?.code === 'REGISTRY_MISMATCH') throw e
    fail('IO_ERROR')
  } finally { if (fd !== undefined) closeSync(fd) }
}

export function loadWorkflowRegistry(options) {
  const input = fields(options)
  exact(input, ['installationRoot', 'workflowHashes'], 'INVALID_RUNTIME_INPUT')
  if (!nonempty(input.installationRoot)) fail('INVALID_RUNTIME_INPUT')
  const pins = json(input.workflowHashes)
  exact(pins, Object.keys(PATHS), 'INVALID_RUNTIME_INPUT')
  if (Object.values(pins).some(h => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h))) fail('INVALID_RUNTIME_INPUT')
  let root
  try { root = realpathSync(input.installationRoot) } catch { fail('IO_ERROR') }
  const rows = new Map(Object.entries(PATHS).map(([id, path]) => [id, capture(root, path, pins[id], id)]))
  const registry = Object.freeze({ describe: () => [...rows.values()].map(({ id, sha256, children }) => ({ id, sha256, children: [...children] })) })
  registries.set(registry, rows)
  return registry
}

// Authenticity is object identity in this module's private WeakMap. No API
// accepts supplied executable functions or deserialized registry descriptions.
export function registryWorkflow(registry, id) {
  const rows = registries.get(registry)
  if (!rows) fail('INVALID_RUNTIME_INPUT')
  if (id === undefined) return
  if (typeof id !== 'string' || !rows.has(id)) fail('UNKNOWN_WORKFLOW')
  return rows.get(id)
}
