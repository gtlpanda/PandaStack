#!/usr/bin/env node
// blocks.mjs - verbatim blocks of the vendored Cloudflare skill. Upstream says a hunter prompt carries
// its blocks "copied verbatim" and never as names alone, so nothing here paraphrases: every block is a
// contiguous slice of a vendored file, and its startLine/endLine say which.
//
// A block reference is "FILE.md#Name": an upstream .md file, then the section name matched exactly
// (case and spaces too) against the file text. For ATTACK-CLASSES.md that is the bold class name; in any
// file it is a heading's text with a trailing parenthetical dropped ("Core discipline (include in ...)"
// is "Core discipline"). A block runs from its heading line to the line before the next heading that
// closes it, minus trailing blank lines. Headings inside code fences are text, not headings.
//
//   node blocks.mjs ref <FILE.md#Name>     print one block exactly
//   node blocks.mjs list                   every ordinary block and every companion's blocks
//   node blocks.mjs guidance <question>    guidance mode: excerpts only, writes nothing, runs nothing
//   node blocks.mjs size                   bytes of the upstream text a hunter prompt carries
// Prints "blocks: FAIL <why>" on stderr and exits 1 for a bad ref or a drifted vendor tree; exits 2 on usage.
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { VENDOR_SKILL_DIR } from './upstream.mjs'

export class BlockError extends Error {
  constructor(message) { super(message); this.name = 'BlockError' }
}
const fail = message => { throw new BlockError(message) }

const FENCE_OPEN = /^```/
const FENCE_CLOSE = /^```\s*$/
const HEADING = /^(#{1,6}) (.+?)\s*$/
// ATTACK-CLASSES.md names its ordinary classes in bold with this suffix. The blockquote lines above them
// and the "**Important**:" paragraph at the end of Obvious things have no such suffix, so they are not classes.
const BOLD_CLASS = /^\*\*(.+?)\*\* \(subagent_type: `[a-z]+`\)$/
const BOLD_LEVEL = 7 // below every # heading, so a bold class is closed by the next bold class or any heading
const REF = /^([A-Z][A-Z0-9-]*\.md)#(\S|\S.*\S)$/ // `.` never matches a newline: one line, no edge whitespace
const nameOf = text => text.replace(/\s+\([^)]*\)$/, '')

export function parseRef(ref) {
  if (typeof ref !== 'string') fail(`block reference must be a string like "FILE.md#Name", got ${ref === null ? 'null' : typeof ref}`)
  const m = REF.exec(ref)
  if (!m) fail(`malformed block reference ${JSON.stringify(ref)}: expected FILE.md#Name (an upstream .md file name, "#", then the section name with no whitespace around it)`)
  return { file: m[1], name: m[2] }
}

function readLines(file, dir) {
  let text
  try { text = readFileSync(join(dir, file), 'utf8') } catch {
    let have = []
    try { have = readdirSync(dir).filter(f => /^[A-Z][A-Z0-9-]*\.md$/.test(f)).sort() } catch { /* the directory itself is unreadable */ }
    fail(`unknown block file ${file}: ${dir} has ${have.join(', ') || 'no upstream .md files'}`)
  }
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

// Every section of one file: [{ref, file, name, level, startLine, endLine, text}], lines counted from 1.
export function sections(file, dir = VENDOR_SKILL_DIR) {
  const lines = readLines(file, dir)
  const heads = []
  let fenced = false
  lines.forEach((l, i) => {
    if (fenced) { fenced = !FENCE_CLOSE.test(l); return }
    if (FENCE_OPEN.test(l)) { fenced = true; return }
    const h = HEADING.exec(l)
    const b = BOLD_CLASS.exec(l)
    if (h) heads.push({ line: i + 1, level: h[1].length, name: nameOf(h[2]) })
    else if (b) heads.push({ line: i + 1, level: BOLD_LEVEL, name: b[1] })
  })
  if (fenced) fail(`${file}: a code fence is never closed`)
  return heads.map((h, i) => {
    const next = heads.slice(i + 1).find(n => n.level <= h.level || n.level === BOLD_LEVEL)
    let end = next ? next.line - 1 : lines.length
    while (end > h.line && lines[end - 1].trim() === '') end -= 1
    return { ref: `${file}#${h.name}`, file, name: h.name, level: h.level, startLine: h.line, endLine: end, text: lines.slice(h.line - 1, end).join('\n') }
  })
}

export function resolve(ref, dir = VENDOR_SKILL_DIR) {
  const { file, name } = parseRef(ref)
  const all = sections(file, dir)
  const hits = all.filter(s => s.name === name)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) fail(`ambiguous block reference ${ref}: ${hits.length} sections of ${file} have that name (lines ${hits.map(h => h.startLine).join(', ')})`)
  fail(`unknown block ${ref}: ${file} has no section named exactly that. Names are case-sensitive and drop a trailing parenthetical. It has: ${all.map(s => s.name).join(' | ')}`)
}

