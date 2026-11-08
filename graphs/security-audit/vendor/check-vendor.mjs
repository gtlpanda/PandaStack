#!/usr/bin/env node
// check-vendor.mjs - the drift check for the vendored Cloudflare skill. It recomputes the git blob
// hash of every file under cloudflare-security-audit/ and compares it with UPSTREAM.json, so a
// changed, missing, or unlisted file fails by name. Offline, no git needed.
//
//   node check-vendor.mjs [dir]       dir defaults to the vendored tree beside this file
//   node check-vendor.mjs --online    MANUAL, needs the network, never run in CI: is the pin current?
// Offline prints one line per problem, then "check-vendor: N files match ..." and exits 0, or
// "check-vendor: FAIL ..." and exits 1. --online exits 0 when current, 1 when behind or diverged,
// 2 when it could not look. Usage errors exit 2.
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { VENDOR_DIR } from '../skills/security-audit/upstream.mjs'

export const MANIFEST = 'UPSTREAM.json'
const HEX40 = /^[0-9a-f]{40}$/
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// What `git hash-object` prints for these bytes: sha1("blob <length>\0" + bytes).
export function gitBlobHash(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

// Every file under root as a forward-slash path relative to it, and every entry that is neither a
// file nor a directory (a symlink or a special file: never followed, so never hashed).
function walk(root) {
  const files = []
  const odd = []
  const visit = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) visit(p)
      else (e.isFile() ? files : odd).push(relative(root, p).split(sep).join('/'))
    }
  }
  visit(root)
  return { files: files.filter(f => f !== MANIFEST).sort(), odd: odd.sort() }
}

function readManifest(dir) {
  let m
  try { m = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) } catch (e) { return { problems: [`${MANIFEST}: cannot be read as JSON (${e.code || e.message})`] } }
  const problems = []
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { problems: [`${MANIFEST}: must be a JSON object`] }
  if (typeof m.commit !== 'string' || !HEX40.test(m.commit)) problems.push(`${MANIFEST}: commit must be a 40-hex git commit`)
  if (!m.files || typeof m.files !== 'object' || Array.isArray(m.files) || !Object.keys(m.files).length) return { problems: [...problems, `${MANIFEST}: files must list the vendored files`] }
  for (const [path, f] of Object.entries(m.files)) {
    if (!f || typeof f.blob !== 'string' || !HEX40.test(f.blob) || !Number.isInteger(f.size) || f.size < 0) problems.push(`${MANIFEST}: files[${JSON.stringify(path)}] needs a 40-hex blob and an integer size`)
  }
  return problems.length ? { problems } : { manifest: m, problems }
}

// {problems, count, commit}: problems is empty when the tree is exactly what UPSTREAM.json pins.
export function checkVendor(dir = VENDOR_DIR) {
  const { manifest, problems } = readManifest(dir)
  if (!manifest) return { problems, count: 0, commit: null }
  let tree
  try { tree = walk(dir) } catch (e) { return { problems: [`cannot list ${dir} (${e.code || e.message})`], count: 0, commit: manifest.commit } }
  const { files, odd } = tree
  const present = new Set(files)
  for (const [path, want] of Object.entries(manifest.files)) {
    if (!present.has(path)) { problems.push(`missing: ${path}`); continue }
    let bytes
    try { bytes = readFileSync(join(dir, path)) } catch (e) { problems.push(`unreadable: ${path} (${e.code || e.message})`); continue }
    const got = gitBlobHash(bytes)
    if (got !== want.blob) problems.push(`changed: ${path} (blob ${got}, pinned ${want.blob})`)
    else if (bytes.length !== want.size) problems.push(`size: ${path} is ${bytes.length} bytes, ${MANIFEST} says ${want.size}`)
  }
  for (const path of files) if (!hasOwn(manifest.files, path)) problems.push(`extra: ${path} is not listed in ${MANIFEST}`)
  for (const path of odd) problems.push(`not a regular file: ${path}`)
  return { problems, count: Object.keys(manifest.files).length, commit: manifest.commit }
}

