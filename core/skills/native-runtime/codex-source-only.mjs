// The source-only Codex leaf profile (docs/evidence/codex-sandbox-source-only-2026-11-23.md, SA-08).
// A leaf of this profile gets no shell, no patch tool, no browser, no hosted search and no plugin
// or app surface. Its only tools are the JS `exec` isolate (no filesystem, no network) with the
// nested MCP resource listers, and one MCP server named `reader` that the host owns.
//
// This module holds the pieces that make that a checked fact rather than a prompt:
//   - codexSourceOnlyArgs: the argv. It extends codexExecArgs and never edits it, so every other
//     profile's argv stays byte-identical.
//   - restrictedModelCatalog / readBundledCatalog: a per-run copy of the model's catalog entry with
//     the apply-patch, experimental-tool and multi-agent surfaces removed.
//   - wireInventoryProblems: a pure check of the tool inventory in one captured Responses request.
//   - runWirePreflight: runs `codex exec` with the exact leaf argv against a loopback fake Responses
//     API, with no model call, and fails closed on any tool outside the allowed set.
// Not a sandbox claim: the isolate, hosted tools the real provider may attach, and a future Codex
// that renders tools differently are residual risks the preflight can only observe, not remove.
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import * as zlib from 'node:zlib'
import { codexExecArgs, runCodexExec } from './codex-exec.mjs'
import { error, fail, fields, record } from './boundary.mjs'

const INPUT = 'INVALID_SOURCE_ONLY_INPUT'

/** Codex releases the wire preflight and the live proof were recorded against. */
export const SOURCE_ONLY_PINNED_VERSIONS = Object.freeze(['0.167.0'])
export const SOURCE_ONLY_READER_NAME = 'reader'
export const SOURCE_ONLY_READER_TOOLS = Object.freeze(['list_source', 'read_source', 'search_source'])
/** Features switched off for a source-only leaf, in argv order. */
export const SOURCE_ONLY_DISABLED_FEATURES = Object.freeze(['shell_tool', 'unified_exec', 'view_image', 'goals',
  'image_generation', 'apps', 'plugins', 'tool_suggest', 'skill_search', 'multi_agent', 'multi_agent_v2', 'browser_use',
  'computer_use'])
/** The only tools the preflight accepts. Anything else on the wire refuses the run. */
export const SOURCE_ONLY_ALLOWED_TOOLS = Object.freeze({
  topLevel: Object.freeze(['exec', 'wait']),
  nestedInExec: Object.freeze(['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource']),
  deferredNamespaces: Object.freeze(['mcp__reader']),
})

const READER_URL = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/mcp$/
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const VERSION = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/m
const MAX_CATALOG_BYTES = 32 * 1048576
const MAX_REQUEST_BYTES = 16 * 1048576
const check = ok => { if (!ok) fail(INPUT) }
const absolutePath = value => typeof value === 'string' && value.length > 0 && !value.includes('\0') && isAbsolute(value)

/**
 * The argv for one source-only `codex exec` leaf, prompt on stdin. It is codexExecArgs' read-only argv
 * with the restrictions inserted before the trailing `-`. The reader's bearer token is named, never
 * carried: it travels in the child's environment under `reader.authEnv`.
 */
export function codexSourceOnlyArgs(input) {
  const o = fields(input, INPUT)
  const reader = fields(o.reader, INPUT)
  check(absolutePath(o.catalogFile) && READER_URL.test(reader.url) && ENV_NAME.test(reader.authEnv))
  // codexExecArgs owns the model, effort, output and schema rules and the shared prefix.
  const base = codexExecArgs({ sandbox: 'read-only', model: o.model, reasoningEffort: o.reasoningEffort,
    skipGitRepoCheck: o.skipGitRepoCheck, outputFile: o.outputFile, schemaFile: o.schemaFile })
  const restrictions = ['--ephemeral',
    '-c', `model_catalog_json=${JSON.stringify(o.catalogFile)}`,
    ...SOURCE_ONLY_DISABLED_FEATURES.flatMap(feature => ['--disable', feature]),
    '-c', `mcp_servers.${SOURCE_ONLY_READER_NAME}.url=${JSON.stringify(reader.url)}`,
    '-c', `mcp_servers.${SOURCE_ONLY_READER_NAME}.bearer_token_env_var=${JSON.stringify(reader.authEnv)}`,
    '-c', `mcp_servers.${SOURCE_ONLY_READER_NAME}.enabled_tools=${JSON.stringify(SOURCE_ONLY_READER_TOOLS)}`,
    '-c', 'web_search="disabled"', '-c', 'tools.update_plan.enabled=false',
    '-c', 'tools.experimental_request_user_input.enabled=false']
  return [...base.slice(0, -1), ...restrictions, base.at(-1)]
}

