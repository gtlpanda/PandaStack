// render-env-values.test.mjs - the render wrapper is documented as names-only for env vars.
// `render service` must not be a way to reach the env-vars endpoint and print its values.
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'

const RENDER = join(REPO, 'kit', 'skills', 'render', 'render')
const SECRET_VALUE = 'postgres://user:hunter2-BUGHUNT@db.internal/app'  // a fake value the test must never see printed (allow-secret)

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

test('render service with a path-injected srv- id never reaches the env-vars endpoint', async () => {
  const requested = []
  const server = createServer((req, res) => {
    requested.push(req.url)
    res.setHeader('content-type', 'application/json')
    if (req.url.split('?')[0].endsWith('/env-vars')) {
      res.end(JSON.stringify([{ envVar: { key: 'DATABASE_URL', value: SECRET_VALUE } }]))
    } else {
      res.end('[]')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const dir = mkdtempSync(join(tmpdir(), 'render-env-'))
  try {
    const keyFile = join(dir, 'api-key')
    writeFileSync(keyFile, 'rnd_test_key')
    chmodSync(keyFile, 0o600)
    // The wrapper probes file mode with BSD `stat -f '%Lp'`; GNU stat treats -f as "filesystem
    // status" and prints junk, so the wrapper would refuse the key before any request. Shim
    // `stat -f` to fail silently (as the wrapper expects off macOS) and defer to real stat otherwise.
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const shim = join(bin, 'stat')
    writeFileSync(shim, '#!/bin/sh\nif [ "$1" = "-f" ]; then exit 1; fi\nexec /usr/bin/stat "$@"\n')
    chmodSync(shim, 0o755)
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      RENDER_API_KEY_FILE: keyFile,
      RENDER_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
    }
    const out = await runRender(['service', 'srv-abc123/env-vars'], env)
    const hitEnvVars = requested.some(u => u.split('?')[0].endsWith('/env-vars'))
    assert.equal(hitEnvVars, false,
      `BUGHUNT-F7 render service requested the env-vars endpoint via a path-injected id: ${JSON.stringify(requested)}`)
    assert.equal(out.stdout.includes(SECRET_VALUE), false,
      'BUGHUNT-F7 render service printed plaintext env var values')
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
