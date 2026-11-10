// Shared defaults for installed workflows and the two autobuild backends.
import { readFileSync } from 'node:fs'
export const CONFIG_URL = new URL('../agent-config.json', import.meta.url)
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)
function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`${label}: expected an object with keys ${allowed.join(', ')}`)
}
export function validateAgentConfig(config) {
  keys(config, ['maxConcurrentSubagents', 'claude'], 'agent-config')
  validateConcurrency(config.maxConcurrentSubagents)
  keys(config.claude, ['orchestrator', 'advisor', 'subagents', 'agentOverrides'], 'claude')
  const role = (value, label, partial = false) => {
    keys(value, ['model', 'effort'], label)
    if ((!partial || value.model !== undefined) && (typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value.model))) throw new Error(`${label}.model must be a nonempty model identifier`)
    if ((!partial || value.effort !== undefined) && !EFFORTS.includes(value.effort)) throw new Error(`${label}.effort must be ${EFFORTS.join('|')}`)
  }
  for (const name of ['orchestrator', 'advisor', 'subagents']) role(config.claude[name], `claude.${name}`)
  if (!object(config.claude.agentOverrides)) throw new Error('claude.agentOverrides must be an object')
  for (const [name, value] of Object.entries(config.claude.agentOverrides)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || name === 'advisor') throw new Error(`invalid agent override: ${name}`)
    role(value, `claude.agentOverrides.${name}`, true)
  }
  return config
}
export function validateConcurrency(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('maxConcurrentSubagents must be a positive safe integer')
  return value
}
export function readAgentConfig(file = CONFIG_URL) {
  return validateAgentConfig(JSON.parse(readFileSync(file, 'utf8')))
}
export function agentRole(config, name) {
  return name === 'advisor' ? config.claude.advisor : { ...config.claude.subagents, ...config.claude.agentOverrides[name] }
}
export function claudeAgentSettings(config = readAgentConfig()) {
  validateAgentConfig(config)
  return {
    model: config.claude.orchestrator.model,
    advisorModel: config.claude.advisor.model,
    effortLevel: config.claude.orchestrator.effort,
    env: {
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(config.maxConcurrentSubagents),
      CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: String(config.maxConcurrentSubagents),
      CLAUDE_CODE_SUBAGENT_MODEL: config.claude.subagents.model,
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '0',
      CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: '',
      CLAUDE_CODE_SUBAGENT_EFFORT: config.claude.subagents.effort,
    },
  }
}
export function codexConcurrencyArgs(value) {
  return ['-c', `agents.max_concurrent_threads_per_session=${validateConcurrency(value)}`]
}
