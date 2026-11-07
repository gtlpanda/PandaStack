// render-logs-tab.test.mjs — kit/skills/render/render: `logs` keeps a message that contains tabs.
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
const TABBED = 'level=error\tmsg=boom\terr=EOF'

function fakeRenderApi() {
  return createServer((req, res) => {
    const path = req.url.split('?')[0]
    res.setHeader('content-type', 'application/json')
    if (path.startsWith('/services/')) {
      res.end(JSON.stringify({ id: 'srv-abc123', name: 'supple-picks', ownerId: 'tea-1' }))
    } else if (path === '/logs') {
      res.end(JSON.stringify({
        logs: [{ timestamp: '2026-01-01T00:00:01Z', message: TABBED }],
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

test('render logs prints the whole message of a log line that contains tabs, and --grep sees it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-tab-'))
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
    const all = await runRender(['logs', 'srv-abc123', '--since', '30m'], env)
    assert.equal(all.status, 0, `render logs failed (stderr: ${JSON.stringify(all.stderr)})`)
    assert.equal(all.stdout, `2026-01-01T00:00:01Z  ${TABBED}\n`,
      `BUGHUNT-F11 render logs drops the text after the first tab in a message (got ${JSON.stringify(all.stdout)})`)

    const grep = await runRender(['logs', 'srv-abc123', '--since', '30m', '--grep', 'EOF'], env)
    assert.equal(grep.status, 0, `render logs --grep failed (stderr: ${JSON.stringify(grep.stderr)})`)
    assert.equal(grep.stdout, `2026-01-01T00:00:01Z  ${TABBED}\n`,
      `BUGHUNT-F11 render logs --grep EOF misses a line whose EOF follows a tab (got ${JSON.stringify(grep.stdout)})`)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
