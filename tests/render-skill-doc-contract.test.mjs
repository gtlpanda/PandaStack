// render-skill-doc-contract.test.mjs — kit/skills/render/SKILL.md must describe what the
// render wrapper does. Runs the real script against a loopback fake of the Render API and
// compares what it sends and prints with what the skill doc promises.
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

// Records the query of every /logs request.
function fakeRenderApi(logQueries) {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname.startsWith('/services/') && url.pathname.endsWith('/env-vars')) {
      res.end(JSON.stringify([{ envVar: { key: 'DATABASE_URL', value: 'x' } }]))
    } else if (url.pathname.startsWith('/services/')) {
      res.end(JSON.stringify({ id: 'srv-abc123', name: 'supple-picks', ownerId: 'tea-1' }))
    } else if (url.pathname === '/logs') {
      logQueries.push(url.searchParams)
      res.end(JSON.stringify({ logs: [], hasMore: false }))
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
  const dir = mkdtempSync(join(tmpdir(), 'render-doc-'))
  const logQueries = []
  const server = fakeRenderApi(logQueries)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const keyFile = join(dir, 'api-key')
    writeFileSync(keyFile, 'rnd_test', { mode: 0o600 })
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      RENDER_API_KEY_FILE: keyFile,
      RENDER_API_BASE: `http://127.0.0.1:${server.address().port}`,
      NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1',
    }
    await fn(env, logQueries)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('SKILL.md states the --limit default that render logs actually sends', async () => {
  const m = DOC.match(/^- `--limit <n>`.*\(default (\d+)/m)
  assert.ok(m, 'BUGHUNT-F10 SKILL.md no longer documents a --limit default')
  await withRender(async (env, logQueries) => {
    const r = await runRender(['logs', 'srv-abc123'], env)
    assert.equal(r.status, 0, `render logs failed: ${r.stderr}`)
    assert.equal(logQueries.length, 1)
    const sent = logQueries[0].get('limit')
    assert.equal(m[1], sent,
      `BUGHUNT-F10 SKILL.md documents a default --limit of ${m[1]} but render logs sends limit=${sent}`)
  })
})

test('SKILL.md does not call --filter a regex while the wrapper sends it as a plain text search', async () => {
  const m = DOC.match(/^- `--filter [^`]*` — (.*)$/m)
  assert.ok(m, 'BUGHUNT-F10 SKILL.md no longer documents --filter')
  await withRender(async (env, logQueries) => {
    const r = await runRender(['logs', 'srv-abc123', '--filter', 'err|warn'], env)
    assert.equal(r.status, 0, `render logs failed: ${r.stderr}`)
    assert.equal(logQueries[0].get('text'), 'err|warn', 'the wrapper passes the --filter value verbatim as text=')
    assert.ok(!/regex/i.test(DOC.match(/^- `--filter [^`]*`.*$/m)[0]),
      `BUGHUNT-F10 SKILL.md describes --filter as a regex, but the wrapper sends it as a plain text match: ${JSON.stringify(m[0])}`)
  })
})

test('SKILL.md env example matches the key-names-only output of render env', async () => {
  const section = DOC.split(/^### `render env/m)[1]
  assert.ok(section, 'BUGHUNT-F10 SKILL.md no longer documents render env')
  const example = section.match(/```bash\n([\s\S]*?)```/)[1]
  const documented = example.split('\n').filter(l => l.startsWith('#')).map(l => l.replace(/^#\s*/, '').trim())
  await withRender(async env => {
    const r = await runRender(['env', 'srv-abc123'], env)
    assert.equal(r.status, 0, `render env failed: ${r.stderr}`)
    const printed = r.stdout.split('\n').filter(Boolean)
    assert.deepEqual(printed, ['DATABASE_URL'])
    for (const line of documented) {
      assert.ok(/^[A-Z0-9_]+$/.test(line),
        `BUGHUNT-F10 SKILL.md shows env output ${JSON.stringify(line)} but render env prints bare key names only`)
    }
  })
})
