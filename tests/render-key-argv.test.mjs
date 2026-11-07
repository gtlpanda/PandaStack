// render-key-argv.test.mjs — the render skill wrapper (kit/skills/render/render) must not put the
// API key on the curl command line, where any local user can read it from `ps` or /proc/*/cmdline.
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'

const RENDER = join(REPO, 'kit', 'skills', 'render', 'render')
const API_KEY = 'rnd_SECRETKEY0123456789'  // a fake key the test must never see in argv (allow-secret)

// Run the wrapper with a stand-in `curl` first on PATH that records its argv and answers `[]`.
async function runRender(args) {
  const dir = mkdtempSync(join(tmpdir(), 'render-argv-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const argvLog = join(dir, 'curl-argv.log')
    const fakeCurl = join(bin, 'curl')
    writeFileSync(fakeCurl, '#!/usr/bin/env bash\nfor a in "$@"; do printf \'%s\\n\' "$a" >> "$ARGV_LOG"; done\necho \'[]\'\n')
    chmodSync(fakeCurl, 0o755)
    const keyFile = join(dir, 'api-key')
    writeFileSync(keyFile, API_KEY, { mode: 0o600 })
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ARGV_LOG: argvLog,
      RENDER_API_KEY_FILE: keyFile,
      RENDER_API_BASE: 'http://127.0.0.1:9/v1',
    }
    return await new Promise((resolve, reject) => {
      const child = spawn('bash', [RENDER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', d => { stdout += d })
      child.stderr.on('data', d => { stderr += d })
      child.on('error', reject)
      child.on('close', code => {
        let argv = ''
        try { argv = readFileSync(argvLog, 'utf8') } catch {}
        resolve({ code, stdout, stderr, argv })
      })
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

await test('render services does not expose the API key in the curl argv', async () => {
  const r = await runRender(['services'])
  assert.ok(r.argv.length > 0, `curl was never invoked; code ${r.code}; stderr: ${r.stderr}`)
  assert.ok(!r.argv.includes(API_KEY),
    `BUGHUNT-F7 the API key is passed in curl's argv (visible to other users via ps); argv:\n${r.argv}`)
})


await test('real curl still sends the key: the server sees "Authorization: Bearer <key>"', async () => {
  const { createServer } = await import('node:http')
  const seen = []
  const server = createServer((req, res) => { seen.push(req.headers.authorization); res.setHeader('content-type', 'application/json'); res.end('[]') })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const dir = mkdtempSync(join(tmpdir(), 'render-auth-'))
  try {
    const keyFile = join(dir, 'api-key')
    writeFileSync(keyFile, API_KEY, { mode: 0o600 })
    const env = { ...process.env, RENDER_API_KEY_FILE: keyFile, RENDER_API_BASE: `http://127.0.0.1:${server.address().port}/v1`, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }
    const r = await new Promise(resolve => {
      const child = spawn('bash', [RENDER, 'services'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', d => { stderr += d })
      child.on('close', code => resolve({ code, stderr }))
    })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(seen, [`Bearer ${API_KEY}`])
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }) }
})
