#!/usr/bin/env node
// review-status.mjs - does a finished /bughunt cover this commit, and with what result?
// The review gate (gate.mjs) asks it before a PR is opened or merged.
//
// A hunt covers commit X when some ledger under <git common dir>/bughunt/*/
// ended its latest run 'done' at head H, and H is X, or H is an ancestor of X
// and every commit in H..X is exempt:
//   - docs only: every path it touches is documentation (DOCS below);
//   - a verified repair: subject "bughunt: fix F<n>" and F<n> is fix_status
//     verified in that same ledger (/bughunt --draft-pr, /build-app landings).
// A merge commit is never exempt: it can bring in any code.
// The result for X is the ledger's disposition, minus the findings whose
// verified repair is among the exempt commits: X contains those fixes.
// A change whose whole diff from its base is documentation needs no hunt.
//
//   node review-status.mjs status --repo <dir> --head <sha> [--base <ref>]
// prints one JSON object and exits 0; exits 1 on a usage or git error.
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readLedger, disposition } from '../../../../core/skills/findings/findings.mjs'

// The repo's own hooks and fsmonitor never run for these reads.
const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
const FIX_SUBJECT = /^bughunt: fix (F[1-9][0-9]*)$/
const MAX_EXEMPT = 200 // commits after the hunted head; past this, re-hunt

// Documentation paths. Anything else, including a config or a test, is code.
export function isDocPath(p) {
  return /\.md$/i.test(p) || /^docs\//.test(p) || /^changelogs\//.test(p) || /^LICENSE(\.[A-Za-z]+)?$/.test(p) || /(^|\/)LICENSE(\.[A-Za-z]+)?$/.test(p)
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...SAFE_GIT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15_000 })
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() || (r.error ? r.error.message : '') }
}
function mustGit(repo, args, what) {
  const r = git(repo, args)
  if (!r.ok) throw new Error(`${what}: ${r.err || 'git failed'}`)
  return r.out
}
const lines = s => s.split('\n').filter(Boolean)

export function commitOf(repo, ref) {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return r.ok ? r.out : null
}

// Paths a single commit changes, against its only parent. Null for a merge.
function commitPaths(repo, sha) {
  const parents = lines(mustGit(repo, ['rev-list', '--parents', '-n', '1', sha], `reading ${sha}`)).join(' ').split(' ').slice(1)
  if (parents.length > 1) return null
  const args = parents.length ? ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', parents[0], sha] : ['ls-tree', '-r', '-z', '--name-only', sha]
  return mustGit(repo, args, `listing ${sha}`).split('\0').filter(Boolean)
}

// Why commit sha is exempt after a hunt recorded in ledger, or null.
function exemptBecause(repo, sha, ledger) {
  const subject = mustGit(repo, ['log', '-1', '--format=%s', sha], `reading ${sha}`)
  const m = FIX_SUBJECT.exec(subject)
  if (m) {
    const f = (ledger.findings || []).find(x => x.finding_id === m[1])
    if (f && f.fix_status === 'verified') return `verified repair of ${m[1]}`
    return null
  }
  const paths = commitPaths(repo, sha)
  if (paths && paths.length && paths.every(isDocPath)) return 'docs only'
  return null
}

// Every ledger in the repo, as {key, ledger}. An unreadable one is skipped.
function ledgers(repo) {
  const common = mustGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'finding the git directory')
  const root = join(common, 'bughunt')
  if (!existsSync(root)) return []
  const out = []
  for (const key of readdirSync(root)) {
    const file = join(root, key, 'ledger.json')
    if (!existsSync(file)) continue
    try { out.push({ key, ledger: readLedger(file, key) }) } catch { /* not a ledger we can read */ }
  }
  return out
}

// The hunted head a ledger stands for: its latest run, if that run finished.
function huntedHead(ledger) {
  const runs = ledger.runs || []
  const last = runs[runs.length - 1]
  if (!last || last.status !== 'done' || ledger.status !== 'done' || !/^[0-9a-f]{40}$/.test(last.head || '')) return null
  return last.head
}

// {hunted, docsOnly, key, head, disposition, because, exempt, reason}
export function reviewStatus(repo, head, { base = null } = {}) {
  const sha = commitOf(repo, head)
  if (!sha) return { hunted: false, docsOnly: false, reason: `${head} is not a commit in this repo (fetch it first)` }
  if (base) {
    const baseSha = commitOf(repo, base)
    const mb = baseSha ? git(repo, ['merge-base', baseSha, sha]) : { ok: false }
    if (mb.ok && mb.out) {
      const paths = mustGit(repo, ['diff', '--name-only', '-z', mb.out, sha], 'diffing against the base').split('\0').filter(Boolean)
      if (paths.length && paths.every(isDocPath)) return { hunted: false, docsOnly: true, head: sha, reason: 'the change touches documentation only' }
    }
  }
  let best = null
  for (const { key, ledger } of ledgers(repo)) {
    const h = huntedHead(ledger)
    if (!h) continue
    let exempt = []
    if (h !== sha) {
      if (!git(repo, ['merge-base', '--is-ancestor', h, sha]).ok) continue
      const after = lines(mustGit(repo, ['rev-list', '--reverse', `${h}..${sha}`], 'listing commits after the hunt'))
      if (after.length > MAX_EXEMPT) continue
      const why = after.map(c => [c, exemptBecause(repo, c, ledger)])
      if (why.some(([, w]) => !w)) continue
      exempt = why.map(([c, w]) => ({ commit: c, because: w }))
    }
    if (!best || exempt.length < best.exempt.length) best = { key, ledger, head: h, exempt }
  }
  if (!best) return { hunted: false, docsOnly: false, head: sha, reason: `no finished /bughunt covers ${sha.slice(0, 12)}` }
  // A verified repair closes its finding only once it is in the commit being
  // judged; until then the ledger keeps the finding open (findings.mjs OPEN).
  const fixedHere = new Set(best.exempt.map(e => /^verified repair of (F[0-9]+)$/.exec(e.because)).filter(Boolean).map(m => m[1]))
  const d = disposition({ ...best.ledger, findings: (best.ledger.findings || []).filter(f => !fixedHere.has(f.finding_id)) })
  return { hunted: true, docsOnly: false, key: best.key, head: best.head, target: sha, disposition: d.disposition, because: d.because, exempt: best.exempt }
}

function main(argv) {
  const [cmd, ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--repo', '--head', '--base'].includes(rest[i]) || rest[i + 1] === undefined) { flags.bad = true; break }
    flags[rest[i].slice(2)] = rest[i + 1]
  }
  if (cmd !== 'status' || flags.bad || !flags.repo || !flags.head) {
    console.error('usage: review-status.mjs status --repo <dir> --head <sha> [--base <ref>]')
    return 2
  }
  try {
    console.log(JSON.stringify(reviewStatus(flags.repo, flags.head, { base: flags.base || null })))
    return 0
  } catch (e) {
    console.error(`review-status: ${e.message}`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
