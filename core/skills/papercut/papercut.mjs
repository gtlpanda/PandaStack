#!/usr/bin/env node
// papercut.mjs - a local log of tool friction that agents file themselves.
//
// When a tool, skill, flag or doc fights an agent (a flag the help lists and the tool
// rejects, a command that exits 0 on an error, a query that returns nothing when it should
// match), the agent files one structured report here. Reports group by a stable signature,
// so the same bug filed by ten sessions reads as one bug with a count of ten.
//
//   node papercut.mjs file --agent claude|codex|other --tool NAME --tried CMD
//                          --expected TEXT --actual TEXT --fix TEXT [--workaround TEXT]
//                          [--repo NAME]
//   node papercut.mjs file --stdin           the same fields as one JSON object on stdin
//   node papercut.mjs list [--limit N] [--json]
//   node papercut.mjs summary [--json]
//
// Store: ${PANDASTACK_PAPERCUT_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/pandastack}/papercuts.jsonl
// (dir 0700, file 0600, one JSON object per line). A symlinked store dir or file is refused.
// Every text field is capped and passed through the blueprint graph's secret redaction,
// plus bearer/authorization headers; no prompt text or file contents are ever recorded,
// and nothing leaves this machine.
//
// Exit codes: 0 ok; 1 store or I/O error; 2 bad usage or invalid fields.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STORE_FILE = 'papercuts.jsonl'
export const AGENTS = Object.freeze(['claude', 'codex', 'other'])
// field -> [required, max characters]
export const FIELDS = Object.freeze({
  tool: [true, 80],
  tried: [true, 600],
  expected: [true, 600],
  actual: [true, 1200],
  fix: [true, 600],
  workaround: [false, 600],
})
const REPO_MAX = 100
const USAGE = 'usage: papercut.mjs file --agent claude|codex|other --tool NAME --tried CMD --expected TEXT --actual TEXT --fix TEXT [--workaround TEXT] [--repo NAME]\n' +
  '       papercut.mjs file --stdin   (the same fields as one JSON object)\n' +
  '       papercut.mjs list [--limit N] [--json]\n' +
  '       papercut.mjs summary [--json]'

export class PapercutError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
const usageError = message => new PapercutError(2, message)
const storeError = message => new PapercutError(1, message)

// ---------------------------------------------------------------- store location

/** The store directory, from the environment. Always absolute. */
export function storeDir(env = process.env) {
  const own = env.PANDASTACK_PAPERCUT_DIR
  if (own !== undefined && own !== '') {
    if (!isAbsolute(own)) throw usageError('PANDASTACK_PAPERCUT_DIR must be an absolute path')
    return own
  }
  const state = env.XDG_STATE_HOME
  if (state !== undefined && state !== '' && isAbsolute(state)) return join(state, 'pandastack')
  if (!env.HOME || !isAbsolute(env.HOME)) throw usageError('cannot place the papercut store: set HOME or PANDASTACK_PAPERCUT_DIR')
  return join(env.HOME, '.local', 'state', 'pandastack')
}

// The store dir must be a real directory this user owns, mode 0700. Created if missing.
function ensureStoreDir(dir) {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch (e) { throw storeError(`cannot create ${dir}: ${e.code || e.message}`) }
  let st
  try { st = lstatSync(dir) } catch (e) { throw storeError(`cannot read ${dir}: ${e.code || e.message}`) }
  if (st.isSymbolicLink()) throw storeError(`refusing a symlinked papercut store dir: ${dir}`)
  if (!st.isDirectory()) throw storeError(`papercut store dir is not a directory: ${dir}`)
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw storeError(`papercut store dir is not yours: ${dir}`)
  if ((st.mode & 0o077) !== 0) {
    try { fchmodDir(dir) } catch (e) { throw storeError(`cannot make ${dir} private: ${e.code || e.message}`) }
  }
}
function fchmodDir(dir) {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fchmodSync(fd, 0o700) } finally { closeSync(fd) }
}

// Opens the store file without following a symlink at its name. 0600, this user's.
function openStore(path, flags) {
  let fd
  try { fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600) } catch (e) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') throw storeError(`refusing a symlinked papercut store: ${path}`)
    if (e.code === 'ENOENT') return null
    throw storeError(`cannot open ${path}: ${e.code || e.message}`)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw storeError(`papercut store is not a regular file: ${path}`)
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw storeError(`papercut store is not yours: ${path}`)
    if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600)
    return fd
  } catch (e) {
    closeSync(fd)
    throw e instanceof PapercutError ? e : storeError(`cannot check ${path}: ${e.code || e.message}`)
  }
}

