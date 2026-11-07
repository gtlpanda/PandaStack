#!/usr/bin/env node
// gate.mjs - the review gate: a PreToolUse hook on Bash that keeps unreviewed
// code out of pull requests and off the default branch, in every repo.
//
//   gh pr create | gh pr new   needs a finished /bughunt covering the PR head
//   gh pr merge                needs that, and its result must be pass
//   gh api .../pulls/N/merge   denied (also GraphQL merges): use gh pr merge
//   git push to the default    denied: changes reach it through a reviewed PR
//   branch
// A change whose whole diff is documentation needs no hunt. "Covering" is
// review-status.mjs: the hunted head, plus only docs commits and verified
// /bughunt repairs after it.
//
// Off switch: start Claude Code with PANDASTACK_REVIEW_GATE=0. A person can
// also run the command themselves (`! gh pr merge ...`), which no hook sees.
// It allows any call it cannot read (not a Bash call, bad input); once a
// command matches, anything it cannot resolve is denied with the reason.
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { simpleCommands, gitSubcommand } from '../../../build/skills/build-app/driver/hooks/guard-rules.mjs'
import { reviewStatus, commitOf } from './review-status.mjs'

const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
const OVERRIDE = 'A person can run it themselves with `! <command>`, or start Claude Code with PANDASTACK_REVIEW_GATE=0.'

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...SAFE_GIT, ...args], { encoding: 'utf8', timeout: 15_000 })
  return r.status === 0 ? (r.stdout || '').trim() : null
}

// The flags that take a value, per command, so a value is never read as the
// positional argument. --flag=value needs no entry.
const GH_GLOBAL_VALUE = ['-R', '--repo']
const PR_CREATE_VALUE = ['-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-H', '--head', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '-T', '--template', '--recover']
const PR_MERGE_VALUE = ['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit']
const PUSH_VALUE = ['--repo', '-o', '--push-option', '--receive-pack', '--exec']

// {flags: {name: value|true}, positional: [..]}; a name keeps its dashes.
function parseFlags(args, valueFlags) {
  const flags = {}
  const positional = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--') { positional.push(...args.slice(i + 1)); break }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    if (eq > 0) { flags[a.slice(0, eq)] = a.slice(eq + 1); continue }
    if (valueFlags.includes(a)) { flags[a] = args[i + 1] ?? ''; i += 1; continue }
    if (a.startsWith('-') && a !== '-') { flags[a] = true; continue }
    positional.push(a)
  }
  return { flags, positional }
}
const flag = (flags, ...names) => { for (const n of names) if (flags[n] !== undefined) return flags[n]; return undefined }

// owner/repo of a GitHub remote URL or a -R value, lowercased; null if unknown.
export function repoSlug(s) {
  const m = /(?:github\.com[/:])?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(s || '').trim())
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

function defaultBranches(dir, remote = 'origin') {
  const head = git(dir, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])
  if (head && head.startsWith(`${remote}/`)) return [head.slice(remote.length + 1)]
  return ['main', 'master']
}

function deny(why, what) {
  return `review gate: ${why}${what ? ` ${what}` : ''} ${OVERRIDE}`
}

// The -R repo must be the one checked out here: the ledgers live in this clone.
function wrongRepo(dir, flags) {
  const r = flag(flags, '-R', '--repo')
  if (r === undefined) return null
  const here = repoSlug(git(dir, ['remote', 'get-url', 'origin']))
  if (here && repoSlug(r) === here) return null
  return deny(`\`-R ${r}\` names a repo other than this checkout's origin (${here || 'none'}); its /bughunt ledgers live in its own clone.`, 'Run the command from that repo\'s checkout.')
}

