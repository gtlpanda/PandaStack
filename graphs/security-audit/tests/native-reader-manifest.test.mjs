// The reader inputs the native run builds from a sealed snapshot: the manifest is exactly the tree's files, each byte served is verified against it,
// and a tree the reader cannot serve completely is refused before inference.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, NO_LINUX_STORES } from '../../../scripts/workflow-harness.mjs'
import { buildReaderInputs, CONTEXT_DIR } from '../skills/security-audit/native-reader-manifest.mjs'
import { createNativeReaderServer } from '../skills/security-audit/native-reader-server.mjs'
import { makeWritable } from '../skills/security-audit/audit-run.mjs'
import { newInit } from './stage-fixtures.mjs'

async function call(server, name, args, id = 1) {
  const post = async body => (await fetch(server.url, { method: 'POST', headers: { authorization: `Bearer ${server.bearerToken}`, 'content-type': 'application/json', host: new URL(server.url).host }, body: JSON.stringify(body) }))
  await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const reply = await (await post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })).json()
  return reply.result
}

await test('the manifest lists exactly the sealed tree, ordered bytewise, and the reader serves verified bytes from it and nothing else', { skip: NO_LINUX_STORES }, async () => {
  const { runDir } = newInit()
  const inputs = buildReaderInputs(runDir)
  assert.deepEqual(inputs.manifest.files.map(f => f.path), ['README.md', 'src/app.js', 'src/bare.txt', 'src/db.js', 'src/empty.txt', 'src/lines.js'])
  assert.equal(inputs.contextRoot, join(runDir, CONTEXT_DIR))
  assert.equal(statSync(inputs.contextRoot).mode & 0o222, 0, 'the context root is write-protected')
  assert.deepEqual(inputs.manifest.contexts, [])
  const server = await createNativeReaderServer(inputs)
  try {
    const listed = JSON.parse((await call(server, 'list_source', { after: null, limit: 128 })).content[0].text)
    assert.equal(listed.entries.length, 6)
    const read = JSON.parse((await call(server, 'read_source', { path: 'src/lines.js', offset: 0, limit: 65536 }, 2)).content[0].text)
    assert.equal(Buffer.from(read.dataBase64, 'base64').toString(), readFileSync(join(runDir, 'tree', 'src', 'lines.js'), 'utf8'))
    for (const path of ['../run-metadata.json', '/etc/passwd', 'src/../../run-metadata.json', 'not-in-tree.js']) {
      const refused = await call(server, 'read_source', { path, offset: 0, limit: 10 }, 3)
      assert.equal(refused.isError, true, path)
    }
    const search = JSON.parse((await call(server, 'search_source', { path: 'src/lines.js', literal: 'three', offset: 0, scanBytes: 1000, limit: 5 }, 4)).content[0].text)
    assert.deepEqual(search.matches, [8])
  } finally { await server.close() }
})

await test('a file that changed after the manifest was built is refused when read, not served', { skip: NO_LINUX_STORES }, async () => {
  const { runDir } = newInit()
  const inputs = buildReaderInputs(runDir)
  const file = join(runDir, 'tree', 'src', 'app.js')
  chmodSync(join(runDir, 'tree', 'src'), 0o755); chmodSync(file, 0o644)
  writeFileSync(file, 'export const a = 2\n')
  chmodSync(file, 0o444); chmodSync(join(runDir, 'tree', 'src'), 0o555)
  const server = await createNativeReaderServer(inputs)
  try { assert.equal((await call(server, 'read_source', { path: 'src/app.js', offset: 0, limit: 100 })).isError, true) } finally { await server.close() }
})

await test('a tree the reader cannot serve completely is refused before inference: a symlink, too many files', { skip: NO_LINUX_STORES }, () => {
  const link = newInit().runDir
  makeWritable(join(link, 'tree')); symlinkSync('/etc/hostname', join(link, 'tree', 'link'))
  assert.throws(() => buildReaderInputs(link), e => e.code === 'SNAPSHOT_ENTRY_UNSUPPORTED')
  const many = newInit().runDir
  makeWritable(join(many, 'tree'))
  mkdirSync(join(many, 'tree', 'bulk'))
  for (let i = 0; i < 10000; i++) writeFileSync(join(many, 'tree', 'bulk', `f${i}`), '')
  assert.throws(() => buildReaderInputs(many), e => e.code === 'READER_TREE_TOO_LARGE')
})
