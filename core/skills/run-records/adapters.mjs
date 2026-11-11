// Snapshot only managed settings, never prompts, argv, or arbitrary environment.
import { readFileSync } from 'node:fs'
import { sanitizeSettings } from './records.mjs'
import { resolve } from 'node:path'
import { readAgentConfig } from '../../../scripts/agent-config.mjs'
import { resolveSettings } from './doctor.mjs'
export const runnerRoot = resolve(import.meta.dirname, '../../..')
function snapshot(backend, project) {
  try {
    const { values, sources } = resolveSettings({ backend, central: readAgentConfig(), project, env: {} })
    return { ...values, sources }
  } catch { return {} } // Unknown metadata must not stop execution.
}
export function autobuildTracking(config, workflow) {
  const settings = snapshot(config.backend ?? 'claude', config)
  // loadConfig has already merged CLI, env, project and defaults. Do not label
  // these effective values as raw project evidence.
  for (const key of Object.keys(settings.sources ?? {})) {
    if (settings.sources[key] === 'project') settings.sources[key] = 'runtime'
  }
  return { repo: config.root, runnerRoot, workflow, backend: config.backend ?? 'claude', settings }
}
export function buildTracking(repo, model, workflow) {
  const settings = snapshot('claude', {})
  if (model !== undefined) {
    settings.model = model
    settings.sources = { ...settings.sources, model: 'runtime' }
  }
  return { repo, runnerRoot, workflow, backend: 'claude', settings }
}

// The generated settings file and explicit flags are the session's actual input.
export function buildSessionTracking({ repo, args, env = {} }) {
  const options = buildTracking(repo, undefined, 'session')
  try {
    const value = flag => { const i = args.lastIndexOf(flag); return i < 0 ? undefined : args[i + 1] }
    const native = JSON.parse(readFileSync(resolve(repo, value('--settings')), 'utf8'))
    const vars = { ...env, ...native.env }
    const fields = {
      model: value('--model') ?? native.model,
      effort: vars.CLAUDE_CODE_EFFORT_LEVEL ?? native.effortLevel,
      advisorModel: native.advisorModel,
      subagentModel: vars.CLAUDE_CODE_SUBAGENT_MODEL,
      subagentEffort: vars.CLAUDE_CODE_SUBAGENT_EFFORT,
    }
    if (vars.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS !== undefined) fields.maxConcurrentSubagents = Number(vars.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS)
    if (vars.CLAUDE_CODE_SUBAGENT_MODEL_FORCE !== undefined) fields.subagentModelForce = vars.CLAUDE_CODE_SUBAGENT_MODEL_FORCE === '1'
    if (fields.subagentModelForce) fields.advisorModel = vars.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL || fields.subagentModel
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue
      try { options.settings[key] = sanitizeSettings({ [key]: value })[key]; options.settings.sources[key] = 'runtime' }
      catch { delete options.settings[key]; delete options.settings.sources[key] }
    }
  } catch { options.settings = {} }
  return options
}
