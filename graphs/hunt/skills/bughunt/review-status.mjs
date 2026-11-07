#!/usr/bin/env node
// review-status.mjs - does a finished /bughunt cover this commit, and with what result?
// The review gate (gate.mjs) asks it before a PR is opened or merged.
//
// A hunt covers commit X when some ledger under <git common dir>/bughunt/*/
// ended its latest run 'done' at head H, its hunted range started no later
// than X's merge-base with the PR's base (so no earlier commit went unseen),
// and H is X, or H is an ancestor of X and every commit in H..X is exempt:
//   - docs only: every path it touches is documentation (isDocPath);
//   - a verified repair: the very commit /bughunt verified for a finding
//     (fix_artifact.commit), or the same patch (a cherry-pick or rebase of it).
//     Its subject alone proves nothing.
// A merge commit is never exempt: it can bring in any code.
// The result for X is the ledger's disposition, minus the findings whose
// verified repair is among the exempt commits: X contains those fixes. When
// several ledgers cover X, the closest hunt wins (fewest commits after it);
// among equals, the one for this PR, else the worst result.
// A change whose whole diff from its base is documentation needs no hunt.
//
//   node review-status.mjs status --repo <dir> --head <sha> [--base <ref>] [--pr <n>]
// prints one JSON object and exits 0; exits 1 on a git error, 2 on bad usage.
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readLedger, disposition } from '../../../../core/skills/findings/findings.mjs'

// The repo's own hooks and fsmonitor never run for these reads.
const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
const MAX_EXEMPT = 200 // commits after the hunted head; past this, re-hunt
const WORST = { pass: 0, manual_review: 1, changes_requested: 2 }