/** The codex version string of `codexBin` (`0.167.0`), or a throw of SOURCE_ONLY_VERSION_UNKNOWN. */
export function codexVersion({ codexBin, env }) {
  check(absolutePath(codexBin))
  const r = spawnSync(codexBin, ['--version'], { env: { ...fields(env, INPUT) }, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] })
  const match = r.status === 0 && typeof r.stdout === 'string' ? VERSION.exec(r.stdout.trim()) : null
  if (!match) throw error('SOURCE_ONLY_VERSION_UNKNOWN')
  return match[1]
}

/** The bundled model catalog of `codexBin` as parsed JSON. Offline: `codex debug models --bundled`. */
export function readBundledCatalog({ codexBin, env }) {
  check(absolutePath(codexBin))
  const r = spawnSync(codexBin, ['debug', 'models', '--bundled'], { env: { ...fields(env, INPUT) }, encoding: 'utf8', timeout: 30000,
    maxBuffer: MAX_CATALOG_BYTES, stdio: ['ignore', 'pipe', 'ignore'] })
  let catalog
  try { catalog = r.status === 0 ? JSON.parse(r.stdout) : null } catch { catalog = null }
  if (!record(catalog) || !Array.isArray(catalog.models)) throw error('SOURCE_ONLY_CATALOG_UNREADABLE')
  return catalog
}

/**
 * A one-model catalog for `model_catalog_json`: the model's own entry with `apply_patch_tool_type`,
 * `experimental_supported_tools` and `multi_agent_version` removed. Everything else, `tool_mode`
 * included, is kept: `default` tool mode breaks the deferred reader namespace. Throws
 * SOURCE_ONLY_MODEL_MISSING when the catalog has no entry for `model`.
 */
export function restrictedModelCatalog(catalog, model) {
  check(record(catalog) && Array.isArray(catalog.models) && typeof model === 'string' && model !== '')
  const entry = catalog.models.find(item => record(item) && item.slug === model)
  if (!entry) throw error('SOURCE_ONLY_MODEL_MISSING')
  return JSON.stringify({ models: [{ ...entry, apply_patch_tool_type: null, experimental_supported_tools: [], multi_agent_version: null }] })
}

const toolName = tool => (record(tool) && typeof tool.name === 'string' ? tool.name : null)
const extras = (seen, allowed) => [...seen].filter(name => !allowed.includes(name)).sort()

/**
 * Problems with the tool inventory of one parsed Responses request body; an empty list means every
 * tool the model would see is in SOURCE_ONLY_ALLOWED_TOOLS. Fails closed: a body that does not parse
 * as a request, a non-empty `tools[]`, a tool with no name, an unnamed hosted tool, or a missing reader
 * namespace is a problem. Pure; reads no file and starts nothing.
 */
