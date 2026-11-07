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

// The gate reads a command before the shell expands it, so a $VAR or $(...)
// is unknown to it. A denial caused by one says how to get past it honestly.
const LITERAL = 'The gate reads the command before the shell expands it: write the literal value, not a $VARIABLE or $(...).'
const unexpanded = v => /[$`]|SUBST/.test(String(v))

// The repo gh will act on (-R, else GH_REPO) must be the one checked out
// here: the /bughunt ledgers live in this clone.
function wrongRepo(dir, flags, ghRepo) {
  const r = flag(flags, '-R', '--repo') ?? ghRepo
  if (r === undefined || r === null || r === '') return null
  const named = flag(flags, '-R', '--repo') !== undefined ? `-R ${r}` : `GH_REPO=${r}`
  if (unexpanded(r)) return deny(`\`${named}\`: cannot tell which repo gh will act on.`, LITERAL)
  const here = repoSlug(git(dir, ['remote', 'get-url', 'origin']))
  if (here && repoSlug(r) === here) return null
  return deny(`\`${named}\` names a repo other than this checkout's origin (${here || 'none'}); its /bughunt ledgers live in its own clone.`, 'Run the command from that repo\'s checkout.')
}

// Every commit that could become the PR head for a branch: the local tip and
// origin's, when both exist and differ. Each must be covered.
function branchTips(dir, branch) {
  return [...new Set([commitOf(dir, `refs/heads/${branch}`), commitOf(dir, `refs/remotes/origin/${branch}`)].filter(Boolean))]
}

function prCreate(dir, args, ghRepo) {
  const { flags } = parseFlags(args, [...GH_GLOBAL_VALUE, ...PR_CREATE_VALUE])
  if (flags['--dry-run'] !== undefined || flags['-w'] !== undefined || flags['--web'] !== undefined) return null
  const other = wrongRepo(dir, flags, ghRepo)
  if (other) return other
  let branch = flag(flags, '-H', '--head')
  if (typeof branch === 'string' && branch.includes(':')) {
    const owner = branch.slice(0, branch.indexOf(':')).toLowerCase()
    const here = repoSlug(git(dir, ['remote', 'get-url', 'origin']))
    if (!here || here.split('/')[0] !== owner) return deny(`\`--head ${branch}\` is a branch of another fork; this clone has no /bughunt record of it.`, 'Hunt it in a clone of that fork.')
    branch = branch.slice(branch.indexOf(':') + 1)
  }
  if (branch === undefined || branch === true) branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch || branch === 'HEAD') return deny('cannot tell which branch this PR is for.', 'Check out the branch, or pass --head.')
  if (unexpanded(branch)) return deny(`cannot tell which branch \`--head ${branch}\` is.`, LITERAL)
  const tips = branchTips(dir, branch)
  if (!tips.length) return deny(`branch ${branch} is not in this clone.`, 'Fetch or check it out first.')
  let base = flag(flags, '-B', '--base')
  if (typeof base === 'string' && unexpanded(base)) return deny(`cannot tell which branch \`--base ${base}\` is.`, LITERAL)
  base = typeof base === 'string' ? (commitOf(dir, `refs/remotes/origin/${base}`) ? `origin/${base}` : base) : `origin/${defaultBranches(dir)[0]}`
  const statuses = tips.map(tip => ({ tip, s: reviewStatus(dir, tip, { base }) }))
  const ok = statuses.filter(x => x.s.docsOnly || x.s.hunted).map(x => x.tip)
  for (const { tip, s } of statuses) {
    if (s.docsOnly || s.hunted) continue
    if (s.baseMissing) return deny(`${s.reason}, so the gate cannot tell what this PR contains.`, 'Fetch the base branch, then retry.')
    const local = tip === commitOf(dir, `refs/heads/${branch}`)
    // origin is behind a covered local tip: only a push is missing.
    if (!local && ok.some(c => git(dir, ['merge-base', '--is-ancestor', tip, c]) !== null)) {
      return deny(`origin/${branch} is behind the hunted commit ${ok[0].slice(0, 12)}.`, `Push ${branch}, then open the PR.`)
    }
    const where = tips.length > 1 ? ` (${local ? 'the local branch' : `origin/${branch}`})` : ''
    return deny(`no finished /bughunt covers ${branch} at ${tip.slice(0, 12)}${where}, so this PR would open unreviewed.`, `Run \`/bughunt ${branch}\`, fix what it finds, push, then open the PR.`)
  }
  return null
}