function prCreate(dir, args) {
  const { flags } = parseFlags(args, [...GH_GLOBAL_VALUE, ...PR_CREATE_VALUE])
  if (flags['--dry-run'] !== undefined || flags['-w'] !== undefined || flags['--web'] !== undefined) return null
  const other = wrongRepo(dir, flags)
  if (other) return other
  let branch = flag(flags, '-H', '--head')
  if (typeof branch === 'string' && branch.includes(':')) branch = branch.slice(branch.indexOf(':') + 1)
  if (branch === undefined || branch === true) branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch || branch === 'HEAD') return deny('cannot tell which branch this PR is for.', 'Check out the branch, or pass --head.')
  const head = commitOf(dir, `refs/heads/${branch}`) || commitOf(dir, `refs/remotes/origin/${branch}`)
  if (!head) return deny(`branch ${branch} is not in this clone.`, 'Fetch or check it out first.')
  let base = flag(flags, '-B', '--base')
  base = typeof base === 'string' ? (commitOf(dir, `refs/remotes/origin/${base}`) ? `origin/${base}` : base) : `origin/${defaultBranches(dir)[0]}`
  const s = reviewStatus(dir, head, { base })
  if (s.docsOnly || s.hunted) return null
  return deny(`no finished /bughunt covers ${branch} at ${head.slice(0, 12)}, so this PR would open unreviewed.`, `Run \`/bughunt ${branch}\`, fix what it finds, then open the PR.`)
}

function prMerge(dir, args, ghBin) {
  const { flags, positional } = parseFlags(args, [...GH_GLOBAL_VALUE, ...PR_MERGE_VALUE])
  if (flags['--disable-auto'] !== undefined) return null
  const other = wrongRepo(dir, flags)
  if (other) return other
  const target = positional[0]
  const viewArgs = ['pr', 'view', ...(target ? [target] : []), '--json', 'number,headRefOid,headRefName,baseRefName']
  const r = spawnSync(ghBin, viewArgs, { cwd: dir, encoding: 'utf8', timeout: 10_000 })
  let pr = null
  if (r.status === 0) { try { pr = JSON.parse(r.stdout) } catch { pr = null } }
  const pinned = flag(flags, '--match-head-commit')
  const head = typeof pinned === 'string' && pinned ? pinned : pr && pr.headRefOid
  if (!head) return deny(`could not read the PR's head commit (\`gh ${viewArgs.join(' ')}\` failed).`, 'Pass --match-head-commit <sha>.')
  const label = pr ? `PR #${pr.number}` : `the PR at ${String(head).slice(0, 12)}`
  if (!commitOf(dir, head)) {
    return deny(`${label}'s head ${String(head).slice(0, 12)} is not in this clone.`, `Fetch it (\`git fetch origin pull/${pr ? pr.number : '<n>'}/head\`), then retry.`)
  }
  const base = pr && pr.baseRefName ? `origin/${pr.baseRefName}` : null
  const s = reviewStatus(dir, head, { base })
  if (s.docsOnly) return null
  const hunt = pr ? `/bughunt ${pr.number}` : '/bughunt'
  if (!s.hunted) return deny(`no finished /bughunt covers ${label} at ${String(head).slice(0, 12)}.`, `Run \`${hunt}\`, fix what it finds, then merge.`)
  if (s.disposition !== 'pass') {
    return deny(`the /bughunt of ${label} (at ${s.head.slice(0, 12)}) is ${s.disposition}${s.because.length ? `: ${s.because.join(', ')}` : ''}.`, `Fix those (\`${hunt} --fix\` repairs reproduced bugs), re-run the hunt, then merge; a manual_review result needs a person.`)
  }
  return null
}

function ghApi(args) {
  const text = args.join(' ')
  if (/(^|\/)pulls\/[0-9]+\/merge\b/.test(text) || /\b(mergePullRequest|enablePullRequestAutoMerge)\b/.test(text)) {
    return deny('merging through `gh api` skips the review check.', 'Use `gh pr merge <n>`, which the gate checks against /bughunt.')
  }
  return null
}