// Documentation: prose and images, which a bug hunt has no code to review in.
// Markdown anywhere counts (READMEs, CLAUDE.md, /release-pr's notes), except
// under .claude/, where Claude Code runs it (commands, agents, hooks). Under
// docs/ and changelogs/, only prose and image files count: a site config or a
// build script there is code.
const DOC_EXT = /\.(md|markdown|rst|txt|adoc|png|jpe?g|gif|svg|webp|pdf)$/i
export function isDocPath(p) {
  const s = String(p)
  if (/(^|\/)\.claude\//.test(s)) return false
  if (/(^|\/)LICENSE(\.[A-Za-z]+)?$/.test(s)) return true
  if (/^(docs|changelogs)\//.test(s)) return DOC_EXT.test(s)
  return /\.(md|markdown)$/i.test(s)
}

function git(repo, args, input) {
  const r = spawnSync('git', ['-C', repo, ...SAFE_GIT, ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 })
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() || (r.error ? r.error.message : '') }
}
function mustGit(repo, args, what) {
  const r = git(repo, args)
  if (!r.ok) throw new Error(`${what}: ${r.err || 'git failed'}`)
  return r.out
}
const lines = s => s.split('\n').filter(Boolean)
const isAncestor = (repo, a, b) => git(repo, ['merge-base', '--is-ancestor', a, b]).ok

export function commitOf(repo, ref) {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return r.ok ? r.out : null
}

// Facts about one commit, read once per call: its subject, whether it is a
// merge, the paths it changes (renames as a delete plus an add), its patch id.
function commitFacts(repo, sha, cache) {
  if (cache.has(sha)) return cache.get(sha)
  const parents = mustGit(repo, ['rev-list', '--parents', '-n', '1', sha], `reading ${sha}`).split(' ').slice(1)
  const merge = parents.length > 1
  let paths = []
  if (!merge) {
    const args = parents.length ? ['diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', '-z', parents[0], sha] : ['ls-tree', '-r', '-z', '--name-only', sha]
    paths = mustGit(repo, args, `listing ${sha}`).split('\0').filter(Boolean)
  }
  const facts = { merge, paths, patchId: undefined }
  cache.set(sha, facts)
  return facts
}
function patchIdOf(repo, sha, cache) {
  const facts = commitFacts(repo, sha, cache)
  if (facts.patchId === undefined) {
    const diff = git(repo, ['show', '--no-renames', '--format=', sha])
    const id = diff.ok && diff.out ? git(repo, ['patch-id', '--stable'], diff.out + '\n') : { ok: false }
    facts.patchId = id.ok && id.out ? id.out.split(' ')[0] : null
  }
  return facts.patchId
}

// Why commit sha is exempt after a hunt recorded in ledger, or null.
// {because, fixed?: finding id}
function exemptBecause(repo, sha, ledger, cache) {
  const facts = commitFacts(repo, sha, cache)
  if (facts.merge) return null
  for (const f of ledger.findings || []) {
    const fixCommit = f.fix_status === 'verified' && f.fix_artifact && f.fix_artifact.commit
    if (!fixCommit) continue
    if (fixCommit === sha) return { because: `verified repair of ${f.finding_id}`, fixed: f.finding_id }
    if (commitOf(repo, fixCommit)) {
      const mine = patchIdOf(repo, sha, cache)
      if (mine && mine === patchIdOf(repo, fixCommit, cache)) return { because: `verified repair of ${f.finding_id} (same patch as ${fixCommit.slice(0, 12)})`, fixed: f.finding_id }
    }
  }
  if (facts.paths.length && facts.paths.every(isDocPath)) return { because: 'docs only' }
  return null
}

// Every ledger in the repo, as {key, ledger}. An unreadable one is skipped.
function ledgers(repo) {
  const common = mustGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'finding the git directory')
  const root = join(common, 'bughunt')
  if (!existsSync(root)) return []
  const out = []
  for (const key of readdirSync(root).sort()) {
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

// {hunted, docsOnly, key, head, target, disposition, because, exempt, reason}
export function reviewStatus(repo, head, { base = null, pr = null } = {}) {
  const sha = commitOf(repo, head)
  if (!sha) return { hunted: false, docsOnly: false, reason: `${head} is not a commit in this repo (fetch it first)` }
  let mergeBase = null
  if (base) {
    const baseSha = commitOf(repo, base)
    // Without the base, the hunted range cannot be checked: unknown, not covered.
    if (!baseSha) return { hunted: false, docsOnly: false, head: sha, baseMissing: true, reason: `the base ${base} is not in this clone (fetch it first)` }
    const mb = git(repo, ['merge-base', baseSha, sha])
    if (mb.ok && mb.out) {
      mergeBase = mb.out
      const paths = mustGit(repo, ['diff', '--no-renames', '--name-only', '-z', mergeBase, sha], 'diffing against the base').split('\0').filter(Boolean)
      if (paths.length && paths.every(isDocPath)) return { hunted: false, docsOnly: true, head: sha, reason: 'the change touches documentation only' }
    }
  }
  const cache = new Map()
  const covering = []
  for (const { key, ledger } of ledgers(repo)) {
    const h = huntedHead(ledger)
    if (!h || (h !== sha && !isAncestor(repo, h, sha))) continue
    // The hunt must have looked at everything since the PR's merge-base.
    const from = ledger.target && ledger.target.mergeBase
    if (mergeBase && (!from || !isAncestor(repo, from, mergeBase))) continue
    let exempt = []
    if (h !== sha) {
      const after = lines(mustGit(repo, ['rev-list', '--reverse', `${h}..${sha}`], 'listing commits after the hunt'))
      if (after.length > MAX_EXEMPT) continue
      const why = []
      for (const c of after) { const w = exemptBecause(repo, c, ledger, cache); if (!w) break; why.push({ commit: c, ...w }) }
      if (why.length !== after.length) continue
      exempt = why
    }
    const fixedHere = new Set(exempt.map(e => e.fixed).filter(Boolean))
    const d = disposition({ ...ledger, findings: (ledger.findings || []).filter(f => !fixedHere.has(f.finding_id)) })
    covering.push({ key, ledger, head: h, exempt, d })
  }
  if (!covering.length) return { hunted: false, docsOnly: false, head: sha, reason: `no finished /bughunt covers ${sha.slice(0, 12)}` }
  const closest = Math.min(...covering.map(c => c.exempt.length))
  const near = covering.filter(c => c.exempt.length === closest)
  const forPr = pr ? near.filter(c => c.ledger.target && String(c.ledger.target.pr) === String(pr)) : []
  const pool = forPr.length ? forPr : near
  const best = pool.reduce((a, b) => ((WORST[b.d.disposition] ?? 1) > (WORST[a.d.disposition] ?? 1) ? b : a))
  return {
    hunted: true, docsOnly: false, key: best.key, head: best.head, target: sha, disposition: best.d.disposition, because: best.d.because,
    exempt: best.exempt.map(e => ({ commit: e.commit, because: e.because })),
  }
}

function main(argv) {
  const [cmd, ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--repo', '--head', '--base', '--pr'].includes(rest[i]) || rest[i + 1] === undefined) { flags.bad = true; break }
    flags[rest[i].slice(2)] = rest[i + 1]
  }
  if (cmd !== 'status' || flags.bad || !flags.repo || !flags.head) {
    console.error('usage: review-status.mjs status --repo <dir> --head <sha> [--base <ref>] [--pr <n>]')
    return 2
  }
  try {
    console.log(JSON.stringify(reviewStatus(flags.repo, flags.head, { base: flags.base || null, pr: flags.pr || null })))
    return 0
  } catch (e) {
    console.error(`review-status: ${e.message}`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