export const resolveAll = (refs, dir = VENDOR_SKILL_DIR) => refs.map(r => resolve(r, dir))

// The text inside one code fence of a section (the fence lines themselves are not part of it).
export function fence(ref, index, dir = VENDOR_SKILL_DIR) {
  const s = resolve(ref, dir)
  const lines = s.text.split('\n')
  const spans = []
  let open = -1
  lines.forEach((l, i) => {
    if (open < 0) { if (FENCE_OPEN.test(l)) open = i } else if (FENCE_CLOSE.test(l)) { spans.push([open, i]); open = -1 }
  })
  if (!spans[index]) fail(`${ref} has no code fence number ${index} (it has ${spans.length})`)
  const [a, b] = spans[index]
  return { ref, fence: index, startLine: s.startLine + a + 1, endLine: s.startLine + b - 1, text: lines.slice(a + 1, b).join('\n') }
}

// ---------- the registry: derived from the vendored headings, never typed in ----------
const FIXED = ['Core discipline', 'Universal moves', 'Validation rules']
const WHEN = 'When to use this file'

export function ordinary(dir = VENDOR_SKILL_DIR) {
  const refs = sections('ATTACK-CLASSES.md', dir).filter(s => s.level === BOLD_LEVEL).map(s => s.ref)
  if (!refs.length) fail('ATTACK-CLASSES.md has no ordinary attack-class blocks (a bold **Name** (subagent_type: ...) line)')
  if (new Set(refs).size !== refs.length) fail('ATTACK-CLASSES.md names two ordinary attack classes alike')
  return refs
}

// The companions are the files ATTACK-CLASSES.md links to. One that has lost a fixed section, or gained a
// section this code does not know, fails here by name: a drifted heading is never skipped silently.
export function companion(file, dir = VENDOR_SKILL_DIR) {
  const all = sections(file, dir)
  const only = (name, level) => {
    const hits = all.filter(s => s.name === name && (!level || s.level === level))
    if (hits.length !== 1) fail(`${file}: expected exactly one section "${name}"${level ? ` (a ${'#'.repeat(level)} heading)` : ''}, found ${hits.length}. Sections: ${all.map(s => s.name).join(' | ')}`)
    return hits[0].ref
  }
  const classes = all.filter(s => s.level === 2 && !FIXED.includes(s.name))
  const odd = classes.find(s => !/ classes$/.test(s.name))
  if (odd) fail(`${file}: unrecognized section "${odd.name}" at line ${odd.startLine}: neither a fixed section (${FIXED.join(', ')}) nor an attack-class section (a name ending "classes")`)
  if (!classes.length || new Set(classes.map(s => s.name)).size !== classes.length) fail(`${file}: needs one or more attack-class sections with distinct names`)
  const [core, universal, validation] = FIXED.map(name => only(name, 2))
  const refs = classes.map(s => s.ref)
  // blocks: what a ledger unit may select, in file order. whenToUse is how recon decides, not a block to select.
  return { file, whenToUse: only(WHEN), core, classes: refs, universal, validation, blocks: [core, ...refs, universal, validation] }
}

export function companions(dir = VENDOR_SKILL_DIR) {
  const text = readLines('ATTACK-CLASSES.md', dir).join('\n')
  const files = [...new Set([...text.matchAll(/\]\(([A-Z][A-Z0-9-]*\.md)\)/g)].map(m => m[1]))].filter(f => f !== 'ATTACK-CLASSES.md').sort()
  if (!files.length) fail('ATTACK-CLASSES.md links to no companion file')
  return files.map(f => companion(f, dir))
}

// ---------- the text later prompts carry, each found by its heading ----------
const RECON = 'RECONNAISSANCE.md#Phase 1: Map the source and plan coverage'
const VERIFIER = 'VALIDATION-AND-REPORTING.md#Candidate-verifier prompt'
const FENCED = {
  recon1a: [RECON, 0], recon1b: [RECON, 1], recon1c: [RECON, 2], recon1d: [RECON, 3],
  hunterMethod: ['HUNTING.md#Core hunting method — include in every hunter prompt', 0],
  promotion: ['HUNTING.md#Promotion procedure — copy this promotion procedure verbatim into every hunter prompt', 0],
  validationRules: ['HUNTING.md#Core validation rules — include in every hunter prompt', 0],
  criticResult: ['HUNTING.md#Coverage-critic waves', 0],
  verifierPrompt: [VERIFIER, 0], verifierPromotion: [VERIFIER, 1],
}

