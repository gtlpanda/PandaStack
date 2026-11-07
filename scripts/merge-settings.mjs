#!/usr/bin/env node
// merge-settings.mjs - merges this repo's settings.json into a person's own
// ~/.claude/settings.json, for install.sh. Their file stays theirs:
//   - hooks: every hook of ours not already there (same event, matcher, and
//     command) is added, in a group with our matcher. A hook of ours is never
//     changed once it is in the file: a person may have tuned it;
//   - permissions: never touched (only a person loosens or tightens them);
//   - statusLine: filled only when they have none, like any key, but it runs a
//     script install links (bin/statusline.sh), so it is left out when that
//     script is not installed, and unmerge removes it while it is still ours;
//   - any other key: theirs wins; a key they lack is filled from ours, and an
//     object is filled key by key the same way.
// Merging twice gives the same file.
//
//   node merge-settings.mjs merge [--no-hooks] [--no-statusline] <ours.json> <theirs.json>
//     prints the merged JSON on stdout, one "added: <what>" line per change on
//     stderr; --no-hooks leaves our hooks out and --no-statusline our statusLine
//     (the scripts they run are not installed)
//   node merge-settings.mjs unmerge <ours.json> <theirs.json>
//     prints theirs without our hooks, and without our statusLine if theirs is
//     still exactly ours, on stdout; one "removed: <what>" line each on stderr
// Exit 3 when theirs is valid JSON but not an object; 1 on any other error
// (unreadable, not JSON); 2 on bad usage.
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const clone = v => JSON.parse(JSON.stringify(v))
// Order-insensitive for object keys, so a file rewritten by another tool still compares equal.
const canonical = v => JSON.stringify(v, (_, x) => (isObject(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x))

function fill(target, source, path, added) {
  for (const [k, v] of Object.entries(source)) {
    if (!(k in target)) { target[k] = clone(v); added.push(`${path}${k}`); continue }
    if (isObject(v) && isObject(target[k])) fill(target[k], v, `${path}${k}.`, added)
  }
}

// A hook's identity within one event: its group's matcher and its command.
const hookKey = (g, h) => JSON.stringify([isObject(g) && typeof g.matcher === 'string' ? g.matcher : '', h && h.command])
const keysIn = groups => new Set((Array.isArray(groups) ? groups : []).flatMap(g => (isObject(g) && Array.isArray(g.hooks) ? g.hooks : []).map(h => hookKey(g, h))))

export class NotAnObject extends Error {}

export function mergeSettings(ours, theirs, { hooks = true, statusLine = true } = {}) {
  if (!isObject(theirs)) throw new NotAnObject('your settings.json is valid JSON but not an object')
  if (!isObject(ours)) throw new Error('our settings.json is not an object')
  const out = clone(theirs)
  const added = []
  for (const [k, v] of Object.entries(ours)) {
    if (k === 'permissions') continue
    if (k === 'statusLine' && !statusLine) continue
    if (k === 'hooks') {
      if (!hooks || !isObject(v)) continue
      if (!isObject(out.hooks)) out.hooks = {}
      for (const [event, groups] of Object.entries(v)) {
        if (!Array.isArray(out.hooks[event])) out.hooks[event] = []
        const have = keysIn(out.hooks[event])
        for (const g of groups) {
          const fresh = (g.hooks || []).filter(h => !have.has(hookKey(g, h)))
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
  if (!isObject(theirs)) throw new NotAnObject('your settings.json is valid JSON but not an object')
  const out = clone(theirs)
  const removed = []
  // Our statusLine runs a script uninstall unlinks; theirs (anything else) stays.
  if (isObject(ours) && 'statusLine' in ours && 'statusLine' in out && canonical(out.statusLine) === canonical(ours.statusLine)) {
    delete out.statusLine
    removed.push('statusLine')
  }
  if (!isObject(ours) || !isObject(ours.hooks) || !isObject(out.hooks)) return { settings: out, removed }
  for (const [event, groups] of Object.entries(ours.hooks)) {
    if (!Array.isArray(out.hooks[event])) continue
    const mine = keysIn(groups)
    out.hooks[event] = out.hooks[event]
      .map(g => {
        if (!isObject(g) || !Array.isArray(g.hooks)) return g
        const keep = g.hooks.filter(h => !mine.has(hookKey(g, h)))
        for (const h of g.hooks) if (!keep.includes(h)) removed.push(`hooks.${event}: ${h.command}`)
        return { ...g, hooks: keep }
      })
      .filter(g => !(isObject(g) && Array.isArray(g.hooks) && g.hooks.length === 0))
    if (!out.hooks[event].length) delete out.hooks[event]
  }
  return { settings: out, removed }
}

// Parsed JSON; a leading UTF-8 byte-order mark (Windows editors) is allowed.
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { throw new Error(`${path} is not valid JSON: ${e.message}`) }
}

function main(argv) {
  const noHooks = argv.includes('--no-hooks')
  const noStatusLine = argv.includes('--no-statusline')
  const [cmd, oursFile, theirsFile, extra] = argv.filter(a => a !== '--no-hooks' && a !== '--no-statusline')
  if (!['merge', 'unmerge'].includes(cmd) || !oursFile || !theirsFile || extra !== undefined || ((noHooks || noStatusLine) && cmd !== 'merge')) {
    console.error('usage: merge-settings.mjs merge [--no-hooks] [--no-statusline] <ours.json> <theirs.json> | unmerge <ours.json> <theirs.json>')
    return 2
  }
  try {
    const ours = readJson(oursFile)
    const theirs = readJson(theirsFile)
    if (cmd === 'merge') {
      const { settings, added } = mergeSettings(ours, theirs, { hooks: !noHooks, statusLine: !noStatusLine })
      for (const a of added) console.error(`added: ${a}`)
      process.stdout.write(JSON.stringify(settings, null, 2) + '\n')
    } else {
      const { settings, removed } = unmergeSettings(ours, theirs)
      for (const r of removed) console.error(`removed: ${r}`)
      process.stdout.write(JSON.stringify(settings, null, 2) + '\n')
    }
    return 0
  } catch (e) {
    console.error(`merge-settings: ${e.message}`)
    return e instanceof NotAnObject ? 3 : 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
