// The detected host provider is the default wherever a provider is about to be started, and it flows into the
// model roles. autobuild run: --backend > AUTOBUILD_BACKEND > autobuild.json "backend" > host app > claude.
// native-cli (the Codex hunt runner) is NOT host-wired: a bare run stays Codex, --backend claude is refused.
// The host app itself is stood in for by PANDASTACK_PROVIDER (a test cannot be launched from inside Codex or
// Claude Code); tests/host-provider.test.mjs walks a real process tree through stub executables.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { loadConfig } from '../graphs/autobuild/tool/lib/config.mjs'
import { runCodex } from '../graphs/autobuild/tool/lib/codex.mjs'
import { defaultBackendFor, withHostBackendHint } from '../graphs/autobuild/tool/lib/host-backend.mjs'

function project(file = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'host-wiring-'))
  writeFileSync(join(dir, 'autobuild.json'), JSON.stringify(file))
  return dir
}
const backendOf = (file, env, overrides) => {
  const dir = project(file)
  try { return loadConfig(dir, env, overrides).backend } finally { rmSync(dir, { recursive: true, force: true }) }
}

await test('loadConfig never looks at the host: a command that only reads config (status, gate, hooks) loads the same from inside Codex', () => {
  assert.equal(backendOf({}, {}), 'claude')
  assert.equal(backendOf({}, { PANDASTACK_PROVIDER: 'codex' }), 'claude')
  assert.equal(backendOf({}, { PANDASTACK_PROVIDER: 'gpt' }), 'claude', 'not even a bad override is read')
  assert.equal(backendOf({ limits: { totalBudgetUsd: 5 } }, { PANDASTACK_PROVIDER: 'codex' }), 'claude', 'a USD budget does not make a Claude project unloadable from Codex')
})

await test('autobuild backend precedence: --backend, then AUTOBUILD_BACKEND, then autobuild.json, then the host default, then claude', () => {
  const host = { defaultBackend: 'codex' }
  assert.equal(backendOf({}, {}), 'claude', 'nothing decided')
  assert.equal(backendOf({}, {}, host), 'codex', 'the host default fills the gap')
  assert.equal(backendOf({ backend: 'claude' }, {}, host), 'claude', 'a backend pinned in autobuild.json beats the host')
  assert.equal(backendOf({ backend: 'claude' }, { AUTOBUILD_BACKEND: 'codex' }, host), 'codex', 'AUTOBUILD_BACKEND beats the file and the host')
  assert.equal(backendOf({ backend: 'claude' }, { AUTOBUILD_BACKEND: 'claude' }, { ...host, backend: 'codex' }), 'codex', 'the flag beats everything')
  assert.equal(backendOf({}, { AUTOBUILD_BACKEND: '' }, host), 'codex', 'an empty AUTOBUILD_BACKEND is unset')
})

await test('defaultBackendFor asks the host only when no flag and no AUTOBUILD_BACKEND decided; a bad PANDASTACK_PROVIDER is a usage error then', () => {
  assert.equal(defaultBackendFor({ flag: 'claude', env: { PANDASTACK_PROVIDER: 'gpt' } }), undefined, 'the flag decided; the host was never asked')
  assert.equal(defaultBackendFor({ env: { AUTOBUILD_BACKEND: 'claude', PANDASTACK_PROVIDER: 'gpt' } }), undefined)
  assert.equal(defaultBackendFor({ env: { PANDASTACK_PROVIDER: 'codex' } }), 'codex')
  assert.equal(defaultBackendFor({ env: { PANDASTACK_PROVIDER: 'claude' } }), 'claude')
  assert.equal(defaultBackendFor({ env: {} }), 'claude')
  assert.throws(() => defaultBackendFor({ env: { PANDASTACK_PROVIDER: 'gpt' } }), /PANDASTACK_PROVIDER must be "claude" or "codex"/)
})