// One branch of report-schema.json, found by its verdict: whole lines from the branch's opening brace line
// to its closing brace line, indentation kept, without the comma that separates it from the next branch
// (so it parses on its own). Proven equal to the parsed oneOf entry before it is returned.
export function schemaBranch(verdict, dir = VENDOR_SKILL_DIR) {
  let text
  let branches
  try { text = readFileSync(join(dir, 'report-schema.json'), 'utf8'); branches = JSON.parse(text).items.oneOf } catch (e) { fail(`report-schema.json: items.oneOf cannot be read (${e.message})`) }
  const i = branches.findIndex(b => b && b.properties && b.properties.verdict && b.properties.verdict.const === verdict)
  if (i < 0) fail(`report-schema.json has no branch for verdict ${JSON.stringify(verdict)}`)
  const lines = text.split('\n')
  const first = lines.indexOf('    "oneOf": [')
  const starts = []
  const ends = []
  for (let n = first + 1; first >= 0 && n < lines.length && lines[n] !== '    ]'; n++) {
    if (lines[n] === '      {') starts.push(n)
    else if (/^      \},?$/.test(lines[n])) ends.push(n)
  }
  if (starts.length !== branches.length || ends.length !== branches.length) fail('report-schema.json: the oneOf layout changed (branches no longer start and end on their own 6-space lines)')
  const body = lines.slice(starts[i], ends[i] + 1).join('\n').replace(/,$/, '')
  if (!isDeepStrictEqual(JSON.parse(body), branches[i])) fail(`report-schema.json: the lines found for ${verdict} are not that branch`)
  return { ref: `report-schema.json#${verdict}`, startLine: starts[i] + 1, endLine: ends[i] + 1, text: body }
}

// The record contracts of Phase 4: from "Read `report-schema.json` immediately before writing." to the line ending "Overall severity cannot exceed demonstrated impact."
// What a record of each verdict may and must not carry, and the shape of a trace (it begins with an entrypoint, ends with a sink, and has a propagation only between). A
// verifier is given these because the parent holds its record to them: the first live validate pass (retro entry 40) had a real verifier write two sinks in one trace,
// twice, which the vendored validator refuses and the prompt had never said. Whole lines of the section found by their two anchors, so a drifted anchor fails by name.
const CONTRACT = ['VALIDATION-AND-REPORTING.md#Phase 4: Write and validate `findings.json`', 'Read `report-schema.json` immediately before writing.', 'Overall severity cannot exceed demonstrated impact.']
function span([ref, from, to], dir) {
  const s = resolve(ref, dir)
  const lines = s.text.split('\n')
  const a = lines.findIndex(l => l.startsWith(from))
  const b = lines.findIndex(l => l.endsWith(to))
  if (a < 0 || b < a) fail(`${ref}: the span from ${JSON.stringify(from)} to a line ending ${JSON.stringify(to)} is not there`)
  return { ref, startLine: s.startLine + a, endLine: s.startLine + b, text: lines.slice(a, b + 1).join('\n') }
}

// Every shared part by key, as blocks with line numbers. hunterResult is the whole "Structured hunter
// result" section, not only its JSON: the rules after the JSON are part of the contract.
export function parts(dir = VENDOR_SKILL_DIR) {
  const out = {}
  for (const [key, [ref, index]] of Object.entries(FENCED)) out[key] = fence(ref, index, dir)
  out.hunterResult = resolve('HUNTING.md#Structured hunter result', dir)
  out.recordContract = span(CONTRACT, dir)
  for (const v of ['confirmed', 'needs_validation', 'rejected']) out[`schema_${v}`] = schemaBranch(v, dir)
  return out
}

// ---------- sizes ----------
const bytes = text => Buffer.byteLength(text)
const sum = blocks => blocks.reduce((n, b) => n + bytes(b.text), 0)

