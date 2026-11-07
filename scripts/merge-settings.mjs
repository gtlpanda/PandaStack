#!/usr/bin/env node
// merge-settings.mjs - merges this repo's settings.json into a person's own
// ~/.claude/settings.json, for install.sh. Their file stays theirs:
//   - hooks: every hook of ours whose command is not already there is added,
//     in a group with our matcher;
//   - permissions: never touched (only a person loosens or tightens them);
//   - any other key: theirs wins; a key they lack is filled from ours, and an
//     object is filled key by key the same way.
// Merging twice gives the same file.
//
//   node merge-settings.mjs merge <ours.json> <theirs.json>
//     prints the merged JSON on stdout, one "added: <what>" line per change on stderr
//   node merge-settings.mjs unmerge <ours.json> <theirs.json>
//     prints theirs without our hooks (by command) on stdout
// Exit 1 when a file is not a JSON object.
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const clone = v => JSON.parse(JSON.stringify(v))

function fill(target, source, path, added) {
  for (const [k, v] of Object.entries(source)) {
    if (!(k in target)) { target[k] = clone(v); added.push(`${path}${k}`); continue }
    if (isObject(v) && isObject(target[k])) fill(target[k], v, `${path}${k}.`, added)
  }
}

const commandsIn = groups => new Set((Array.isArray(groups) ? groups : []).flatMap(g => (isObject(g) && Array.isArray(g.hooks) ? g.hooks : []).map(h => h && h.command)))

export function mergeSettings(ours, theirs) {
  if (!isObject(ours) || !isObject(theirs)) throw new Error('settings must be JSON objects')
  const out = clone(theirs)
  const added = []
  for (const [k, v] of Object.entries(ours)) {
    if (k === 'permissions') continue
    if (k === 'hooks' && isObject(v)) {
      if (!isObject(out.hooks)) out.hooks = {}
      for (const [event, groups] of Object.entries(v)) {
        if (!Array.isArray(out.hooks[event])) out.hooks[event] = []
        const have = commandsIn(out.hooks[event])
        for (const g of groups) {
          const fresh = (g.hooks || []).filter(h => !have.has(h.command))
          if (!fresh.length) continue
          out.hooks[event].push({ ...clone(g), hooks: clone(fresh) })
          for (const h of fresh) added.push(`hooks.${event}: ${h.command}`)
        }
      }
      continue
    }
    if (!(k in out)) { out[k] = clone(v); added.push(k); continue }
    if (isObject(v) && isObject(out[k])) fill(out[k], v, `${k}.`, added)
  }
  return { settings: out, added }
}

export function unmergeSettings(ours, theirs) {
  if (!isObject(ours) || !isObject(theirs)) throw new Error('settings must be JSON objects')
  const out = clone(theirs)
  if (!isObject(ours.hooks) || !isObject(out.hooks)) return out
  for (const [event, groups] of Object.entries(ours.hooks)) {
    if (!Array.isArray(out.hooks[event])) continue
    const mine = commandsIn(groups)
    out.hooks[event] = out.hooks[event]
      .map(g => (isObject(g) && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter(h => !mine.has(h && h.command)) } : g))
      .filter(g => !(isObject(g) && Array.isArray(g.hooks) && g.hooks.length === 0))
    if (!out.hooks[event].length) delete out.hooks[event]
  }
  return out
}

function readObject(path) {
  let v
  try { v = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { throw new Error(`${path} is not valid JSON: ${e.message}`) }
  if (!isObject(v)) throw new Error(`${path} is not a JSON object`)
  return v
}

function main([cmd, oursFile, theirsFile]) {
  if (!['merge', 'unmerge'].includes(cmd) || !oursFile || !theirsFile) {
    console.error('usage: merge-settings.mjs merge|unmerge <ours.json> <theirs.json>')
    return 2
  }
  try {
    const ours = readObject(oursFile)
    const theirs = readObject(theirsFile)
    if (cmd === 'merge') {
      const { settings, added } = mergeSettings(ours, theirs)
      for (const a of added) console.error(`added: ${a}`)
      process.stdout.write(JSON.stringify(settings, null, 2) + '\n')
    } else {
      process.stdout.write(JSON.stringify(unmergeSettings(ours, theirs), null, 2) + '\n')
    }
    return 0
  } catch (e) {
    console.error(`merge-settings: ${e.message}`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