function prMerge(dir, args, ghBin, ghRepo) {
  const { flags, positional } = parseFlags(args, [...GH_GLOBAL_VALUE, ...PR_MERGE_VALUE])
  if (flags['--disable-auto'] !== undefined) return null
  const other = wrongRepo(dir, flags, ghRepo)
  if (other) return other
  const target = positional[0]
  if (target !== undefined && unexpanded(target)) return deny(`cannot tell which PR \`${target}\` is.`, LITERAL)
  const viewArgs = ['pr', 'view', ...(target ? [target] : []), '--json', 'number,headRefOid,headRefName,baseRefName']
  const r = spawnSync(ghBin, viewArgs, { cwd: dir, encoding: 'utf8', timeout: 10_000 })
  let pr = null
  if (r.status === 0) { try { pr = JSON.parse(r.stdout) } catch { pr = null } }
  const pinned = flag(flags, '--match-head-commit')
  if (typeof pinned === 'string' && unexpanded(pinned)) return deny(`cannot tell which commit \`--match-head-commit ${pinned}\` is.`, LITERAL)
  // gh must answer: the PR's base decides what range the hunt had to cover.
  if (!pr || !pr.headRefOid || !pr.baseRefName) return deny(`could not read the PR (\`gh ${viewArgs.join(' ')}\` failed), so the gate cannot tell what it contains.`, 'Check gh auth and the PR number, then retry.')
  const head = typeof pinned === 'string' && pinned ? pinned : pr.headRefOid
  const label = pr ? `PR #${pr.number}` : `the PR at ${String(head).slice(0, 12)}`
  if (!commitOf(dir, head)) {
    return deny(`${label}'s head ${String(head).slice(0, 12)} is not in this clone.`, `Fetch it (\`git fetch origin pull/${pr ? pr.number : '<n>'}/head\`), then retry.`)
  }
  const s = reviewStatus(dir, head, { base: `origin/${pr.baseRefName}`, pr: pr.number })
  if (s.docsOnly) return null
  if (s.baseMissing) return deny(`${s.reason}, so the gate cannot tell what ${label} contains.`, `Fetch it (\`git fetch origin ${pr.baseRefName}\`), then retry.`)
  const hunt = pr ? `/bughunt ${pr.number}` : '/bughunt'
  if (!s.hunted) return deny(`no finished /bughunt covers ${label} at ${String(head).slice(0, 12)}.`, `Run \`${hunt}\`, fix what it finds, then merge.`)
  if (s.disposition !== 'pass') {
    return deny(`the /bughunt of ${label} (at ${s.head.slice(0, 12)}) is ${s.disposition}${s.because.length ? `: ${s.because.join(', ')}` : ''}.`, `Fix those (\`${hunt} --fix\` repairs reproduced bugs), re-run the hunt, then merge; a manual_review result needs a person.`)
  }
  return null
}

