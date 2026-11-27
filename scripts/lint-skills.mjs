#!/usr/bin/env node
// lint-skills.mjs - pass/fail checks on every SKILL.md PandaStack ships, with a ratchet baseline.
//
// Which skills: every offering in spec/offering-capabilities.json whose source directory has a
// SKILL.md. The catalog is the list of what install.sh ships, so vendored trees (another project's
// files, copied byte for byte) and test fixtures are never linted.
//
// Rules (stable ids):
//   FRONTMATTER     the file opens with --- frontmatter holding `name` and `description`, every
//                   top-level line is `key: value`, and `name` equals the skill's directory name.
//   DESCRIPTION     the description is at most 1024 characters and says when to use the skill
//                   (TRIGGER below: "Use when ...", "Use only when ...", "when the user says ...").
//   BODY_LENGTH     the body (after the frontmatter) is at most 500 lines.
//   NUMBERED_STEPS  the procedure has numbered steps: items or headings numbered 1 and 2.
//   STEP_COMMAND    at least one concrete command: a shell code block, or an inline `command`.
//   ERROR_RECOVERY  a section headed for errors/failures/recovery/troubleshooting that maps each
//                   failure to a fix (a table, or `failure -> fix` list items), and no fix is only
//                   "try again", "retry" or "rerun".
// The last three are procedure rules. Reference contracts (catalog kind shared-reference-contract:
// a format or a set of rules other skills read, not a procedure) are exempt from them.
//
// The baseline (scripts/skill-lint-baseline.json) lists the violations accepted today, per skill.
// The run fails on a violation the baseline does not list (NEW), and on a listed one that is gone
// (STALE), so the baseline only ever shrinks. --update-baseline removes stale entries; it never
// adds one, so accepting a new violation is a deliberate hand edit.
//
//   node scripts/lint-skills.mjs [--root DIR] [--baseline FILE] [--update-baseline]
// Exit 0: no new or stale violation. 1: new or stale violations. 2: bad usage, or an unreadable
// catalog, skill or baseline.
import { existsSync, readFileSync, realpathSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RULES = ['FRONTMATTER', 'DESCRIPTION', 'BODY_LENGTH', 'NUMBERED_STEPS', 'STEP_COMMAND', 'ERROR_RECOVERY']
export const EXEMPT_KINDS = new Set(['shared-reference-contract'])
export const MAX_DESCRIPTION = 1024
export const MAX_BODY_LINES = 500
const DEFAULT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BASELINE_REL = 'scripts/skill-lint-baseline.json'

// "says when to use it": an explicit trigger clause, not just a summary of what the skill does.
export const TRIGGER = /\b(use (it |this |this skill )?(only )?(when|whenever|if|before|after)\b|invoke (it )?when\b|when the user (says|asks|wants|types|mentions)\b|trigger(s|ed)? (on|when)\b)/i
// A heading that opens an error-recovery section. The whole heading (after any numbering) must be
// the phrase, so a title such as "Error Audit - Find Silent Failures" or "Error Handling Audit
// Report" does not count.
export const RECOVERY_HEADING = /^(errors?|error (recovery|handling)|failures?|failure (modes|recovery)|troubleshooting|recovery|common (errors|failures|problems)|when (something|it|a step|things) (fails|goes wrong)|if (something|it|a step) fails)( and (fixes|recovery|what to do))?[.:!?]?$/i
// A fix that is nothing but "do it again".
export const RETRY_ONLY = /^(just )?(try (it )?again|retry( it)?|re-?run( it)?|run (it )?again|try once more|repeat( it)?)$/i
// Inline `command` shapes: a known tool then whitespace and an argument (so a file name such as
// `go.mod` or `docker-compose.yml` is not one), or a ./script.
const INLINE_COMMAND = /^(\$ )?(node|npm|npx|pnpm|yarn|bun|deno|git|gh|bash|sh|zsh|python3?|pip3?|uv|go|cargo|make|docker|kubectl|terraform|aws|curl|autobuild|codex|claude|rg|grep|sed|jq|ls|cat|cd|mkdir|rm|cp|mv|chmod|ssh|psql|sqlite3)\s+\S|^\.{1,2}\/[\w./-]+/
const SHELL_LANGS = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'fish', 'powershell', 'ps1', 'cmd'])

