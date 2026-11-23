// The detected host provider is the default wherever a backend is chosen, and it flows into the model
// roles. autobuild: --backend > AUTOBUILD_BACKEND > autobuild.json "backend" > host app > claude.
// native-cli (the Codex hunt runner): --backend > host app, and a Claude host is refused rather than run on Codex.
// The host app itself is stood in for by PANDASTACK_PROVIDER (a test cannot be launched from inside Codex or
// Claude Code); tests/host-provider.test.mjs walks a real process tree through stub executables.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { loadConfig } from '../graphs/autobuild/tool/lib/config.mjs'

function project(file = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'host-wiring-'))
  writeFileSync(join(dir, 'autobuild.json'), JSON.stringify(file))
  return dir
}
const backendOf = (file, env, overrides) => {
  const dir = project(file)
  try { return loadConfig(dir, env, overrides).backend } finally { rmSync(dir, { recursive: true, force: true }) }
}

await test('autobuild backend: no signal is claude; the host app (here PANDASTACK_PROVIDER) is the default', () => {
  assert.equal(backendOf({}, {}), 'claude')
  assert.equal(backendOf({}, { PANDASTACK_PROVIDER: 'codex' }), 'codex')
  assert.equal(backendOf({}, { PANDASTACK_PROVIDER: 'claude' }), 'claude')
  assert.equal(backendOf({}, { CODEX_THREAD_ID: 't' }), 'codex', 'the env-only fallback applies to the injected env')
  assert.equal(backendOf({}, { CLAUDECODE: '1' }), 'claude')
})

await test('autobuild backend precedence: --backend, then AUTOBUILD_BACKEND, then autobuild.json, then the host app', () => {
  const host = { PANDASTACK_PROVIDER: 'codex' }
  assert.equal(backendOf({ backend: 'claude' }, { ...host, AUTOBUILD_BACKEND: 'claude' }, { backend: 'codex' }), 'codex', 'the flag beats everything')
  assert.equal(backendOf({ backend: 'codex' }, { ...host, AUTOBUILD_BACKEND: 'claude' }), 'claude', 'AUTOBUILD_BACKEND beats the file and the host')
  assert.equal(backendOf({ backend: 'claude' }, host), 'claude', 'a backend pinned in autobuild.json beats the host')
  assert.equal(backendOf({}, { ...host, AUTOBUILD_BACKEND: '' }), 'codex', 'an empty AUTOBUILD_BACKEND is unset')
})

await test('a bad PANDASTACK_PROVIDER fails the load unless something above it already chose the backend', () => {
  const bad = { PANDASTACK_PROVIDER: 'gpt' }
  assert.throws(() => backendOf({}, bad), /PANDASTACK_PROVIDER must be "claude" or "codex"/)
  assert.equal(backendOf({}, bad, { backend: 'claude' }), 'claude', 'the flag decided; the host was never asked')
  assert.equal(backendOf({ backend: 'codex' }, bad), 'codex', 'the project file decided; the host was never asked')
})

await test('the detected provider flows into the model roles: Opus -> gpt-6-astra, Sonnet -> gpt-6.1-sol, Haiku -> gpt-6-luna on Codex', () => {
  const dir = project({})
  try {
    const codex = loadConfig(dir, { PANDASTACK_PROVIDER: 'codex' })
    assert.deepEqual([codex.backend, codex.model, codex.subagentModel, codex.probeModel], ['codex', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'])
    const claude = loadConfig(dir, { PANDASTACK_PROVIDER: 'claude' })
    assert.equal(claude.backend, 'claude')
    assert.ok(!/^gpt-/.test(claude.model) && !/^gpt-/.test(claude.subagentModel) && !/^gpt-/.test(claude.probeModel), 'Claude models on Claude')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const NATIVE_CLI = join(REPO, 'graphs/hunt/skills/bughunt/native-cli.mjs')
const cli = (env, ...args) => spawnSync(process.execPath, [NATIVE_CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 30000 })

await test('bughunt native-cli: a Claude host (or --backend claude) is refused, a bad PANDASTACK_PROVIDER is a usage error, both before any run', () => {
  const dir = project({})
  try {
    for (const [env, args] of [[{ PANDASTACK_PROVIDER: 'claude' }, []], [{}, ['--backend', 'claude']], [{ PANDASTACK_PROVIDER: 'codex' }, ['--backend', 'claude']]]) {
      const r = cli(env, '--repo', dir, ...args)
      assert.equal(r.status, 12, `${JSON.stringify(env)} ${args}: ${r.stdout}${r.stderr}`)
      assert.match(r.stderr, /Native CLI currently accepts --backend codex; Claude uses the same graph through Workflow/)
    }
    const bad = cli({ PANDASTACK_PROVIDER: 'gpt' }, '--repo', dir)
    assert.equal(bad.status, 12)
    assert.match(bad.stderr, /PANDASTACK_PROVIDER must be "claude" or "codex"/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
