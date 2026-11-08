#!/usr/bin/env node
// audit-facts.mjs - the check between the recon researchers and the synthesizer: every reference a researcher cites must hold in the audited
// snapshot (tree/), and what a researcher may contribute is bounded. The workflow cannot read tree/, so audit-stage.mjs `apply` calls this
// before the facts are saved; an item whose reference does not hold is dropped and logged, never repaired.
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { refuse } from './audit-run.mjs'
import { isSafeRelativePath } from './upstream.mjs'

export const RECON_IDS = ['1a', '1b', '1c', '1d']   // upstream's four reconnaissance agents (RECONNAISSANCE.md, Phase 1)
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const show = v => String(JSON.stringify(v)).slice(0, 80)
// What one researcher may contribute. A hostile target can make an agent write without end; a stage input is a script, and a script
// has a size (above). Over a limit, the item is dropped and logged, never truncated.
// agentBytes is the one that bounds the script, and it counts what the script holds: facts reach the run script through run-script.mjs,
// which writes JSON.stringify(JSON.stringify(input)), so a control character costs seven bytes and a quote four. 4 researchers x 75,000
// + the synthesizer's 67,000-byte base stays under MAX_SCRIPT_BYTES whatever the text (tested with quotes, backslashes, control
// characters, lone surrogates and multi-byte text, counted in UTF-8 bytes; measured worst: 337,644 bytes for text of plain letters, 332,892 for quotes, 324,188 for control characters).
export const FACT_LIMITS = { items: 200, itemChars: 2000, refs: 50, refChars: 300, limits: 50, limitChars: 2000, agentBytes: 75_000 }
// UTF-8 bytes, as run-script.mjs writes the script: .length would count a CJK character once though it takes three bytes.
const encodedSize = v => Buffer.byteLength(JSON.stringify(JSON.stringify(v)), 'utf8')
const MAX_LINE_COUNT_BYTES = 16 * 1024 * 1024

// ---------- the facts: every reference must hold ----------
// path:line or path:first-last. The path may not contain ':' (upstream's own rule for a repository-relative path), so the first colon ends it.
const REF = /^([^:]+):([1-9][0-9]{0,14})(?:-([1-9][0-9]{0,14}))?$/

// The line count of a regular file in tree/, or why it has none. A line is a run of bytes ending in \n, or the unterminated last one.
function lineCount(tree, rel, cache) {
  if (cache.has(rel)) return cache.get(rel)
  let out
  try {
    const path = join(tree, rel)
    const st = lstatSync(path)
    if (!st.isFile()) out = { error: st.isDirectory() ? 'is a directory, not a file' : 'is not a regular file' }
    else if (st.size > MAX_LINE_COUNT_BYTES) out = { error: `is over ${MAX_LINE_COUNT_BYTES} bytes: its lines are not counted` }
    else {
      const bytes = readFileSync(path)
      let lines = 0
      for (let at = bytes.indexOf(10); at >= 0; at = bytes.indexOf(10, at + 1)) lines += 1
      out = { lines: lines + (bytes.length > 0 && bytes[bytes.length - 1] !== 10 ? 1 : 0) }
    }
  } catch (e) { out = { error: e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'is not in tree/ (the audited snapshot)' : `cannot be read (${e.code || e.message})` } }
  cache.set(rel, out)
  return out
}

// Why a reference does not hold, or null when it does: a string, in the grammar, a safe path of a regular file in tree/, and a line (or
// a range, both ends) the file has.
export function refProblem(ref, tree, cache = new Map()) {
  if (typeof ref !== 'string') return `a reference must be a string, not ${show(ref)}`
  if (ref.length > FACT_LIMITS.refChars) return `a reference is longer than ${FACT_LIMITS.refChars} characters (${ref.length})`   // before anything reads it
  const m = REF.exec(ref)
  if (!m) return `${show(ref)} is not path:line or path:first-last`
  const [, path, a, b] = m
  const first = Number(a), last = b === undefined ? first : Number(b)
  if (!isSafeRelativePath(path)) return `${show(path)} is not a safe repository-relative path`
  if (last < first) return `${show(ref)} is a range that runs backwards`
  const c = lineCount(tree, path, cache)
  if (c.error) return `${show(path)} ${c.error}`
  if (last > c.lines) return `${show(path)} has ${c.lines} line(s); ${show(ref)} reaches line ${last}`
  return null
}

// The facts of every agent, minus what does not hold: { facts, dropped }. An item stays only with text and at least one reference, all of which
// hold (an item with a reference nobody read is a guess); a limit stays when it is text. Each drop is logged with the agent, the reason and the
// start of the text. `facts` is the workflow's result as an untrusted value: a wrong shape is a refusal, not a drop.
export function checkFacts(tree, facts) {
  if (!Array.isArray(facts) || facts.length !== RECON_IDS.length || !facts.every(isObj) || RECON_IDS.some((id, i) => facts[i].agent !== id)) refuse(`results.facts must be one entry per researcher, in order (${RECON_IDS.join(', ')})`)
  const cache = new Map(), dropped = []
  const drop = (agent, kind, reason, text) => dropped.push({ agent, kind, reason, text: (typeof text === 'string' ? text : JSON.stringify(text) ?? '').slice(0, 200) })
  const kept = facts.map(f => {
    if (!Array.isArray(f.items) || !Array.isArray(f.limits)) refuse(`results.facts[${f.agent}] needs items and limits arrays`)
    const items = [], limits = []
    let used = 0   // encoded bytes this researcher has contributed so far, items and limits together
    const over = bytes => used + bytes > FACT_LIMITS.agentBytes
    f.items.forEach(item => {
      if (!isObj(item) || typeof item.text !== 'string' || !Array.isArray(item.refs)) return drop(f.agent, 'item', 'is not {text, refs: [string]}', item)
      if (!isText(item.text)) return drop(f.agent, 'item', 'has no text', item.text)
      if (items.length >= FACT_LIMITS.items) return drop(f.agent, 'item', `is over the ${FACT_LIMITS.items}-item limit`, item.text)
      if (item.text.length > FACT_LIMITS.itemChars) return drop(f.agent, 'item', `is over ${FACT_LIMITS.itemChars} characters`, item.text)
      if (item.refs.length === 0) return drop(f.agent, 'item', 'has no file:line reference: it is not a source fact', item.text)
      if (item.refs.length > FACT_LIMITS.refs) return drop(f.agent, 'item', `has more than ${FACT_LIMITS.refs} references`, item.text)
      const bad = item.refs.map(r => refProblem(r, tree, cache)).find(Boolean)
      if (bad) return drop(f.agent, 'item', `has a reference that does not hold: ${bad}`, item.text)
      const bytes = encodedSize(item)
      if (over(bytes)) return drop(f.agent, 'item', `is past this researcher's ${FACT_LIMITS.agentBytes}-byte limit`, item.text)
      used += bytes
      items.push({ text: item.text, refs: item.refs })
    })
    for (const l of f.limits) {
      if (!isText(l) || l.length > FACT_LIMITS.limitChars || limits.length >= FACT_LIMITS.limits) drop(f.agent, 'limit', `is not text of 1 to ${FACT_LIMITS.limitChars} characters, or is over the ${FACT_LIMITS.limits}-limit cap`, l)
      else if (over(encodedSize(l))) drop(f.agent, 'limit', `is past this researcher's ${FACT_LIMITS.agentBytes}-byte limit`, l)
      else { used += encodedSize(l); limits.push(l) }
    }
    return { agent: f.agent, items, limits }
  })
  return { facts: kept, dropped }
}