// ---------------------------------------------------------------- redaction

// A copy of graphs/blueprint/skills/blueprint/blueprint-state.mjs's redaction (its token
// shapes, URL passwords and assigned random values). It is copied, not imported: the frozen
// CP-04a contract keeps blueprint-state on node: built-ins only, and a core skill may not
// depend on a graph (CP-03b). tests/papercut.test.mjs fails if the two copies drift.
// No token-prefix shape matches right after a letter or digit.
const LEFT = '(?<![A-Za-z0-9])'
// [pattern, label], applied in this order. Each label matches no pattern, so a second
// pass changes nothing.
const TOKEN_SHAPES = [
  [/-----BEGIN [^\n]*?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [^\n]*?PRIVATE KEY(?: BLOCK)?-----|$)/g, '<redacted: private key>'],
  [new RegExp(`${LEFT}[sr]k_(?:live|test)_[A-Za-z0-9]{8,}`, 'g'), '<redacted: API key>'],
  [new RegExp(`${LEFT}[sr]k_(?=[A-Za-z0-9_]*[0-9])[A-Za-z0-9_]{16,}`, 'g'), '<redacted: API key>'],
  [new RegExp(`${LEFT}sk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}`, 'g'), '<redacted: API key>'],
  [new RegExp(`${LEFT}gh[pousr]_[A-Za-z0-9]{30,}`, 'g'), '<redacted: GitHub token>'],
  [new RegExp(`${LEFT}github_pat_[A-Za-z0-9_]{22,}`, 'g'), '<redacted: GitHub token>'],
  [new RegExp(`${LEFT}(?:AKIA|ASIA)[0-9A-Z]{16,}`, 'g'), '<redacted: AWS access key>'],
  [new RegExp(`${LEFT}xox[abprs]-[A-Za-z0-9-]{10,}`, 'g'), '<redacted: Slack token>'],
  [new RegExp(`${LEFT}AIza[0-9A-Za-z_-]{35}`, 'g'), '<redacted: Google API key>'],
  // Each part is 10 or more characters, counting its `eyJ`.
  [new RegExp(`${LEFT}eyJ[A-Za-z0-9_-]{7,}\\.eyJ[A-Za-z0-9_-]{7,}(?:\\.[A-Za-z0-9_-]+)?`, 'g'), '<redacted: JSON web token>'],
]
// scheme://user:<password>@ — only the password is replaced.
const URL_PASSWORD = /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/]*:)[^@/\s]{8,}(?=@)/g
const URL_PASSWORD_LABEL = '<redacted: URL password>'
// After `=` or `:`, optional blanks and one optional quote: the whole run, plus up to two
// `=`. Whether it is redacted is decided per match by isRandomSecret.
const ASSIGNED_RUN = /([=:][ \t]*['"]?)([A-Za-z0-9_+/-]{20,})(={0,2})/g
const SECRET_VALUE_LABEL = '<redacted: secret value>'

function isRandomSecret(run, padding) {
  const allHex = /^[0-9A-Fa-f]+$/.test(run)
  if (allHex && (run.length === 40 || run.length === 64)) return false // a git object id or a sha256
  const mixed = /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run)
  if (mixed && run.length + padding.length >= 24) return true
  return allHex && padding === '' && run.length >= 32
}

function redactPass(text) {
  let out = text
  for (const [pattern, label] of TOKEN_SHAPES) out = out.replace(pattern, label)
  out = out.replace(URL_PASSWORD, (_match, prefix) => prefix + URL_PASSWORD_LABEL)
  return out.replace(ASSIGNED_RUN, (match, lead, run, padding) => (isRandomSecret(run, padding) ? lead + SECRET_VALUE_LABEL : match))
}

// A string through every shape, in order, repeated until nothing changes. One pass is
// not enough: a token glued to an earlier one (an AWS key directly followed by an
// `sk_live_` key) is shielded by the left boundary until the first is replaced by its
// label. Every later match uses up characters outside any label, so the loop ends.
// Anything that is not a string comes back as it was.
export function redactSecrets(value) {
  if (typeof value !== 'string') return value
  let text = value
  for (let next = redactPass(text); next !== text; next = redactPass(text)) text = next
  return text
}

// ---------------------------------------------------------------- fields

// Bearer and basic credentials in headers, which the token shapes do not cover. The value
// after the keyword is redacted only when it looks like a credential (looksLikeCredential),
// so prose ("Bearer authentication failed.", "Token expired.") is kept.
const VALUE = '[A-Za-z0-9._~+/=-]{8,}'
const HEADER_SECRETS = [
  new RegExp(`\\b(Bearer|Basic|Token)([ \\t]+)(${VALUE})`, 'g'),
  new RegExp(`\\b(authorization|x-api-key|api-key|private-token)([ \\t]*[:=][ \\t]*["']?(?:(?:Bearer|Basic|Token)[ \\t]+)?)(${VALUE})`, 'gi'),
]
// A credential has a digit, punctuation inside it (not a sentence's final period), or a
// lowercase letter followed by a capital (base64). A plain word of 8+ letters is prose.
export function looksLikeCredential(value) {
  const core = value.replace(/\.+$/, '')
  if (core.length < 8) return false
  return /[0-9]/.test(core) || /[._~+/=-][A-Za-z0-9]/.test(core) || /[a-z][A-Z]/.test(core)
}
/** Redacts secrets from one text field. Anything else comes back as it was. */
export function scrub(text) {
  if (typeof text !== 'string') return text
  let out = text
  for (const pattern of HEADER_SECRETS) {
    out = out.replace(pattern, (match, keyword, gap, value) => {
      if (!looksLikeCredential(value)) return match
      const period = value.match(/\.+$/)?.[0] ?? ''
      return `${keyword}${gap}<redacted: credential>${period}`
    })
  }
  return redactSecrets(out)
}

// Control characters other than newline and tab become a space; CRLF becomes LF.
function clean(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim()
}

/** Validates and scrubs a raw report object; returns the stored fields. */
export function validateFields(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw usageError('the report must be an object of fields')
  const allowed = new Set([...Object.keys(FIELDS), 'agent', 'repo'])
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw usageError(`unknown field: ${key}`)
  if (typeof raw.agent !== 'string' || !AGENTS.includes(raw.agent)) throw usageError(`--agent must be one of ${AGENTS.join(', ')}`)
  const out = { agent: raw.agent }
  for (const [name, [required, max]] of Object.entries(FIELDS)) {
    const value = raw[name]
    if (value === undefined || value === null) {
      if (required) throw usageError(`--${name} is required`)
      out[name] = null
      continue
    }
    if (typeof value !== 'string') throw usageError(`--${name} must be text`)
    const text = clean(value)
    if (!text) {
      if (required) throw usageError(`--${name} is required`)
      out[name] = null
      continue
    }
    if (text.length > max) throw usageError(`--${name} is ${text.length} characters; the limit is ${max}. Shorten it to the essentials`)
    out[name] = scrub(text)
  }
  if (out.tool.includes('\n')) throw usageError('--tool must be one line')
  if (raw.repo !== undefined && raw.repo !== null) {
    if (typeof raw.repo !== 'string') throw usageError('--repo must be text')
    const repo = raw.repo.trim()
    if (!repo || repo.length > REPO_MAX || repo.includes('/') || repo.includes('\\') || repo === '.' || repo === '..' || /[\u0000-\u001f]/.test(repo)) {
      throw usageError('--repo must be a bare directory name, not a path')
    }
    out.repo = repo
  }
  return out
}

// What varies between two reports of the same bug: paths, numbers, hex ids, spacing.
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/<redacted: [^>]*>/g, '<secret>')
    .replace(/(?:~|\.{1,2})?(?:\/[^\s/'"`:]+)+\/?/g, '<path>')
    .replace(/\b0x[0-9a-f]+\b/g, '<hex>')
    // A hex run counts as an id only with a letter in it; an all-digit run of any length is a number.
    .replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/g, '<hex>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The grouping key: the same tool, the same command shape and the same failure. */
export function signature(fields) {
  return createHash('sha256').update([fields.tool.toLowerCase(), normalize(fields.tried), normalize(fields.actual)].join('\n')).digest('hex').slice(0, 16)
}

// The repository the agent is working in: its top-level directory name only.
function repoName(cwd) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8', timeout: 10_000 })
  const top = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : ''
  return printable(basename(top || cwd)).slice(0, REPO_MAX) || null
}

// Text safe to print to a terminal: every control character, escape included, becomes '?'.
// Applied to everything list and summary print, since a store line may have been edited by hand.
export function printable(text) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
}
const firstLine = text => printable(String(text ?? '').split('\n')[0])

// The PandaStack commit this helper came from, or null for a copy outside a checkout.
function pandastackSha() {
  let here
  try { here = dirname(realpathSync(fileURLToPath(import.meta.url))) } catch { return null }
  const r = spawnSync('git', ['-C', here, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'rev-parse', '--short=12', 'HEAD'],
    { encoding: 'utf8', timeout: 10_000 })
  const sha = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : ''
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null
}

// ---------------------------------------------------------------- file / read

/** Appends one report. Returns the stored record. */
export function fileReport(raw, { env = process.env, cwd = process.cwd(), now = new Date() } = {}) {
  const fields = validateFields(raw)
  const record = {
    v: 1,
    at: now.toISOString(),
    pandastack: pandastackSha(),
    agent: fields.agent,
    repo: fields.repo ?? repoName(cwd),
    tool: fields.tool,
    tried: fields.tried,
    expected: fields.expected,
    actual: fields.actual,
    workaround: fields.workaround,
    fix: fields.fix,
    signature: signature(fields),
  }
  const dir = storeDir(env)
  ensureStoreDir(dir)
  const path = join(dir, STORE_FILE)
  // One write of one whole line to an O_APPEND file: concurrent writers never interleave
  // inside a line on a local filesystem, because each write lands at the end in one piece.
  const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8')
  const fd = openStore(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT)
  try {
    const written = writeSync(fd, line, 0, line.length)
    if (written !== line.length) throw storeError(`short write to ${path}: ${written} of ${line.length} bytes`)
  } catch (e) {
    throw e instanceof PapercutError ? e : storeError(`cannot write ${path}: ${e.code || e.message}`)
  } finally {
    closeSync(fd)
  }
  return { record, path }
}

// A stored line is read only when every field list and summary print is text, so a partial
// or foreign line is skipped instead of breaking the whole store.
const RECORD_TEXT = ['at', 'tool', 'signature', 'tried', 'expected', 'actual', 'fix']
function isRecord(r) {
  return r !== null && typeof r === 'object' && !Array.isArray(r) && RECORD_TEXT.every(k => typeof r[k] === 'string')
}

/** Every readable report, oldest first, and how many lines could not be read. */
export function readReports({ env = process.env } = {}) {
  const dir = storeDir(env)
  let st
  try { st = lstatSync(dir) } catch (e) {
    if (e.code === 'ENOENT') return { reports: [], skipped: 0, path: join(dir, STORE_FILE) }
    throw storeError(`cannot read ${dir}: ${e.code || e.message}`)
  }
  if (st.isSymbolicLink()) throw storeError(`refusing a symlinked papercut store dir: ${dir}`)
  const path = join(dir, STORE_FILE)
  const fd = openStore(path, constants.O_RDONLY)
  if (fd === null) return { reports: [], skipped: 0, path }
  let text
  try { text = readFileSync(fd, 'utf8') } catch (e) { throw storeError(`cannot read ${path}: ${e.code || e.message}`) } finally { closeSync(fd) }
  const reports = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (isRecord(r)) reports.push(r)
      else skipped++
    } catch { skipped++ }
  }
  return { reports, skipped, path }
}

