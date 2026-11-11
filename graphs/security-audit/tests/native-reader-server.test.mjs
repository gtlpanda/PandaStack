import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test } from '../../../scripts/workflow-harness.mjs'
import { createNativeReaderServer } from '../skills/security-audit/native-reader-server.mjs'
const sha = x => createHash('sha256').update(x).digest('hex')
const sorted = x => Array.isArray(x) ? x.map(sorted) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sorted(x[k])])) : x
async function fixture(work) {
  const base = mkdtempSync(join(tmpdir(), 'reader-http-')), sourceRoot = join(base, 'source'), contextRoot = join(base, 'context')
  mkdirSync(sourceRoot); mkdirSync(contextRoot)
  const bytes = Buffer.from('ordinary source observation')
  writeFileSync(join(sourceRoot, 'fixture.txt'), bytes); chmodSync(join(sourceRoot, 'fixture.txt'), 0o444)
  chmodSync(sourceRoot, 0o555); chmodSync(contextRoot, 0o555)
  const manifest = { version: 1, sourceRef: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, files: [{ path: 'fixture.txt', sha256: sha(bytes), bytes: bytes.length }], contexts: [] }
  let server
  try {
    server = await createNativeReaderServer({ sourceRoot, contextRoot, manifest, expectedManifestHash: sha(JSON.stringify(sorted(manifest))) })
    let id = 0
    const rpc = async (method, params, headers = {}) => {
      const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.bearerToken, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
      return { status: response.status, body: await response.text() }
    }
    const initialize = async () => {
      assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })).status, 200)
      const r = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.bearerToken }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
      assert.equal(r.status, 202)
    }
    await work({ server, rpc, initialize, bytes })
  } finally {
    if (server) await server.close()
    chmodSync(sourceRoot, 0o755); chmodSync(contextRoot, 0o755); rmSync(base, { recursive: true, force: true })
  }
}
await test('reader HTTP handshake exposes only four bounded read tools and returns exact manifest bytes', () => fixture(async ({ rpc, initialize, bytes }) => {
  assert.equal(JSON.parse((await rpc('tools/list', {})).body).error.code, -32600)
  await initialize()
  const listing = JSON.parse((await rpc('tools/list', {})).body).result.tools
  assert.deepEqual(listing.map(t => t.name), ['list_source', 'read_source', 'search_source', 'read_context'])
  const response = JSON.parse((await rpc('tools/call', { name: 'read_source', arguments: { path: 'fixture.txt', offset: 0, limit: 65536 } })).body)
  assert.equal(response.result.isError, false)
  assert.deepEqual(Buffer.from(JSON.parse(response.result.content[0].text).dataBase64, 'base64'), bytes)
}))
await test('reader HTTP authentication and unregistered requests receive fixed refusals', () => fixture(async ({ rpc, initialize, server }) => {
  assert.equal((await rpc('ping', {}, { Authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await rpc('ping', {}, { Origin: 'https://example.invalid' })).status, 403)
  assert.equal((await rpc('ping', {}, { Authorization: 'Bearer ' + 'x'.repeat(64) })).status, 401)
  assert.equal((await rpc('ping', {}, { 'Content-Type': 'application/jsonx' })).status, 415)
  await initialize()
  assert.equal(JSON.parse((await rpc('tools/call', { name: 'shell', arguments: {} })).body).error.code, -32602)
  const r = JSON.parse((await rpc('tools/call', { name: 'read_source', arguments: { path: 'unlisted.txt', offset: 0, limit: 1 } })).body).result
  assert.equal(server.stats().refusals.NOT_FOUND, 1)
  assert.deepEqual(r, { content: [{ type: 'text', text: 'Reader request refused.' }], isError: true })
}))

await test('reader request limit is observable to the owning host and close joins idempotently', () => fixture(async ({ rpc, server }) => {
  for (let i = 0; i < 1024; i++) assert.equal((await rpc('ping', {})).status, 200)
  assert.equal((await rpc('ping', {})).status, 429)
  assert.deepEqual(server.stats(), { calls: 1025, exhausted: true, refusals: {} })
  await Promise.all([server.close(), server.close()])
}))
