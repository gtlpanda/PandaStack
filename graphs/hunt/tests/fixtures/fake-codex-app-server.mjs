// fake-codex-app-server.mjs — stands in for `codex app-server` (JSON-RPC over stdio) in the
// codex-hook tests, so no real Codex runs in the suite. It implements the three calls
// codex-hook.mjs makes, after the shape Codex 0.167 answers with
// (docs/evidence/codex-review-gate-hook-2026-11-23.md):
//   initialize          -> {}
//   hooks/list          -> { data: [{ cwd, hooks: [{ key, source, command, matcher, currentHash, trustStatus }] }] }
//                          one user hook per PreToolUse entry of $CODEX_HOME/hooks.json, keyed
//                          "<hooks.json>:pre_tool_use:<group>:<hook>"; trusted when fake-trust.json
//                          holds its current hash, modified when it holds another, else untrusted
//   config/batchWrite   -> upserts hooks.state.<key>.trusted_hash into $CODEX_HOME/fake-trust.json
// Every request is appended to $CODEX_HOME/fake-calls.jsonl.
// FAKE_APP_SERVER_MODE: hang (never answers), crash (exits 1 at once), ignore-trust (accepts
// batchWrite, keeps nothing), list-error (hooks/list answers an error).
// FAKE_EXTRA_HOOKS: a JSON array of extra hook entries hooks/list also reports (a project hook).
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const home = process.env.CODEX_HOME
const mode = process.env.FAKE_APP_SERVER_MODE || ''
if (process.argv[2] !== 'app-server' || !home) { process.stderr.write('fake codex: expected `app-server` and CODEX_HOME\n'); process.exit(2) }
if (mode === 'crash') { process.stderr.write('fake codex: crashed on purpose\n'); process.exit(1) }

const hooksFile = join(home, 'hooks.json')
const trustFile = join(home, 'fake-trust.json')
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const canonical = v => JSON.stringify(v, (_, x) => (isObject(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x))
const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback)

function listHooks() {
  const config = readJson(hooksFile, {})
  const trust = readJson(trustFile, {})
  const groups = Array.isArray(config?.hooks?.PreToolUse) ? config.hooks.PreToolUse : []
  const hooks = []
  groups.forEach((group, g) => (Array.isArray(group?.hooks) ? group.hooks : []).forEach((hook, h) => {
    const key = `${hooksFile}:pre_tool_use:${g}:${h}`
    const currentHash = `sha256:${createHash('sha256').update(canonical({ matcher: group.matcher, hook })).digest('hex')}`
    const trustStatus = trust[key] === currentHash ? 'trusted' : trust[key] ? 'modified' : 'untrusted'
    hooks.push({ key, source: 'user', eventName: 'preToolUse', matcher: group.matcher ?? null, command: hook.command, currentHash, trustStatus, enabled: true, isManaged: false })
  }))
  for (const extra of JSON.parse(process.env.FAKE_EXTRA_HOOKS || '[]')) hooks.push(extra)
  return { data: [{ cwd: process.cwd(), hooks, warnings: [], errors: [] }] }
}

function batchWrite(params) {
  if (mode === 'ignore-trust') return { status: 'ok' }
  const trust = readJson(trustFile, {})
  for (const edit of params.edits || []) {
    if (edit.keyPath !== 'hooks.state' || edit.mergeStrategy !== 'upsert') throw new Error(`unexpected edit ${JSON.stringify(edit)}`)
    for (const [key, value] of Object.entries(edit.value)) trust[key] = value.trusted_hash
  }
  writeFileSync(trustFile, JSON.stringify(trust))
  return { status: 'ok' }
}

const answer = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
  appendFileSync(join(home, 'fake-calls.jsonl'), line + '\n')
  if (mode === 'hang' || msg.id === undefined) return
  try {
    if (msg.method === 'initialize') answer(msg.id, { result: {} })
    else if (msg.method === 'hooks/list') answer(msg.id, mode === 'list-error' ? { error: { code: -32000, message: 'list failed on purpose' } } : { result: listHooks() })
    else if (msg.method === 'config/batchWrite') answer(msg.id, { result: batchWrite(msg.params) })
    else answer(msg.id, { error: { code: -32601, message: `unknown method ${msg.method}` } })
  } catch (e) {
    answer(msg.id, { error: { code: -32000, message: e.message } })
  }
})