/** Groups reports by tool, then by signature; newest group first. */
export function summarize(reports) {
  const groups = new Map()
  for (const r of reports) {
    const key = `${r.tool}\u0000${r.signature}`
    const g = groups.get(key) ?? { tool: r.tool, signature: r.signature, count: 0, first: r.at, last: r.at, agents: new Set(), repos: new Set(), latest: r }
    g.count++
    if (r.at < g.first) g.first = r.at
    if (r.at >= g.last) { g.last = r.at; g.latest = r }
    if (r.agent) g.agents.add(r.agent)
    if (r.repo) g.repos.add(r.repo)
    groups.set(key, g)
  }
  return [...groups.values()]
    .map(g => ({ ...g, agents: [...g.agents].sort(), repos: [...g.repos].sort() }))
    .sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : b.count - a.count))
}

// ---------------------------------------------------------------- CLI

function parseFlags(args, known) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) throw usageError(`unexpected argument: ${arg}`)
    const eq = arg.indexOf('=')
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2)
    if (!known.has(name)) throw usageError(`unknown option: --${name}`)
    if (known.get(name) === 'bool') { if (eq >= 0) throw usageError(`--${name} takes no value`); out[name] = true; continue }
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++i]
    if (value === undefined) throw usageError(`--${name} needs a value`)
    if (Object.hasOwn(out, name)) throw usageError(`--${name} given twice`)
    out[name] = value
  }
  return out
}

