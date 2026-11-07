// render-logs-grep.test.mjs — kit/skills/render/render: `logs --grep` with no matching line.
// Runs the real script against a loopback fake of the Render API.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { test } from '../scripts/workflow-harness.mjs'

const RENDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'kit', 'skills', 'render', 'render')

function fakeRenderApi() {
  return createServer((req, res) => {
    const path = req.url.split('?')[0]
    res.setHeader('content-type', 'application/json')
    if (path.startsWith('/services/')) {
      res.end(JSON.stringify({ id: 'srv-abc123', name: 'supple-picks', ownerId: 'tea-1' }))
    } else if (path === '/logs') {
      res.end(JSON.stringify({
        logs: [
          { timestamp: '2026-01-01T00:00:01Z', message: 'GET /health 200' },
          { timestamp: '2026-01-01T00:00:02Z', message: 'GET /picks 200' },
        ],
        hasMore: false,
      }))
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

test('render logs --grep with no matching line prints the footer and exits 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-grep-'))
  const server = fakeRenderApi()
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
    const r = await runRender(['logs', 'srv-abc123', '--since', '30m', '--grep', 'EARLY_RETURN'], env)
    assert.equal(r.stdout, '', 'no line matches, so stdout is empty')
    assert.equal(r.status, 0,
      `BUGHUNT-F2 render logs --grep aborts with exit ${r.status} when nothing matches (stderr: ${JSON.stringify(r.stderr)})`)
    assert.match(r.stderr, /2 log lines/, 'BUGHUNT-F2 no footer with the log counts was printed when nothing matched')
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
