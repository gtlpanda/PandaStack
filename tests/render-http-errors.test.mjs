// render-http-errors.test.mjs — the render skill wrapper (kit/skills/render/render) must abort
// with the API's error message when Render answers with a non-2xx status.
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'

const RENDER = join(REPO, 'kit', 'skills', 'render', 'render')

// Run the wrapper against a loopback server that answers every request with `status` + `body`.
async function runRender(args, status, body) {
  const dir = mkdtempSync(join(tmpdir(), 'render-http-'))
  const server = createServer((req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const keyFile = join(dir, 'api-key')
    writeFileSync(keyFile, 'rnd_test', { mode: 0o600 })
    const env = {
      ...process.env,
      RENDER_API_KEY_FILE: keyFile,
      RENDER_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
    }
    return await new Promise((resolve, reject) => {
      const child = spawn('bash', [RENDER, ...args], { env })
      let stdout = '', stderr = ''
      child.stdout.on('data', d => { stdout += d })
      child.stderr.on('data', d => { stderr += d })
      child.on('error', reject)
      child.on('close', code => resolve({ code, stdout, stderr }))
    })
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('render logs aborts with the API error on a 404 instead of reporting 0 log lines', async () => {
  const r = await runRender(['logs', 'srv-doesnotexist'], 404, { message: 'Not Found' })
  assert.notEqual(r.code, 0, `BUGHUNT-F4 exit code was 0 for a 404; stderr: ${r.stderr}`)
  assert.match(r.stderr, /Not Found/, `BUGHUNT-F4 API error message not surfaced; stderr: ${r.stderr}`)
  assert.doesNotMatch(r.stderr, /0 log lines/, `BUGHUNT-F4 404 reported as an empty log result; stderr: ${r.stderr}`)
})

test('render services aborts with the API error on a 401 instead of a jq failure', async () => {
  const r = await runRender(['services'], 401, { message: 'Unauthorized' })
  assert.notEqual(r.code, 0, `BUGHUNT-F4 exit code was 0 for a 401; stderr: ${r.stderr}`)
  assert.match(r.stderr, /Unauthorized/, `BUGHUNT-F4 API error message not surfaced; stderr: ${r.stderr}`)
  assert.doesNotMatch(r.stderr, /Cannot index/, `BUGHUNT-F4 401 surfaced as a cryptic jq error; stderr: ${r.stderr}`)
})