function readStdinJson() {
  let text
  try { text = readFileSync(0, 'utf8') } catch (e) { throw usageError(`cannot read stdin: ${e.code || e.message}`) }
  if (text.length > 64 * 1024) throw usageError('the JSON report on stdin is over 64 KiB')
  try { return JSON.parse(text) } catch { throw usageError('stdin is not one JSON object') }
}

function printGroup(g, i) {
  const lines = [
    `${i + 1}. ${firstLine(g.tool)}  x${g.count}  (last ${firstLine(g.last.slice(0, 16).replace('T', ' '))}, sig ${firstLine(g.signature)})`,
    `   tried:    ${firstLine(g.latest.tried)}`,
    `   actual:   ${firstLine(g.latest.actual)}`,
    `   fix:      ${firstLine(g.latest.fix)}`,
  ]
  if (g.repos.length) lines.push(`   repos:    ${g.repos.map(firstLine).join(', ')}   agents: ${g.agents.map(firstLine).join(', ')}`)
  return lines.join('\n')
}

export function main(argv, { env = process.env, cwd = process.cwd(), out = s => process.stdout.write(s), err = s => process.stderr.write(s) } = {}) {
  const [cmd, ...rest] = argv
  try {
    if (cmd === 'file') {
      let raw
      if (rest.length === 1 && rest[0] === '--stdin') raw = readStdinJson()
      else {
        const flags = parseFlags(rest, new Map([...Object.keys(FIELDS), 'agent', 'repo'].map(k => [k, 'value'])))
        raw = flags
      }
      const { record, path } = fileReport(raw, { env, cwd })
      out(`PAPERCUT: FILED ${record.signature} ${record.tool} -> ${path}\n`)
      return 0
    }
    if (cmd === 'list') {
      const flags = parseFlags(rest, new Map([['limit', 'value'], ['json', 'bool']]))
      let limit = 20
      if (flags.limit !== undefined) {
        if (!/^[1-9][0-9]{0,5}$/.test(flags.limit)) throw usageError('--limit must be a positive whole number')
        limit = Number(flags.limit)
      }
      const { reports, skipped } = readReports({ env })
      const newest = reports.slice().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit)
      if (flags.json) out(JSON.stringify({ reports: newest, skipped }) + '\n')
      else {
        if (!newest.length) out('no papercuts filed\n')
        for (const r of newest) out(`${firstLine(r.at.slice(0, 16).replace('T', ' '))}  ${firstLine(r.agent ?? '?')}  ${firstLine(r.repo ?? '-')}  ${firstLine(r.tool)}  ${firstLine(r.signature)}\n  actual: ${firstLine(r.actual)}\n`)
      }
      if (skipped) err(`papercut: skipped ${skipped} unreadable line(s)\n`)
      return 0
    }
    if (cmd === 'summary') {
      const flags = parseFlags(rest, new Map([['json', 'bool']]))
      const { reports, skipped } = readReports({ env })
      const groups = summarize(reports)
      if (flags.json) out(JSON.stringify({ groups: groups.map(({ latest, ...g }) => ({ ...g, latest })), total: reports.length, skipped }) + '\n')
      else {
        out(groups.length ? `${reports.length} papercut(s) in ${groups.length} group(s), newest first\n` : 'no papercuts filed\n')
        groups.forEach((g, i) => out(printGroup(g, i) + '\n'))
      }
      if (skipped) err(`papercut: skipped ${skipped} unreadable line(s)\n`)
      return 0
    }
    err(USAGE + '\n')
    return 2
  } catch (e) {
    if (e instanceof PapercutError) {
      err(`PAPERCUT: ${e.code === 2 ? 'INVALID' : 'ERROR'} ${e.message}\n`)
      if (e.code === 2) err(USAGE + '\n')
      return e.code
    }
    err(`PAPERCUT: ERROR ${e.message}\n`)
    return 1
  }
}

// Run as a command, also through an installed skills symlink.
if (process.argv[1]) {
  let self = false
  try { self = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { self = false }
  if (self) process.exitCode = main(process.argv.slice(2))
}