function gitPush(dir, sub) {
  const { flags, positional } = parseFlags(sub.slice(1), PUSH_VALUE)
  if (flag(flags, '--all', '--mirror') !== undefined) return deny('`git push --all`/`--mirror` would update the default branch directly.', 'Push your branch and open a reviewed PR.')
  if (flag(flags, '--dry-run', '-n') !== undefined) return null
  const remote = positional[0] || 'origin'
  const defaults = defaultBranches(dir, remote)
  const current = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const specs = positional.slice(1)
  const dsts = specs.length ? specs.map(spec => {
    const s = spec.replace(/^\+/, '')
    const dst = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s
    return dst === 'HEAD' || dst === '@' ? current : dst
  }) : [current]
  const hit = dsts.map(d => String(d || '').replace(/^refs\/heads\//, '')).find(d => defaults.includes(d))
  if (hit) return deny(`this pushes straight to ${remote}/${hit}, the default branch, with no review.`, 'Push a branch, run /bughunt on it, and open a PR.')
  return null
}

// Applies `cd <dir>` so a later command is judged in the repo it runs in.
// A target the gate cannot know ($VAR, $(...), -) makes the directory unknown.
function cdTo(dir, args) {
  const t = args.find(a => !a.startsWith('-') || a === '-')
  if (t === undefined || t === '~') return homedir()
  if (t === '-' || /[$`]|SUBST/.test(t)) return null
  let p
  if (t.startsWith('~/')) p = resolve(homedir(), t.slice(2))
  else if (isAbsolute(t)) p = t
  else if (dir !== null) p = resolve(dir, t)
  else return null
  return existsSync(p) ? p : null
}

// The index in args of the n-th positional word (0-based), skipping flags
// and the values of valueFlags; -1 if there is none.
function positionalIndex(args, valueFlags, n) {
  let seen = 0
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (valueFlags.includes(a)) { i += 1; continue }
    if (a.startsWith('-') && a !== '-') continue
    if (seen === n) return i
    seen += 1
  }
  return -1
}

// The deny reason for a Bash command line run in cwd, or null to allow.
export function gateDecision(command, cwd, { env = process.env } = {}) {
  if (env.PANDASTACK_REVIEW_GATE === '0') return null
  const text = String(command || '')
  if (!/\b(gh|git)\b/.test(text)) return null
  const ghBin = env.PANDASTACK_GATE_GH || 'gh'
  let dir = cwd && existsSync(cwd) ? cwd : null
  for (const { word, args, tooDeep } of simpleCommands(text)) {
    if (tooDeep) {
      if (/\bgh\s+(pr|api)\b|\bpush\b/.test(text)) return deny('a command nested too deeply to check.', 'Run it unnested.')
      continue
    }
    if (word === 'cd' || word === 'pushd') { dir = cdTo(dir, args); continue }
    const unknownDir = deny('cannot tell which repo this command runs in (a `cd` or `-C` the gate cannot resolve).', 'Run it from the repo\'s directory without the cd.')
    let reason = null
    if (word === 'gh') {
      const g = positionalIndex(args, GH_GLOBAL_VALUE, 0)
      const v = positionalIndex(args, GH_GLOBAL_VALUE, 1)
      const group = g >= 0 ? args[g] : null
      const verb = v >= 0 ? args[v] : null
      // Global flags can come before the group; the verb's own flags after it.
      const own = [...args.slice(0, g >= 0 ? g : 0), ...(v >= 0 ? args.slice(v + 1) : [])]
      if (group === 'pr' && (verb === 'create' || verb === 'new')) reason = dir ? prCreate(dir, own) : unknownDir
      else if (group === 'pr' && verb === 'merge') reason = dir ? prMerge(dir, own, ghBin) : unknownDir
      else if (group === 'api') reason = ghApi(args)
    } else if (word === 'git') {
      const { opts, sub } = gitSubcommand(args)
      if (sub[0] === 'push') {
        let d = dir
        for (let i = 0; i < opts.length; i += 1) if (opts[i] === '-C' && opts[i + 1] !== undefined) { d = cdTo(d, [opts[i + 1]]); i += 1 }
        reason = d ? gitPush(d, sub) : unknownDir
      }
    }
    if (reason) return reason
  }
  return null
}

function main() {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { return }
  if (!input || input.tool_name !== 'Bash' || !input.tool_input || typeof input.tool_input.command !== 'string') return
  let reason
  try { reason = gateDecision(input.tool_input.command, input.cwd || process.cwd()) } catch (e) { reason = deny(`could not check this command: ${e.message}.`) }
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