export class LintInputError extends Error {}

// Splits a SKILL.md into frontmatter fields and body. CRLF line ends are read as LF.
export function parseSkill(text) {
  if (typeof text !== 'string') throw new LintInputError('skill text is not a string')
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0] !== '---') return { frontmatter: null, problems: ['no frontmatter: the file does not open with ---'], body: lines.join('\n') }
  const end = lines.indexOf('---', 1)
  if (end < 0) return { frontmatter: null, problems: ['the frontmatter has no closing ---'], body: '' }
  const fields = {}
  const problems = []
  let last = null
  for (const [i, line] of lines.slice(1, end).entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) {   // a continuation of the field above (block scalar or wrapped value)
      if (last === null) { problems.push(`frontmatter line ${i + 2} is indented with no key above it`); continue }
      fields[last] = `${fields[last]} ${line.trim()}`.trim()
      continue
    }
    const m = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line)
    if (!m) { problems.push(`frontmatter line ${i + 2} is not \`key: value\``); last = null; continue }
    last = m[1]
    let value = (m[2] ?? '').trim()
    if (/^[>|][+-]?$/.test(value)) value = ''
    else if (/^"(.*)"$/.test(value)) value = value.slice(1, -1).replace(/\\"/g, '"')
    else if (/^'(.*)'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'")
    if (Object.hasOwn(fields, last)) problems.push(`frontmatter key \`${last}\` appears twice`)
    fields[last] = value
  }
  return { frontmatter: fields, problems, body: lines.slice(end + 1).join('\n') }
}

// The body's lines with fenced code blocks marked, so headings and lists inside code are skipped.
function scan(body) {
  const out = []
  let fence = null
  for (const line of body.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line)
    if (fence) {
      if (m && m[1][0] === fence.marker[0] && m[1].length >= fence.marker.length && line.trim() === m[1]) { out.push({ line, kind: 'fence-end', fence }); fence = null }
      else { fence.lines.push(line); out.push({ line, kind: 'code', fence }) }
    } else if (m) {
      fence = { marker: m[1], lang: m[2].toLowerCase(), lines: [] }
      out.push({ line, kind: 'fence-start', fence })
    } else out.push({ line, kind: 'text' })
  }
  return out
}

const headingOf = line => { const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line); return m ? { level: m[1].length, text: m[2] } : null }
const stripNumbering = text => text.replace(/^(step\s+)?\d+[.):]?\s*/i, '').replace(/^[*_`]+|[*_`]+$/g, '').trim()

export function hasNumberedSteps(body) {
  const seen = new Set()
  for (const { line, kind } of scan(body)) {
    if (kind !== 'text') continue
    const item = /^\s*(\d+)[.)]\s+\S/.exec(line)
    const head = /^#{1,6}\s+(?:step\s+)?(\d+)(?:[.):]|\s+[-–—]|\s)/i.exec(line)
    const n = item?.[1] ?? head?.[1]
    if (n) seen.add(Number(n))
  }
  return seen.has(1) && seen.has(2)
}

export function hasCommand(body) {
  for (const { line, kind, fence } of scan(body)) {
    if (kind === 'fence-start' || kind === 'fence-end') continue
    if (kind === 'code') {
      if (SHELL_LANGS.has(fence.lang) && fence.lines.some(l => /^\s*(\$ )?[\w./~-]+(\s|$)/.test(l) && !/^\s*#/.test(l))) return true
      continue
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) if (INLINE_COMMAND.test(m[1].trim())) return true
  }
  return false
}

// The fix of each failure -> fix pair in a section: the last cell of a table row, or the text
// after the separator of a list item.
function recoveryPairs(sectionLines) {
  const pairs = []
  const rows = sectionLines.filter(l => /^\s*\|.*\|\s*$/.test(l))
  const isRule = l => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l)
  if (rows.length >= 3 && isRule(rows[1])) {
    for (const row of rows.slice(2)) {
      if (isRule(row)) continue
      const cells = row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      if (cells.length >= 2 && cells[0] && cells.at(-1)) pairs.push(cells.at(-1))
    }
  }
  for (const l of sectionLines) {
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l)
    if (!item) continue
    const m = /^(.+?)\s*(?:->|→|=>|\s[-–—]\s|:\s)\s*(.+)$/.exec(item[1].replace(/\*\*/g, ''))
    if (m && m[1].trim() && m[2].trim()) pairs.push(m[2])
  }
  return pairs
}