// Upstream text only. A hunter prompt also carries architecture.md (about 1,000 words at most), the
// assignment block map, exclusions and PandaStack's own wording. "injected" is the size of a stage-input
// line once run-script.mjs has written it into a script (it double-encodes the JSON).
export function payloadSizes(dir = VENDOR_SKILL_DIR) {
  const p = parts(dir)
  const common = [p.promotion, p.hunterMethod, p.validationRules, p.hunterResult, p.schema_confirmed, p.schema_needs_validation]
  const classes = resolveAll(ordinary(dir), dir)
  const files = companions(dir)
  const blocksOf = files.map(c => resolveAll(c.blocks, dir))
  const comps = files.map((c, i) => ({ file: c.file, bytes: sum(blocksOf[i]) }))
  const largestClass = classes.reduce((a, b) => (bytes(b.text) > bytes(a.text) ? b : a))
  const largestComp = comps.reduce((a, b) => (b.bytes > a.bytes ? b : a))
  const everything = { parts: common.map(b => b.text), blocks: [...classes, ...blocksOf.flat()].map(b => b.text) }
  return {
    common: sum(common), classes: sum(classes), companions: comps, largestClass: largestClass.ref, largestCompanion: largestComp.file,
    typicalHunter: sum(common) + bytes(largestClass.text) + largestComp.bytes,
    worstHunter: sum(common) + sum(classes) + comps.reduce((n, c) => n + c.bytes, 0),
    injectedWorst: bytes(JSON.stringify(JSON.stringify(everything))),
  }
}

// ---------- guidance mode (D12 A): excerpts and a pointer; no run directory, no files, no agents ----------
const STOP = new Set(['what', 'does', 'with', 'from', 'that', 'this', 'have', 'should', 'about', 'which', 'there', 'would', 'could', 'their', 'into', 'when', 'where'])

export function guidance(question, dir = VENDOR_SKILL_DIR, limit = 3) {
  const terms = [...new Set(String(question).toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) || [])].filter(t => !STOP.has(t))
  const cands = [...ordinary(dir), ...companions(dir).flatMap(c => [c.whenToUse, ...c.classes])].map(r => resolve(r, dir))
  const hits = cands
    .map(b => ({ b, score: terms.filter(t => new RegExp(`\\b${t}`).test(b.text.toLowerCase())).length }))
    .filter(h => h.score > 0)
    .sort((x, y) => y.score - x.score || (x.b.ref < y.b.ref ? -1 : 1))
    .slice(0, limit)
  const head = [
    'Guidance mode: this writes no files, starts no audit and runs no agent. The excerpts below are a keyword match against the vendored Cloudflare skill, not a review of any code.',
    'For an ordinary security question, use the `security` skill. A full audit is a separate, explicit request (/security-audit --full).',
  ]
  if (!hits.length) return [...head, '', 'No excerpt matched. `blocks.mjs list` shows every block.'].join('\n')
  return [...head, ...hits.flatMap(h => ['', `--- ${h.b.ref} (lines ${h.b.startLine}-${h.b.endLine}) ---`, h.b.text])].join('\n')
}

// ---------- command line ----------
function main(argv) {
  const [cmd, ...rest] = argv
  try {
    if (cmd === 'ref' && rest.length === 1) { console.log(resolve(rest[0]).text); return 0 }
    if (cmd === 'list' && !rest.length) {
      for (const r of ordinary()) console.log(r)
      for (const c of companions()) console.log([`${c.file}`, ...c.blocks.map(b => `  ${b}`)].join('\n'))
      return 0
    }
    if (cmd === 'guidance' && rest.join(' ').trim()) { console.log(guidance(rest.join(' '))); return 0 }
    if (cmd === 'size' && !rest.length) {
      const s = payloadSizes()
      console.log(`shared parts (method, promotion, validation rules, result contract, 2 schema branches): ${s.common} bytes`)
      console.log(`ordinary blocks, all ${ordinary().length}: ${s.classes} bytes; companions: ${s.companions.map(c => `${c.file} ${c.bytes}`).join(', ')}`)
      console.log(`typical hunter, upstream text (shared + ${s.largestClass} + all of ${s.largestCompanion}): ${s.typicalHunter} bytes`)
      console.log(`worst hunter, upstream text (shared + every ordinary block + every companion block): ${s.worstHunter} bytes`)
      console.log(`worst case written into a script by run-script.mjs: ${s.injectedWorst} bytes`)
      return 0
    }
  } catch (e) {
    if (!(e instanceof BlockError)) throw e
    console.error(`blocks: FAIL ${e.message}`)
    return 1
  }
  console.error('usage: blocks.mjs ref <FILE.md#Name> | list | guidance <question> | size')
  return 2
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
