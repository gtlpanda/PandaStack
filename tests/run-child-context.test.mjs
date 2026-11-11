import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'
import { loadConfig } from '../graphs/autobuild/tool/lib/config.mjs'
import { sessionSettings } from '../graphs/autobuild/tool/lib/loop.mjs'
import { buildEnv, sessionConfigEnv } from '../graphs/autobuild/tool/lib/proc.mjs'

const selection = config => ({
  backend: config.backend, model: config.model, subagentModel: config.subagentModel,
  probeModel: config.probeModel, deliveryMode: config.deliveryMode, binary: config[`${config.backend}Bin`],
})

async function fixture(work) {
  const repo = mkdtempSync(join(tmpdir(), 'child context '))
  const write = config => writeFileSync(join(repo, 'autobuild.json'), JSON.stringify(config))
  try { await work(repo, write) } finally { rmSync(repo, { recursive: true, force: true }) }
}

for (const hooks of ['inject', 'project']) {
  await test(`Claude child settings retain every accepted selection with ${hooks} hooks`, () => fixture((repo, write) => {
    const parentEnv = { ...process.env }
    const shadows = [
      {}, { AUTOBUILD_DELIVERY_MODE: 'pr-first' }, { AUTOBUILD_DELIVERY_MODE: 'invalid' }, { AUTOBUILD_BACKEND: 'codex' }, { AUTOBUILD_BACKEND: 'invalid' },
      { AUTOBUILD_MODEL: 'haiku', MODEL: 'bad model' },
      { AUTOBUILD_SUBAGENT_MODEL: 'haiku' }, { SUBAGENT_MODEL: 'opus' },
      { AUTOBUILD_SUBAGENT_MODEL: 'bad model' },
      { AUTOBUILD_PROBE_MODEL: 'opus' }, { AUTOBUILD_PROBE_MODEL: 'bad model' },
      { AUTOBUILD_CLAUDE_BIN: '/unselected/provider' },
      { AUTOBUILD_CLAUDE_BIN: '\n' }, { AUTOBUILD_CLAUDE_BIN: '' },
      { AUTOBUILD_BACKEND: 'invalid', AUTOBUILD_MODEL: 'bad model',
        AUTOBUILD_SUBAGENT_MODEL: 'bad model', SUBAGENT_MODEL: 'opus',
        AUTOBUILD_PROBE_MODEL: 'bad model', AUTOBUILD_CLAUDE_BIN: '' },
    ]
    for (const vars of shadows) {
      write({ backend: 'codex', model: 'opus', subagentModel: 'sonnet', probeModel: 'haiku',
        claudeBin: '/project/provider', hooks, frozen: ['tests'], env: { vars: {
          ...vars, ORDINARY_SETTING: 'retained',
          CLAUDE_CODE_OAUTH_TOKEN: 'EXAMPLE-child-context-sentinel',
        } } })
      const accepted = loadConfig(repo, { AUTOBUILD_CLAUDE_BIN: '/accepted provider/claude' },
        { backend: 'claude', model: 'claude-fable-5-1' })
      const before = structuredClone(accepted)
      const settings = sessionSettings(accepted)
      const context = sessionConfigEnv(accepted)
      assert.deepEqual(Object.keys(context).sort(), ['AUTOBUILD_BACKEND', 'AUTOBUILD_DELIVERY_MODE', 'AUTOBUILD_MODEL',
        'AUTOBUILD_SUBAGENT_MODEL', 'AUTOBUILD_PROBE_MODEL', 'AUTOBUILD_CLAUDE_BIN'].sort())
      assert.equal(accepted.deliveryMode, 'full')
      assert.equal(context.AUTOBUILD_DELIVERY_MODE, 'full')
      const processEnv = buildEnv(accepted, context)
      const child = { ...processEnv, ...settings.env }
      for (const env of [processEnv, { ...buildEnv(accepted), ...settings.env }, child]) {
        assert.deepEqual(selection(loadConfig(repo, env)), selection(accepted), JSON.stringify(vars))
      }
      assert.equal(child.ORDINARY_SETTING, 'retained')
      assert.equal(child.CLAUDE_CODE_OAUTH_TOKEN, 'EXAMPLE-child-context-sentinel')
      assert.ok(!JSON.stringify(settings).includes('EXAMPLE-child-context-sentinel'))
      assert.equal(settings.model, accepted.model)
      assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, accepted.subagentModel)
      assert.ok(settings.permissions.deny.includes('Edit(/tests/**)'))
      assert.ok(settings.permissions.deny.includes('Bash(git push *)'))
      assert.ok(settings.hooks.StopFailure)
      if (hooks === 'inject') {
        assert.equal(settings.hooks.PreToolUse[0].hooks[0].onFailure, 'block')
        assert.match(settings.hooks.Stop[0].hooks[0].command, /stop-gate\.mjs/)
      } else {
        assert.equal(settings.hooks.PreToolUse, undefined)
        assert.equal(settings.hooks.Stop, undefined)
      }
      assert.deepEqual(accepted, before)
    }
    assert.deepEqual({ ...process.env }, parentEnv)
  }))
}

await test('accepted session contexts stay independent across invocations and carry no authority or secrets', () => fixture((repo, write) => {
  write({ backend: 'claude', model: 'sonnet', subagentModel: 'haiku', probeModel: 'sonnet' })
  const first = loadConfig(repo, {}, { model: 'claude-fable-5-1' })
  const firstContext = sessionConfigEnv(first)
  const second = loadConfig(repo, { AUTOBUILD_CLAUDE_BIN: '/second/provider',
    AUTOBUILD_SUBAGENT_MODEL: 'opus', AUTOBUILD_PROBE_MODEL: 'haiku' }, { model: 'sonnet' })
  const secondContext = sessionConfigEnv(second)
  assert.notDeepEqual(firstContext, secondContext)
  assert.deepEqual(selection(loadConfig(repo, firstContext)), selection(first))
  assert.deepEqual(selection(loadConfig(repo, secondContext)), selection(second))
  firstContext.AUTOBUILD_MODEL = 'haiku'
  assert.equal(sessionConfigEnv(first).AUTOBUILD_MODEL, 'claude-fable-5-1')
  assert.equal(secondContext.AUTOBUILD_MODEL, 'sonnet')
  assert.equal(firstContext.AUTOBUILD_ACTIVE, undefined)
  assert.equal(firstContext.AUTOBUILD_ROLE, undefined)
  assert.equal(firstContext.CLAUDE_CODE_OAUTH_TOKEN, undefined)
}))

await test('invalid selected parent context still fails shared validation', () => fixture((repo, write) => {
  for (const invalid of [{ model: null }, { subagentModel: 'bad model' },
    { probeModel: '' }, { claudeBin: '\n' }, { backend: 'invalid' }]) {
    write({ backend: 'claude', ...invalid })
    assert.throws(() => loadConfig(repo, {}))
  }
}))

await test('partial Claude settings inputs retain native defaults and frozen-path exceptions', () => {
  const settings = sessionSettings({ hooks: 'inject', frozen: ['spec'],
    writable: ['spec/DECISIONS.md'], subagentModel: 'claude-haiku-5-5' })
  assert.equal(settings.env.AUTOBUILD_BACKEND, 'claude')
  assert.equal(settings.env.AUTOBUILD_DELIVERY_MODE, 'full')
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, 'claude-haiku-5-5')
  assert.ok(settings.model)
  assert.ok(settings.permissions.deny.includes('Edit(/spec)'))
  assert.ok(!settings.permissions.deny.includes('Edit(/spec/**)'))
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].onFailure, 'block')
})
