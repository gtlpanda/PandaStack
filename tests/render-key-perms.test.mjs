// render-key-perms.test.mjs — kit/skills/render/render accepts a key file whose mode is 600,
// on GNU stat (Linux) as well as BSD stat.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { test } from '../scripts/workflow-harness.mjs'

const RENDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'kit', 'skills', 'render', 'render')

function runRender(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [RENDER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

test('render services accepts an api-key file at mode 600', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-perms-'))
  const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('[]') })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const keyFile = join(dir, 'api-key')
    writeFileSync(keyFile, 'rnd_testkey')
    chmodSync(keyFile, 0o600)
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      RENDER_API_KEY_FILE: keyFile,
      RENDER_API_BASE: `http://127.0.0.1:${server.address().port}`,
    }
    const r = await runRender(['services'], env)
    assert.doesNotMatch(r.stderr, /refuse to read/, `BUGHUNT-F1 a mode-600 key file was refused: ${r.stderr}`)
    assert.equal(r.status, 0, `BUGHUNT-F1 render services exited ${r.status}: ${r.stderr}`)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