// gh api calls that open or merge a PR, or write a branch, behind the gate's back.
const API_VALUE = ['-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '-q', '--jq', '-t', '--template', '--hostname', '-p', '--preview', '--cache']
const API_WRITE_PATH = /(^|\/)repos\/[^/]+\/[^/]+\/(pulls\/?$|pulls\/[0-9]+\/merge|merges|git\/refs|contents\/|branches\/[^/]+\/rename)/
const GRAPHQL_WRITES = /\b(mergePullRequest|enablePullRequestAutoMerge|createPullRequest|updateRef|updateRefs|createRef|createCommitOnBranch|mergeBranch)\b/
function ghApi(args) {
  const { flags, positional } = parseFlags(args, API_VALUE)
  // The endpoint as gh resolves it: no scheme or host, no leading /, no query.
  const path = String(positional[0] || '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '').replace(/\?.*$/, '')
  const sendsFields = args.some(a => ['-f', '--raw-field', '-F', '--field', '--input'].includes(a) || /^--(raw-)?field=|^--input=/.test(a))
  const method = String(flag(flags, '-X', '--method') || (sendsFields ? 'POST' : 'GET')).toUpperCase()
  const no = deny('opening or merging a PR, or writing a branch, through `gh api` skips the review check.', 'Use `gh pr create` / `gh pr merge`, which the gate checks against /bughunt.')
  if (/(^|\/)pulls\/[0-9]+\/merge\b/.test(path)) return no
  if (GRAPHQL_WRITES.test(args.join(' '))) return no
  if (/(^|\/)graphql$/.test(path)) {
    if (flag(flags, '--input') !== undefined || args.some(a => /^query=@/.test(a))) return deny('a GraphQL query read from a file cannot be checked.', 'Pass the query inline, or use `gh pr` commands.')
    return null
  }
  if (method !== 'GET' && method !== 'HEAD' && API_WRITE_PATH.test(path)) return no
  return null
}

// Normalizes a push refspec's destination to a branch name; '*' for a pattern
// or a "matching" push (':' alone), which can reach any branch.
function pushDestination(spec, current) {
  const s = spec.replace(/^\+/, '')
  if (s === ':' ) return '*'
  let dst = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s
  if (dst === '' && s.includes(':')) return null   // `:x` deletes x; handled as dst x below
  if (dst === 'HEAD' || dst === '@') dst = current
  dst = String(dst || '').replace(/^refs\/heads\//, '').replace(/^heads\//, '')
  return /[*?[]/.test(dst) ? '*' : dst
}

function gitPush(dir, sub) {
  const { flags, positional } = parseFlags(sub.slice(1), PUSH_VALUE)
  if (flag(flags, '--all', '--mirror', '--branches') !== undefined) return deny('`git push --all`/`--mirror` would update the default branch directly.', 'Push your branch and open a reviewed PR.')
  if (flag(flags, '--dry-run', '-n') !== undefined) return null
  if (flag(flags, '--tags') !== undefined && positional.length <= 1) return null   // tags only
  const remote = positional[0] || 'origin'
  if (unexpanded(remote) || positional.slice(1).some(unexpanded)) return deny('cannot tell where this push goes.', LITERAL)
  const defaults = defaultBranches(dir, remote)
  const current = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const specs = positional.slice(1)
  const dsts = specs.length ? specs.map(spec => pushDestination(spec, current)) : [current]
  if (dsts.includes('*')) return deny('a pattern or "matching" push can update the default branch directly.', 'Push one branch by name.')
  const hit = dsts.find(d => d && defaults.includes(d))
  if (hit) return deny(`this pushes straight to ${remote}/${hit}, the default branch, with no review.`, 'Push a branch, run /bughunt on it, and open a PR.')
  return null
}

// Applies `cd <dir>` so a later command is judged in the repo it runs in.
// A target the gate cannot know ($VAR, $(...), -) makes the directory unknown.
function cdTo(dir, args) {
  const t = args.find(a => !a.startsWith('-') || a === '-')
  if (t === undefined || t === '~') return homedir()
  if (t === '-' || unexpanded(t)) return null
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

const GATED_TEXT = /\b(gh|hub)\b[\s\S]*\b(pr|api|pull-request|merge|alias)\b|\bpush\b/

// The deny reason for a Bash command line run in cwd, or null to allow.
export function gateDecision(command, cwd, { env = process.env } = {}) {
  if (env.PANDASTACK_REVIEW_GATE === '0') return null
  const text = String(command || '')
  const ghBin = env.PANDASTACK_GATE_GH || 'gh'
  let dir = cwd && existsSync(cwd) ? cwd : null
  const exported = {}   // export VAR=value earlier in this command line
  for (const c of simpleCommands(text)) {
    const { word, args } = c
    if (c.tooDeep || c.stdinScript) {
      if (GATED_TEXT.test(text)) return deny(c.tooDeep ? 'a command nested too deeply to check.' : 'a script fed to a shell on its input cannot be checked.', 'Run the commands directly.')
      continue
    }
    if (word === 'cd' || word === 'pushd') { dir = cdTo(dir, args); continue }
    if (word === 'export' || word === 'declare' || word === 'typeset') {
      for (const a of args) { const eq = a.indexOf('='); if (eq > 0) exported[a.slice(0, eq)] = a.slice(eq + 1) }
      continue
    }
    const ghRepo = c.env.GH_REPO ?? exported.GH_REPO ?? env.GH_REPO
    const unknownDir = deny('cannot tell which repo this command runs in (a `cd` or `-C` the gate cannot resolve).', `Run it from the repo's directory. ${LITERAL}`)
    let reason = null
    if (word === 'gh') {
      const g = positionalIndex(args, GH_GLOBAL_VALUE, 0)
      const v = positionalIndex(args, GH_GLOBAL_VALUE, 1)
      const group = g >= 0 ? args[g] : null
      const verb = v >= 0 ? args[v] : null
      // gh takes -R anywhere: every argument but the group and verb words.
      const own = args.filter((_, i) => i !== g && i !== v)
      if (group === 'pr' && (verb === 'create' || verb === 'new')) reason = dir ? prCreate(dir, own, ghRepo) : unknownDir
      else if (group === 'pr' && verb === 'merge') reason = dir ? prMerge(dir, own, ghBin, ghRepo) : unknownDir
      else if (group === 'api') reason = ghApi(args.filter((_, i) => i !== g))
      else if (group === 'alias' && (verb === 'set' || verb === 'import')) {
        if (verb === 'import' || /\b(pr\s+(create|new|merge)|api)\b/.test(args.join(' '))) reason = deny('a gh alias for opening or merging PRs would skip the review check.', 'Use `gh pr create` / `gh pr merge` directly.')
      }
    } else if (word === 'hub') {
      const sub = args.find(a => !a.startsWith('-'))
      if (['pull-request', 'merge', 'api'].includes(sub)) reason = deny('`hub` opens or merges PRs without the review check.', 'Use `gh pr create` / `gh pr merge`.')
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
