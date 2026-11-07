#!/usr/bin/env node
// check-refs.mjs - PandaStack runs standalone: every skill, agent, workflow, or
// command a file in this repo tells Claude to use must ship in this repo (or be
// built into Claude Code). A name that only another tool provides (gstack,
// a plugin, a copy in someone's ~/.claude) works on one machine and silently
// fails everywhere else.
//
// It reads three kinds of reference, in .md, .mjs, and .js files under core/,
// kit/, graphs/, plus the top-level CLAUDE.md, loop.md, and README.md:
//   - agentType: 'name' / subagent_type: "name"   -> an agent
//   - `/name` or `/name args` in backticks          -> a skill, workflow, or command
//   - `name` skill / `name` agent / `name` subagent -> any of them
// Tests (*/tests/) are skipped: their names are fixtures.
//
//   node scripts/check-refs.mjs [repo dir]
// prints one line per unresolved reference (file:line: kind 'name') and exits 1
// if there is any; prints "check-refs: N references, all resolve" and exits 0.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Built into Claude Code, so they exist wherever Claude Code runs.
export const BUILTIN_COMMANDS = new Set(['loop', 'goal', 'config', 'clear', 'compact', 'fast', 'help', 'init', 'model', 'resume', 'memory', 'agents', 'hooks', 'permissions', 'plugin', 'mcp', 'code-review', 'simplify', 'schedule', 'security-review'])
export const BUILTIN_AGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide'])
// Backticked paths that are URL routes in examples, not commands.
export const ROUTE_EXAMPLES = new Set(['a', 'dashboard', 'settings', 'profile', 'login', 'billing'])

const ROOT_DIRS = ['core', 'kit', 'graphs']
const TOP_FILES = ['CLAUDE.md', 'loop.md', 'README.md']
const SCANNED = /\.(md|mjs|js)$/

// Every reference in one file's text: [{kind: 'agent'|'command'|'any', name, line}].
export function findRefs(text) {
  const refs = []
  const lines = String(text).split('\n')
  lines.forEach((l, i) => {
    const line = i + 1
    for (const m of l.matchAll(/\b(?:agentType|subagent_type)["']?\s*:\s*["']([A-Za-z][\w:-]*)["']/g)) refs.push({ kind: 'agent', name: m[1], line })
    for (const m of l.matchAll(/`\/([a-z][a-z0-9-]*)(?=[` ])/g)) refs.push({ kind: 'command', name: m[1], line })
    for (const m of l.matchAll(/`\/?([a-z][a-z0-9-]*)` (?:skill|agent|subagent)s?\b/g)) refs.push({ kind: 'any', name: m[1], line })
  })
  return refs
}

function listDir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

// The names this repo ships, by kind.
export function inventory(repo) {
  const roots = ['core', 'kit', ...listDir(join(repo, 'graphs')).map(g => `graphs/${g}`)]
  const inv = { skill: new Set(), agent: new Set(), workflow: new Set(), command: new Set() }
  for (const r of roots) {
    for (const s of listDir(join(repo, r, 'skills'))) if (existsSync(join(repo, r, 'skills', s, 'SKILL.md'))) inv.skill.add(s)
    for (const a of listDir(join(repo, r, 'agents'))) if (a.endsWith('.md')) inv.agent.add(basename(a, '.md'))
    for (const w of listDir(join(repo, r, 'workflows'))) if (w.endsWith('.js')) inv.workflow.add(basename(w, '.js'))
    for (const c of listDir(join(repo, r, 'commands'))) if (c.endsWith('.md')) inv.command.add(basename(c, '.md'))
  }
  return inv
}

export function resolves(ref, inv) {
  const { kind, name } = ref
  if (kind === 'agent') return inv.agent.has(name) || BUILTIN_AGENTS.has(name)
  const invocable = inv.skill.has(name) || inv.workflow.has(name) || inv.command.has(name) || BUILTIN_COMMANDS.has(name)
  if (kind === 'command') return invocable || ROUTE_EXAMPLES.has(name)
  return invocable || inv.agent.has(name) || BUILTIN_AGENTS.has(name)
}

function scannedFiles(repo) {
  const out = TOP_FILES.map(f => join(repo, f)).filter(existsSync)
  const walk = dir => {
    for (const e of listDir(dir)) {
      const p = join(dir, e)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { if (e !== 'tests' && e !== 'node_modules' && e !== '.git') walk(p) } else if (SCANNED.test(e)) out.push(p)
    }
  }
  for (const d of ROOT_DIRS) walk(join(repo, d))
  return out
}

// {total, unresolved: [{file, line, kind, name}]}
export function checkRefs(repo) {
  const inv = inventory(repo)
  let total = 0
  const unresolved = []
  for (const f of scannedFiles(repo)) {
    let text
    try { text = readFileSync(f, 'utf8') } catch (e) { throw new Error(`cannot read ${f}: ${e.message}`) }
    for (const ref of findRefs(text)) {
      total++
      if (!resolves(ref, inv)) unresolved.push({ file: relative(repo, f), ...ref })
    }
  }
  return { total, unresolved }
}

function main(argv) {
  const repo = argv[0] || join(fileURLToPath(new URL('.', import.meta.url)), '..')
  let r
  try { r = checkRefs(repo) } catch (e) { console.error(`check-refs: ${e.message}`); return 1 }
  if (!r.unresolved.length) { console.log(`check-refs: ${r.total} references, all resolve`); return 0 }
  for (const u of r.unresolved) console.log(`${u.file}:${u.line}: ${u.kind} '${u.name}' is not in this repo or built into Claude Code`)
  console.log(`check-refs: ${r.unresolved.length} of ${r.total} references do not resolve`)
  return 1
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
