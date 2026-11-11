import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, REPO, extractMeta } from '../scripts/workflow-harness.mjs'
import { readAgentConfig, validateAgentConfig, claudeAgentSettings, codexConcurrencyArgs } from '../scripts/agent-config.mjs'
import { renderAgentConfig, syncAgentConfig } from '../scripts/configure-agents.mjs'
import { loadConfig } from '../graphs/autobuild/tool/lib/config.mjs'
import { sessionSettings } from '../graphs/autobuild/tool/lib/loop.mjs'
import { codexArgs } from '../graphs/autobuild/tool/lib/codex.mjs'

await test('central config rejects malformed limits, roles, efforts and misspelled fields', () => {
  const base = readAgentConfig()
  for (const value of [0, -1, 1.5, '8', null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateAgentConfig({ ...base, maxConcurrentSubagents: value }), /positive safe integer/)
  }
  for (const value of [null, [], {}, { ...base, typo: 1 }]) assert.throws(() => validateAgentConfig(value))
  for (const role of ['orchestrator', 'advisor', 'subagents']) for (const patch of [{ effort: 'ultra' }, { model: '' }, { model: "x'\n" }, { typo: true }]) {
    const config = structuredClone(base)
    Object.assign(config.claude[role], patch)
    assert.throws(() => validateAgentConfig(config))
  }
})
await test('distinct role settings reach every agent pin and workflow call, preserving hooks and tools', () => {
  const config = readAgentConfig()
  config.maxConcurrentSubagents = 3
  config.claude = { orchestrator: { model: 'opus', effort: 'medium' }, advisor: { model: 'fable', effort: 'max' }, subagents: { model: 'haiku', effort: 'low' }, agentOverrides: {} }
  const output = renderAgentConfig(REPO, config)
  const settings = JSON.parse(output.get('settings.json'))
  assert.equal(settings.model, 'opus')
  assert.equal(settings.advisorModel, 'fable')
  assert.equal(settings.effortLevel, 'medium')
  assert.equal(settings.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, '3')
  assert.equal(settings.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS, '3')
  assert.deepEqual(settings.hooks, JSON.parse(readFileSync(join(REPO, 'settings.json'))).hooks)
  for (const [file, text] of output) {
    if (file.endsWith('.md')) {
      assert.match(text, file.endsWith('/advisor.md') ? /model: fable\neffort: max/ : /model: haiku\neffort: low/)
      assert.equal(/^tools: .*$/m.exec(text)?.[0], /^tools: .*$/m.exec(readFileSync(join(REPO, file), 'utf8'))?.[0])
    }
    if (file.endsWith('.js')) {
      const meta = extractMeta(text, file)
      for (const phase of meta.phases.filter(p => p.model)) assert.ok(['haiku', 'fable'].includes(phase.model), `${file}: stale phase model`)
    }
    if (file.endsWith('.js')) for (const match of text.matchAll(/agentType: '([^']+)',\s*model: '([^']+)',\s*effort: '([^']+)'/g)) {
      assert.deepEqual(match.slice(2), match[1] === 'advisor' ? ['fable', 'max'] : ['haiku', 'low'])
    }
  }
  assert.deepEqual(codexConcurrencyArgs(3), ['-c', 'agents.max_concurrent_threads_per_session=3'])
})
await test('sync is idempotent, check detects stale output without writing, and invalid config changes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-config-'))
  try {
    for (const file of ['agent-config.json', 'settings.json', 'core', 'graphs']) cpSync(join(REPO, file), join(root, file), { recursive: true })
    syncAgentConfig(root)
    assert.deepEqual(syncAgentConfig(root, true), [])
    const config = readAgentConfig(join(root, 'agent-config.json'))
    config.claude.advisor.effort = 'low'
    writeFileSync(join(root, 'agent-config.json'), JSON.stringify(config))
    const before = readFileSync(join(root, 'core/agents/advisor.md'), 'utf8')
    assert.throws(() => syncAgentConfig(root, true), /out of sync/)
    assert.equal(readFileSync(join(root, 'core/agents/advisor.md'), 'utf8'), before)
    syncAgentConfig(root)
    assert.match(readFileSync(join(root, 'core/agents/advisor.md'), 'utf8'), /effort: low/)
    assert.deepEqual(syncAgentConfig(root), [])
    config.claude.agentOverrides.typo = { model: 'haiku' }
    writeFileSync(join(root, 'agent-config.json'), JSON.stringify(config))
    assert.throws(() => syncAgentConfig(root), /unknown agent override/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
await test('autobuild applies central defaults and per-project concurrency/model overrides to both providers', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-defaults-'))
  try {
    const file = join(root, 'autobuild.json')
    writeFileSync(file, '{}')
    const config = loadConfig(root, {})
    const central = readAgentConfig()
    assert.equal(config.model, central.claude.orchestrator.model)
    assert.equal(config.maxConcurrentSubagents, central.maxConcurrentSubagents)
    assert.equal(config.subagentModelForce, false)
    assert.equal(sessionSettings(config).env.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL, '')
    assert.equal(sessionSettings(config).advisorModel, central.claude.advisor.model)
    writeFileSync(file, JSON.stringify({ model: 'claude-custom', subagentModel: 'haiku', maxConcurrentSubagents: 2 }))
    const custom = loadConfig(root, {})
    assert.equal(custom.model, 'claude-custom')
    assert.equal(sessionSettings(custom).env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, '2')
    writeFileSync(file, JSON.stringify({ backend: 'codex', maxConcurrentSubagents: 2 }))
    assert.ok(codexArgs(loadConfig(root, {}), { prompt: 'test' }).args.includes('agents.max_concurrent_threads_per_session=2'))
    writeFileSync(file, '{"maxConcurrentSubagents":0}')
    assert.throws(() => loadConfig(root, {}), /positive safe integer/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

await test('interactive launchers pass native controls, preserve argument boundaries, and propagate failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-launch-'))
  try {
    for (const cli of ['claude', 'codex']) {
      const fake = join(root, cli)
      writeFileSync(fake, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2))); process.exit(7)\n')
      chmodSync(fake, 0o755)
      const result = spawnSync(process.execPath, [join(REPO, 'scripts/configure-agents.mjs'), cli, 'argument with spaces'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
      })
      assert.equal(result.status, 7, result.stderr)
      const args = JSON.parse(result.stdout)
      assert.equal(args.at(-1), 'argument with spaces')
      if (cli === 'claude') {
        assert.equal(args[0], '--settings')
        assert.deepEqual(JSON.parse(args[1]), claudeAgentSettings())
      } else assert.deepEqual(args.slice(0, 2), codexConcurrencyArgs(readAgentConfig().maxConcurrentSubagents))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
