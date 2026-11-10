#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectDoctor } from '../core/skills/run-records/doctor.mjs'

export async function main(args) {
  try {
    if (args[0] !== 'doctor') throw Error('usage')
    const options = {}, seen = new Set()
    for (let i = 1; i < args.length; i++) {
      const flag = args[i]
      if (!['--repo', '--backend', '--model', '--json'].includes(flag) || seen.has(flag)) throw Error('usage')
      seen.add(flag)
      if (flag === '--json') options.json = true
      else {
        const value = args[++i]
        if (!value || value.startsWith('--')) throw Error('usage')
        options[flag.slice(2)] = value
      }
    }
    if (!options.repo || (options.backend && !['claude', 'codex'].includes(options.backend)) ||
      (options.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(options.model))) throw Error('usage')
    const report = await inspectDoctor({ repo: resolve(options.repo), backend: options.backend,
      overrides: options.model === undefined ? {} : { model: options.model } })
    console.log(options.json ? JSON.stringify(report) : [`Doctor: ${report.status} (${report.backend})`,
      ...report.checks.map(c => `${c.status}: ${c.id}: ${c.message}`),
      ...Object.entries(report.settings.values).map(([key, value]) => `${key}: ${value ?? 'unknown'} (${report.settings.sources[key]})`)].join('\n'))
    return report.status === 'ready' ? 0 : 2
  } catch {
    console.error('Usage: pandastack doctor --repo PATH [--backend claude|codex] [--model MODEL] [--json]')
    return 1
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