const git = (cwd, args, config = []) => spawnSync('git', [...config, '-C', cwd, ...args], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

// Where the pinned repo's branch is now, relative to the pin: {state, head, ahead, subjects}, state
// current | behind | diverged (the pin is not in the branch's history). It fetches commit history
// only (no file contents) into a throwaway bare repo and never touches the vendored tree. Throws
// when it cannot look. Only https is allowed; `protocol` exists so a test can use a local repo.
export function checkOnline(manifest, { remote = manifest.repo, protocol = 'https', limit = 20 } = {}) {
  const branch = manifest.branch || 'main'
  if (protocol === 'https' && !/^https:\/\/[^\s]+$/.test(remote)) throw new Error(`${MANIFEST}: repo must be an https URL, got ${JSON.stringify(remote)}`)
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) throw new Error(`${MANIFEST}: branch is not a plain branch name, got ${JSON.stringify(branch)}`)
  const scratch = mkdtempSync(join(tmpdir(), 'check-vendor-'))
  const need = (r, what) => { if (r.status !== 0) throw new Error(`${what}: ${(r.error && r.error.message) || r.stderr.trim() || `git exited ${r.status}`}`); return r.stdout.trim() }
  try {
    need(git(scratch, ['init', '-q', '--bare']), 'git init')
    const lock = ['-c', 'protocol.allow=never', '-c', `protocol.${protocol}.allow=always`]
    need(git(scratch, ['fetch', '-q', '--no-tags', '--filter=blob:none', remote, branch], lock), `git fetch ${remote}`)
    const head = need(git(scratch, ['rev-parse', 'FETCH_HEAD^{commit}']), 'git rev-parse')
    if (head === manifest.commit) return { state: 'current', head, ahead: 0, subjects: [] }
    const known = git(scratch, ['cat-file', '-e', `${manifest.commit}^{commit}`]).status === 0
    if (!known || git(scratch, ['merge-base', '--is-ancestor', manifest.commit, head]).status !== 0) return { state: 'diverged', head, ahead: null, subjects: [] }
    const range = `${manifest.commit}..${head}`
    const ahead = Number(need(git(scratch, ['rev-list', '--count', range]), 'git rev-list'))
    const subjects = need(git(scratch, ['log', '--format=%s', '-n', String(limit), range]), 'git log').split('\n')
    return { state: 'behind', head, ahead, subjects }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

function online() {
  const { manifest, problems } = readManifest(VENDOR_DIR)
  if (!manifest) { for (const p of problems) console.log(p); return 2 }
  const short = sha => sha.slice(0, 12)
  let r
  try { r = checkOnline(manifest) } catch (e) { console.error(`check-vendor --online: ${e.message}`); return 2 }
  if (r.state === 'current') { console.log(`check-vendor --online: the pin ${short(manifest.commit)} is current (${manifest.repo} ${manifest.branch || 'main'})`); return 0 }
  if (r.state === 'diverged') { console.log(`check-vendor --online: the pin ${short(manifest.commit)} is not in the history of ${manifest.branch || 'main'} (now ${short(r.head)})`); return 1 }
  console.log(`check-vendor --online: ${manifest.branch || 'main'} is ${r.ahead} commit(s) ahead of the pin ${short(manifest.commit)} (now ${short(r.head)}); newest first:`)
  for (const s of r.subjects) console.log(`  ${s}`)
  if (r.ahead > r.subjects.length) console.log(`  ... and ${r.ahead - r.subjects.length} more`)
  return 1
}

function main(argv) {
  const flags = argv.filter(a => a.startsWith('--'))
  const dirs = argv.filter(a => !a.startsWith('--'))
  if (flags.some(f => f !== '--online') || dirs.length > 1 || (flags.length && dirs.length)) {
    console.error('usage: check-vendor.mjs [dir]   or   check-vendor.mjs --online')
    return 2
  }
  if (flags.length) return online()
  const r = checkVendor(dirs[0])
  for (const p of r.problems) console.log(p)
  if (r.problems.length) { console.log(`check-vendor: FAIL, ${r.problems.length} problem(s) against ${MANIFEST}`); return 1 }
  console.log(`check-vendor: ${r.count} files match ${MANIFEST} (${r.commit.slice(0, 12)})`)
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