const normalizeFix = fix => fix.replace(/[`*_]/g, '').replace(/[.!]+$/, '').trim()

export function errorRecovery(body) {
  const lines = scan(body)
  let found = null
  for (const [i, { line, kind }] of lines.entries()) {
    if (kind !== 'text') continue
    const h = headingOf(line)
    if (!h || !RECOVERY_HEADING.test(stripNumbering(h.text))) continue
    const section = []
    for (const next of lines.slice(i + 1)) {
      const nh = next.kind === 'text' ? headingOf(next.line) : null
      if (nh && nh.level <= h.level) break
      if (next.kind === 'text') section.push(next.line)
    }
    const fixes = recoveryPairs(section)
    if (!fixes.length) { found ??= `the "${h.text}" section maps no failure to a fix (use a table or \`failure -> fix\` items)`; continue }
    const retry = fixes.find(f => RETRY_ONLY.test(normalizeFix(f)))
    if (retry) return { ok: false, reason: `the "${h.text}" section has a fix that is only "${normalizeFix(retry)}"` }
    return { ok: true }
  }
  return { ok: false, reason: found ?? 'no error-recovery section (a heading such as "Error recovery" or "Troubleshooting")' }
}

// Every rule's verdict for one skill: [{ rule, message }] for each violation.
export function lintSkill({ text, dir, kind }) {
  const violations = []
  const add = (rule, message) => violations.push({ rule, message })
  const { frontmatter, problems, body } = parseSkill(text)
  for (const p of problems) add('FRONTMATTER', p)
  if (frontmatter) {
    if (!frontmatter.name) add('FRONTMATTER', 'no `name`')
    else if (frontmatter.name !== dir) add('FRONTMATTER', `name \`${frontmatter.name}\` is not the directory name \`${dir}\``)
    if (!Object.hasOwn(frontmatter, 'description')) add('FRONTMATTER', 'no `description`')
    else {
      const d = frontmatter.description
      if (!d) add('DESCRIPTION', 'the description is empty')
      else {
        if (d.length > MAX_DESCRIPTION) add('DESCRIPTION', `the description is ${d.length} characters (max ${MAX_DESCRIPTION})`)
        if (!TRIGGER.test(d)) add('DESCRIPTION', 'the description does not say when to use the skill ("Use when ...")')
      }
    }
  }
  const bodyLines = body.replace(/\n+$/, '').split('\n').length
  if (bodyLines > MAX_BODY_LINES) add('BODY_LENGTH', `the body is ${bodyLines} lines (max ${MAX_BODY_LINES})`)
  if (!EXEMPT_KINDS.has(kind)) {
    if (!hasNumberedSteps(body)) add('NUMBERED_STEPS', 'no numbered steps (items or headings numbered 1 and 2)')
    if (!hasCommand(body)) add('STEP_COMMAND', 'no concrete command (a shell code block or an inline `command`)')
    const er = errorRecovery(body)
    if (!er.ok) add('ERROR_RECOVERY', er.reason)
  }
  return violations
}

// The skills to lint: catalog offerings with a SKILL.md, sorted by id.
export function catalogSkills(root) {
  const file = join(root, 'spec', 'offering-capabilities.json')
  let catalog
  try { catalog = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new LintInputError(`cannot read the catalog ${file}: ${e.message}`) }
  if (!catalog || !Array.isArray(catalog.offerings)) throw new LintInputError(`${file} has no offerings array`)
  const skills = []
  for (const o of catalog.offerings) {
    if (!o || typeof o.id !== 'string' || typeof o.source !== 'string' || typeof o.kind !== 'string') throw new LintInputError(`${file}: an offering lacks a string id, source or kind`)
    const path = join(root, o.source, 'SKILL.md')
    if (existsSync(path)) skills.push({ id: o.id, kind: o.kind, dir: basename(o.source), path })
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id))
}