export function wireInventoryProblems(body) {
  if (!record(body) || !Array.isArray(body.input)) return ['request is not a Responses body']
  const problems = []
  if (Array.isArray(body.tools) ? body.tools.length > 0 : body.tools !== undefined && body.tools !== null) {
    problems.push(`request.tools[] is not empty: ${JSON.stringify((Array.isArray(body.tools) ? body.tools : [body.tools]).map(t => record(t) ? (t.type ?? t.name) : typeof t))}`)
  }
  const top = new Set(), nested = new Set(), deferred = new Set()
  for (const item of body.input) {
    if (!record(item)) continue
    if (item.type === 'additional_tools') {
      if (!Array.isArray(item.tools)) { problems.push('additional_tools has no tools list'); continue }
      for (const namespace of item.tools) {
        if (!record(namespace) || !Array.isArray(namespace.tools)) { top.add(`<${record(namespace) ? namespace.type : typeof namespace}>`); continue }
        for (const tool of namespace.tools) {
          const name = toolName(tool)
          if (name === null) { top.add('<unnamed>'); continue }
          top.add(name)
          if (name === 'exec' && typeof tool.description === 'string') {
            for (const match of tool.description.matchAll(/^### `([^`]+)`/gm)) nested.add(match[1])
          }
        }
      }
    }
    for (const part of Array.isArray(item.content) ? item.content : []) {
      const text = record(part) && typeof part.text === 'string' ? part.text : ''
      if (text.startsWith('<tools>')) for (const match of text.matchAll(/^- ([^\s:]+)/gm)) deferred.add(match[1])
    }
  }
  for (const [label, seen, allowed] of [['top-level', top, SOURCE_ONLY_ALLOWED_TOOLS.topLevel],
    ['nested-in-exec', nested, SOURCE_ONLY_ALLOWED_TOOLS.nestedInExec], ['deferred-namespaces', deferred, SOURCE_ONLY_ALLOWED_TOOLS.deferredNamespaces]]) {
    const extra = extras(seen, allowed)
    if (extra.length) problems.push(`${label} tools outside the allowed set: ${extra.join(', ')}`)
  }
  // Fail closed on a layout this check does not understand: an inventory with no top-level tool at all was not read, it was missed.
  if (top.size === 0) problems.push('top-level: no tool was found, so the request layout is not one this check understands')
  if (deferred.size === 0) problems.push('deferred-namespaces: the reader namespace is missing')
  return problems
}

// One Responses request body, decoded. Anything unreadable is reported, never guessed at.
function decodeBody(headers, bytes) {
  const encoding = String(headers['content-encoding'] ?? '').toLowerCase()
  let raw = bytes
  if (encoding === 'gzip') raw = zlib.gunzipSync(bytes)
  else if (encoding === 'br') raw = zlib.brotliDecompressSync(bytes)
  else if (encoding === 'deflate') raw = zlib.inflateSync(bytes)
  else if (encoding === 'zstd' && typeof zlib.zstdDecompressSync === 'function') raw = zlib.zstdDecompressSync(bytes)
  else if (encoding !== '' && encoding !== 'identity') throw new Error('unsupported content-encoding')
  return JSON.parse(raw.toString('utf8'))
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

// A loopback Responses API that records each POST body and answers with one short assistant message.
// It makes no model call and reaches no network. `requests` holds the raw captures.
async function startFakeResponses() {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => { size += chunk.length; if (size <= MAX_REQUEST_BYTES) chunks.push(chunk) })
    req.on('end', () => {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
      requests.push({ headers: { 'content-encoding': req.headers['content-encoding'] }, bytes: size <= MAX_REQUEST_BYTES ? Buffer.concat(chunks) : null })
      const message = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'preflight-ok', annotations: [] }] }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse('response.created', { response: { id: 'resp_preflight', object: 'response', status: 'in_progress', output: [] } }))
      res.write(sse('response.output_item.done', { output_index: 0, item: message }))
      res.end(sse('response.completed', { response: { id: 'resp_preflight', object: 'response', status: 'completed', output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }))
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { requests, port: server.address().port, close: () => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}

/** `-c` overrides that point `codex exec` at a loopback Responses API instead of the account's provider. */
export const previewProviderArgs = port => ['-c', 'model_provider="preflight"', '-c', 'model_providers.preflight.name="preflight"',
  '-c', `model_providers.preflight.base_url="http://127.0.0.1:${port}/v1"`, '-c', 'model_providers.preflight.wire_api="responses"',
  '-c', 'model_providers.preflight.requires_openai_auth=false']

/**
 * Runs `codex exec` with `args` (a leaf argv from codexSourceOnlyArgs, unchanged but for the loopback
 * provider) and checks the tool inventory of the one request it sends. No model call. Resolves
 * `{ ok, problems, requests }`; it never rejects for a failed check, only for bad input.
 */
export async function runWirePreflight({ codexBin, args, cwd, env, timeoutMs = 60000 }) {
  check(absolutePath(codexBin) && absolutePath(cwd) && Array.isArray(args) && args.at(-1) === '-' && Number.isSafeInteger(timeoutMs) && timeoutMs > 1000)
  const scratch = mkdtempSync(join(tmpdir(), 'source-only-preflight-'))
  const fake = await startFakeResponses()
  const problems = []
  try {
    const argv = [...args.slice(0, -1), ...previewProviderArgs(fake.port), '-']
    const logFile = join(scratch, 'preflight.log.jsonl')
    const exitCode = await runCodexExec(codexBin, argv, { cwd, env: { ...fields(env, INPUT) }, input: 'preflight', logFile, timeoutMs, graceMs: 500 })
    if (fake.requests.length === 0) problems.push(`codex made no Responses request (exit ${exitCode})`)
    // Every request codex sent is checked, not only the last: a second request with another shape must not hide the first's tools.
    for (const [n, request] of fake.requests.entries()) {
      let body = null
      try { body = request.bytes === null ? null : decodeBody(request.headers, request.bytes) } catch { body = null }
      if (body === null) problems.push(`request ${n + 1}: the Responses request body could not be read`)
      else problems.push(...wireInventoryProblems(body).map(problem => `request ${n + 1}: ${problem}`))
    }
    return { ok: problems.length === 0, problems, requests: fake.requests.length }
  } finally {
    await fake.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}
