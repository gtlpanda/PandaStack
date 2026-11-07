// render-skill-output-columns.test.mjs — kit/skills/render/SKILL.md must describe the columns
// that `render services` and `render deploys` really print. Claude reads the documented schema
// and then interprets the live output with it, so a different column set misleads it.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { test } from '../scripts/workflow-harness.mjs'

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'kit', 'skills', 'render')
const RENDER = join(SKILL_DIR, 'render')
const DOC = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8')

function fakeRenderApi() {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/services') {
      res.end(JSON.stringify([{ service: {
        id: 'srv-abc123', name: 'supple-picks', type: 'web_service',
        url: 'https://supple-picks.onrender.com', suspended: 'not_suspended', updatedAt: '2026-05-26T01:41:00Z',
      } }]))
    } else if (url.pathname === '/services/srv-abc123/deploys') {
      res.end(JSON.stringify([{ deploy: {
        id: 'dep-xyz', status: 'live', commit: { id: '553172c0aaaa', message: 'PR #91 merge' },
        createdAt: '2026-05-26T01:41:00Z', finishedAt: '2026-05-26T01:45:00Z',
      } }]))
    } else if (url.pathname === '/services/srv-abc123') {
      res.end(JSON.stringify({ id: 'srv-abc123', name: 'supple-picks' }))
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
}

function runRender(args, env) {
  return new Promise(resolve => {
    const child = spawn('bash', [RENDER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

async function withRender(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'render-cols-'))
  const server = fakeRenderApi()
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const keyFile = join(dir, 'api-key')
    writeFileSync(keyFile, 'rnd_test', { mode: 0o600 })
    await fn({
      PATH: process.env.PATH,
      HOME: dir,
      RENDER_API_KEY_FILE: keyFile,
      RENDER_API_BASE: `http://127.0.0.1:${server.address().port}`,
      NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1',
    })
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const words = line => line.trim().split(/\s+/).map(w => w.toLowerCase())

await test('SKILL.md documents the same columns that `render services` prints', async () => {
  const section = DOC.split(/^### `render services`/m)[1]?.split(/^### /m)[0]
  assert.ok(section, 'BUGHUNT-F9 SKILL.md no longer documents render services')
  const m = section.match(/Output: `([^`]*)`/)
  assert.ok(m, 'BUGHUNT-F9 SKILL.md no longer documents the render services columns')
  await withRender(async env => {
    const r = await runRender(['services'], env)
    assert.equal(r.status, 0, `render services failed: ${r.stderr}`)
    const printed = words(r.stdout.split('\n')[0])
    assert.deepEqual(words(m[1]), printed,
      `BUGHUNT-F9 SKILL.md documents render services columns [${words(m[1])}] but the wrapper prints [${printed}]`)
  })
})

await test('SKILL.md documents the same columns that `render deploys` prints, and its example row follows them', async () => {
  const section = DOC.split(/^### `render deploys/m)[1]?.split(/^### /m)[0]
  assert.ok(section, 'BUGHUNT-F9 SKILL.md no longer documents render deploys')
  const m = section.match(/`(ID {2}STATUS[^`]*)`/)
  assert.ok(m, 'BUGHUNT-F9 SKILL.md no longer documents the render deploys columns')
  const example = section.split('\n').find(l => /^# dep-/.test(l))
  assert.ok(example, 'BUGHUNT-F9 SKILL.md no longer shows a render deploys example row')
  const created = example.search(/\d{4}-\d\d-\d\dT/)
  assert.ok(created > 0 && created < example.indexOf('PR #'), `BUGHUNT-F9 the example row puts the message before the timestamps: ${example}`)
  await withRender(async env => {
    const r = await runRender(['deploys', 'srv-abc123'], env)
    assert.equal(r.status, 0, `render deploys failed: ${r.stderr}`)
    const printed = words(r.stdout.split('\n')[0])
    assert.deepEqual(words(m[1]), printed, `BUGHUNT-F9 SKILL.md documents render deploys columns [${words(m[1])}] but the wrapper prints [${printed}]`)
  })
})