export function lintRepo(root) {
  return catalogSkills(root).map(s => {
    let text
    try { text = readFileSync(s.path, 'utf8') } catch (e) { throw new LintInputError(`cannot read ${s.path}: ${e.message}`) }
    return { ...s, violations: lintSkill({ text, dir: s.dir, kind: s.kind }) }
  })
}

export function readBaseline(file) {
  if (!existsSync(file)) return {}
  let data
  try { data = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new LintInputError(`cannot read the baseline ${file}: ${e.message}`) }
  const v = data?.violations
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new LintInputError(`${file} has no violations object`)
  for (const [id, rules] of Object.entries(v)) {
    if (!Array.isArray(rules) || rules.some(r => !RULES.includes(r))) throw new LintInputError(`${file}: ${id} must list known rule ids (${RULES.join(', ')})`)
  }
  return v
}

// Compares this run's violations (one entry per skill and rule) with the baseline.
export function compare(results, baseline) {
  const current = new Set(results.flatMap(r => [...new Set(r.violations.map(v => `${r.id}\t${v.rule}`))]))
  const listed = new Set(Object.entries(baseline).flatMap(([id, rules]) => rules.map(r => `${id}\t${r}`)))
  const fresh = [...current].filter(k => !listed.has(k)).sort()
  const stale = [...listed].filter(k => !current.has(k)).sort()
  const kept = [...current].filter(k => listed.has(k)).sort()
  return { current, fresh, stale, kept }
}

// The baseline minus its stale entries. Never adds one.
export function shrinkBaseline(baseline, kept) {
  const keep = new Set(kept)
  const out = {}
  for (const id of Object.keys(baseline).sort()) {
    const rules = baseline[id].filter(r => keep.has(`${id}\t${r}`))
    if (rules.length) out[id] = [...new Set(rules)].sort((a, b) => RULES.indexOf(a) - RULES.indexOf(b))
  }
  return out
}

// Writes through a temp file and a rename, so a reader never sees half a baseline. A failure is an
// input error (exit 2), not a lint failure (exit 1), and leaves no temp file behind.
function writeBaseline(file, violations) {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, violations }, null, 2) + '\n')
    renameSync(tmp, file)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* the cleanup failed too; report the write error */ }
    throw new LintInputError(`cannot write the baseline ${file}: ${e.message}`)
  }
}

export function main(argv, log = console.log) {
  let root = DEFAULT_ROOT
  let baselineFile = null
  let update = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root' && argv[i + 1]) root = resolve(argv[++i])
    else if (a === '--baseline' && argv[i + 1]) baselineFile = resolve(argv[++i])
    else if (a === '--update-baseline') update = true
    else { log('usage: lint-skills.mjs [--root DIR] [--baseline FILE] [--update-baseline]'); return 2 }
  }
  baselineFile ??= join(root, BASELINE_REL)
  try {
    const results = lintRepo(root)
    const baseline = readBaseline(baselineFile)
    const { current, fresh, stale, kept } = compare(results, baseline)
    const byKey = new Map(results.flatMap(r => r.violations.map(v => [`${r.id}\t${v.rule}`, `${r.id} ${v.rule}: ${v.message}`])))
    for (const k of fresh) log(`NEW   ${byKey.get(k)}`)
    for (const k of stale) log(`STALE ${k.replace('\t', ' ')}: fixed, but still listed in the baseline (run with --update-baseline)`)
    if (update && stale.length) {
      writeBaseline(baselineFile, shrinkBaseline(baseline, kept))
      log(`lint-skills: removed ${stale.length} fixed violation(s) from ${baselineFile}`)
    }
    if (update && fresh.length) log('lint-skills: --update-baseline never adds a violation; fix it, or add it to the baseline by hand')
    const failed = fresh.length > 0 || (stale.length > 0 && !update)
    log(`LINT-SKILLS: ${results.length} skills, ${current.size} violation(s): ${kept.length} baselined, ${fresh.length} new, ${update ? 0 : stale.length} stale -> ${failed ? 'FAIL' : 'PASS'}`)
    return failed ? 1 : 0
  } catch (e) {
    if (!(e instanceof LintInputError)) throw e
    log(`LINT-SKILLS: ERROR ${e.message}`)
    return 2
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