await test('behaviour change: `autobuild run` from inside Codex in a Claude-shaped project with a USD budget fails to load, and says how to choose Claude', () => {
  // Before host detection a bare `autobuild run` always meant Claude; now, from Codex, it means Codex, and Codex has no dollar cost.
  const dir = project({ limits: { totalBudgetUsd: 5 } })
  try {
    const host = defaultBackendFor({ env: { PANDASTACK_PROVIDER: 'codex' } })
    let thrown
    try { loadConfig(dir, {}, { defaultBackend: host }) } catch (error) { thrown = error }
    assert.match(thrown.message, /^Codex does not report dollar cost; remove totalBudgetUsd/)
    assert.match(withHostBackendHint(thrown, host).message, /"codex" as its default because that is the app you are in; autobuild.json "backend", AUTOBUILD_BACKEND or --backend choose another\)$/)
    // The ways out: the flag, the env var, or a pin in autobuild.json each load it as Claude.
    assert.equal(loadConfig(dir, {}, { backend: 'claude', defaultBackend: host }).backend, 'claude')
    assert.equal(loadConfig(dir, { AUTOBUILD_BACKEND: 'claude' }, { defaultBackend: host }).backend, 'claude')
    assert.equal(withHostBackendHint(new Error('x'), undefined).message, 'x', 'no hint when the host was not what chose')
    assert.equal(withHostBackendHint('not an error', 'codex'), 'not an error')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test('the detected provider flows into the model roles: Opus -> gpt-6-astra, Sonnet -> gpt-6.1-sol, Haiku -> gpt-6-luna on Codex', () => {
  const dir = project({})
  try {
    const codex = loadConfig(dir, {}, { defaultBackend: defaultBackendFor({ env: { PANDASTACK_PROVIDER: 'codex' } }) })
    assert.deepEqual([codex.backend, codex.model, codex.subagentModel, codex.probeModel], ['codex', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'])
    const claude = loadConfig(dir, {}, { defaultBackend: defaultBackendFor({ env: { PANDASTACK_PROVIDER: 'claude' } }) })
    assert.equal(claude.backend, 'claude')
    assert.ok(!/^gpt-/.test(claude.model) && !/^gpt-/.test(claude.subagentModel) && !/^gpt-/.test(claude.probeModel), 'Claude models on Claude')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test('a Codex session autobuild starts carries PANDASTACK_PROVIDER=codex even when the project env.vars pin claude (this repo\'s gate does)', async () => {
  const dir = project({ env: { vars: { PANDASTACK_PROVIDER: 'claude' } } })
  try {
    const seen = join(dir, 'seen.txt')
    const stub = join(dir, 'fake-codex')
    writeFileSync(stub, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(seen)}, [process.env.PANDASTACK_PROVIDER, process.env.AUTOBUILD_BACKEND].join(','))\n`)
    chmodSync(stub, 0o755)
    const config = loadConfig(dir, { AUTOBUILD_BACKEND: 'codex', AUTOBUILD_CODEX_BIN: stub })
    assert.equal(config.env.vars.PANDASTACK_PROVIDER, 'claude', 'fixture: the project pins claude for its gate steps')
    const code = await runCodex(config, { role: 'probe', prompt: 'inert fixture', logFile: join(dir, 'probe.log') })
    assert.equal(code, 0)
    assert.equal(readFileSync(seen, 'utf8'), 'codex,codex')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const NATIVE_CLI = join(REPO, 'graphs/hunt/skills/bughunt/native-cli.mjs')
const cli = (env, ...args) => spawnSync(process.execPath, [NATIVE_CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 30000 })

await test('bughunt native-cli is the Codex runner: --backend claude is refused, a bare run is not turned away by the host app', () => {
  const dir = project({})
  try {
    const refusal = /Native CLI currently accepts --backend codex; Claude uses the same graph through Workflow/
    const claude = cli({}, '--repo', dir, '--backend', 'claude')
    assert.equal(claude.status, 12, claude.stdout + claude.stderr)
    assert.match(claude.stderr, refusal)
    // Host detection does not apply to this CLI: with a Claude host a bare run still starts the Codex path (it
    // then stops at its own intake, this directory being no git repository, which is not the backend refusal).
    for (const env of [{ PANDASTACK_PROVIDER: 'claude' }, { PANDASTACK_PROVIDER: 'codex' }, {}]) {
      const bare = cli(env, '--repo', dir)
      assert.equal(bare.status, 12)
      assert.doesNotMatch(bare.stderr, refusal, JSON.stringify(env))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
