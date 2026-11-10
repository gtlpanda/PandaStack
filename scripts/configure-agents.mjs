// Workflows cannot import modules or read files: materialize their role pins.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readAgentConfig, validateAgentConfig, agentRole, claudeAgentSettings, codexConcurrencyArgs } from './agent-config.mjs'
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function renderAgentConfig(root, config) {
  validateAgentConfig(config)
  const files = new Map()
  const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))
  const native = claudeAgentSettings(config)
  files.set('settings.json', JSON.stringify({ ...settings, ...native, env: { ...settings.env, ...native.env } }, null, 2) + '\n')
  const roots = ['core', ...readdirSync(join(root, 'graphs')).map(g => `graphs/${g}`)]
  const agents = new Set()
  for (const dir of roots) {
    const agentDir = join(root, dir, 'agents')
    if (existsSync(agentDir)) for (const name of readdirSync(agentDir).filter(f => f.endsWith('.md'))) {
      const file = `${dir}/agents/${name}`
      const src = readFileSync(join(root, file), 'utf8')
      const id = /^name: (.+)$/m.exec(src)?.[1]
      if (!id || !src.startsWith('---\n')) throw new Error(`invalid agent frontmatter: ${file}`)
      agents.add(id)
      const role = agentRole(config, id)
      const end = src.indexOf('\n---', 4)
      if (end < 0 || !/^model: .+$/m.test(src.slice(0, end)) || !/^effort: .+$/m.test(src.slice(0, end))) throw new Error(`missing role pins: ${file}`)
      const header = src.slice(0, end).replace(/^model: .*$/m, `model: ${role.model}`).replace(/^effort: .*$/m, `effort: ${role.effort}`)
      files.set(file, header + src.slice(end))
    }
    const workflowDir = join(root, dir, 'workflows')
    if (existsSync(workflowDir)) for (const name of readdirSync(workflowDir).filter(f => f.endsWith('.js'))) {
      const file = `${dir}/workflows/${name}`
      const src = readFileSync(join(root, file), 'utf8')
      let count = 0
      const phaseModels = new Map()
      let output = src.replace(/agentType: '([^']+)',(\s*)model: '[^']+'(,\s*effort: )'[^']+'(,\s*phase: '([^']+)')/g, (_, id, gap, effortGap, tail, phase) => {
        count++
        const role = agentRole(config, id)
        // A phase can contain several agents; display its first (primary) node.
        if (!phaseModels.has(phase)) phaseModels.set(phase, role.model)
        return `agentType: '${id}',${gap}model: '${role.model}'${effortGap}'${role.effort}'${tail}`
      })
      output = output.replace(/(\{ title: '([^']+)'[^\n]*?model: ')[^']+(')/g, (line, prefix, phase, suffix) => phaseModels.has(phase) ? prefix + phaseModels.get(phase) + suffix : line)
      if (!count) throw new Error(`no role nodes found: ${file}`)
      files.set(file, output)
    }
  }
  for (const name of Object.keys(config.claude.agentOverrides)) if (!agents.has(name)) throw new Error(`unknown agent override: ${name}`)
  return files
}
export function syncAgentConfig(root = ROOT, check = false) {
  const files = renderAgentConfig(root, readAgentConfig(join(root, 'agent-config.json')))
  const changed = [...files].filter(([file, text]) => readFileSync(join(root, file), 'utf8') !== text)
  if (check && changed.length) throw new Error(`Agent config is out of sync: ${changed.map(([f]) => f).join(', ')}. Run node scripts/configure-agents.mjs sync`)
  for (const [file, text] of changed) writeFileSync(join(root, file), text)
  return changed.map(([file]) => file)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'codex' || command === 'claude') {
    const config = readAgentConfig()
    if (command === 'claude') syncAgentConfig()
    const options = command === 'codex' ? codexConcurrencyArgs(config.maxConcurrentSubagents) : ['--settings', JSON.stringify(claudeAgentSettings(config))]
    const result = spawnSync(command, [...options, ...args], { stdio: 'inherit' })
    if (result.error) console.error(result.error.message)
    process.exit(result.status ?? 1)
  }
  if (!['sync', 'check'].includes(command) || args.length) throw new Error('Usage: node scripts/configure-agents.mjs sync|check|codex|claude [CLI arguments]')
  console.log(`${command}: ${syncAgentConfig(ROOT, command === 'check').length} changed files`)
}
