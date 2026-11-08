// land.mjs — one unattended `/bughunt --fix` landing, apart from how its session
// runs. The caller (the /build-app driver, autobuild) starts the headless session
// itself; this module does everything around it, so every caller lands a hunt
// through the same checks:
//
//   prepareHunt   intake, set aside what an earlier hunt left, make the fix worktree
//   bughuntPrompt what the session is told (it only runs the hunt graph)
//   readHunt      what the session saved, and whether it finished at this head
//   bughuntChecks the caller's own checks on the fix branch before it lands
//   landHunt      the checks, then a fast-forward onto the branch, then cleanup
//   bughuntLine   one paragraph on what was found, fixed, and left open
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, run, tail } from '../../../build/skills/build-app/driver/proc.mjs'
import { readLedger, disposition } from '../../../../core/skills/findings/findings.mjs'

const INTAKE = join(dirname(fileURLToPath(import.meta.url)), 'intake.mjs')
// Git in a worktree the hunt wrote: no repo hooks, no fsmonitor.
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

// Runs intake for `target` against `base` and makes the fix worktree on
// bughunt/<key> at the target's head. What an earlier hunt left is set aside,
// never lost: its uncommitted work is committed onto its branch, the branch is
// kept as attempt/bughunt-<stamp>, and its ledger is archived (its fixes are not
// on the new branch, so it starts over).
// Returns one of:
//   {skip: reason}                          nothing to review
//   {error: 'intake', detail}               intake failed (its last line)
//   {error: 'intake-json', detail}          intake wrote no readable intake.json
//   {error: 'worktree', branch}             git refused the fix worktree
//   {stateDir, key, branch, fixDir, head}   ready for the session
export function prepareHunt({ repo, target, base, stamp, log = () => {} }) {
  const intake = run(process.execPath, [INTAKE, repo, '--branch', target, '--base', base], { cwd: repo })
  const last = intake.out.trim().split('\n').pop() || ''
  if (/nothing to review/.test(last)) return { skip: last.replace(/^INTAKE: FAIL /, '') }
  if (!last.startsWith('INTAKE: OK')) return { error: 'intake', detail: last }
  const stateDir = dirname(intake.stdout.split('\n')[0].trim())
  let key
  try { key = JSON.parse(readFileSync(join(stateDir, 'intake.json'), 'utf8')).key } catch (e) { return { error: 'intake-json', detail: e.message } }
  const branch = `bughunt/${key}`
  const fixDir = join(stateDir, 'fix')
  const head = git(repo, ['rev-parse', target]).stdout.trim()
  if (existsSync(fixDir) && git(fixDir, [...SAFE, 'status', '--porcelain']).stdout.trim()) {
    git(fixDir, [...SAFE, 'add', '-A'])
    git(fixDir, [...SAFE, '-c', 'user.name=bughunt', '-c', 'user.email=bughunt@localhost', 'commit', '-q', '--no-verify', '-m', 'bughunt: uncommitted work an earlier hunt left'])
  }
  if (existsSync(fixDir)) git(repo, ['worktree', 'remove', '--force', fixDir])
  git(repo, ['worktree', 'prune'])
  if (git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).ok) {
    if (git(repo, ['rev-list', '--count', `${target}..${branch}`]).stdout.trim() !== '0') {
      git(repo, ['branch', '-q', '-f', `attempt/bughunt-${stamp}`, branch])
      log(`bughunt: kept what an earlier hunt left on ${branch} as attempt/bughunt-${stamp}`)
    }
    git(repo, ['branch', '-q', '-D', branch])
  }
  if (existsSync(join(stateDir, 'ledger.json'))) renameSync(join(stateDir, 'ledger.json'), join(stateDir, `ledger-${stamp}.json`))
  if (!git(repo, [...SAFE, 'worktree', 'add', '-q', '-b', branch, fixDir, head]).ok) return { error: 'worktree', branch }
  return { stateDir, key, branch, fixDir, head }
}

// Keeps the hunt's branch as attempt/bughunt-<stamp> and returns that name.
export function keepAttempt(repo, branch, stamp) {
  const kept = `attempt/bughunt-${stamp}`
  git(repo, ['branch', '-q', '-f', kept, branch])
  return kept
}

// What the session saved: {ledger, lastRun, finished}. finished means its last
// run is done at `head`, the commit the hunt was prepared at.
export function readHunt({ stateDir, key, head }) {
  let ledger = null
  try { ledger = readLedger(join(stateDir, 'ledger.json'), key) } catch { ledger = null }
  const lastRun = ledger && ledger.runs.length ? ledger.runs[ledger.runs.length - 1] : null
  return { ledger, lastRun, finished: Boolean(lastRun && lastRun.status === 'done' && lastRun.head === head) }
}

// The fix commits the ledger calls verified.
export function verifiedCommits(ledger) {
  return ledger.findings.filter(f => !f.stale && f.fix_status === 'verified' && f.fix_artifact && f.fix_artifact.commit).map(f => f.fix_artifact.commit)
}

// What the hunt session is told: the caller already ran intake and made the fix
// worktree, so the session only runs the hunt graph in fix mode and writes its
// results into the state dir (the one place in .git the guard opens).
export function bughuntPrompt({ repo, stateDir, configDir, branch, label = 'an unattended /build-app build', scope = 'the whole integration branch' }) {
  // Shell lines get single-quoted paths ($ and backticks stay literal); the
  // Workflow args are JSON.
  const q = p => `'${String(p).replace(/'/g, `'\\''`)}'`
  const j = p => JSON.stringify(p)
  const findings = join(configDir, 'skills', 'findings', 'findings.mjs')
  const evidence = join(configDir, 'skills', 'bughunt', 'evidence.mjs')
  return [
    `Bug hunt of ${label}, in fix mode, over ${scope}. These instructions are your opt-in to the Workflow tool for this one run.`,
    `The driver already ran intake and made the fix worktree ${j(join(stateDir, 'fix'))} on ${branch}. Do not run intake.mjs, and never create, remove, or switch a worktree or branch.`,
    `1. node ${q(findings)} input ${q(join(stateDir, 'ledger.json'))} ${q(join(stateDir, 'intake.json'))} ${q(join(stateDir, 'input.json'))}`,
    `2. node ${q(join(configDir, 'skills', 'workflow-state', 'run-script.mjs'))} INJECTED_INPUT ${q(join(stateDir, 'input.json'))} ${q(join(configDir, 'workflows', 'bughunt-flow.js'))} ${q(join(stateDir, 'run.js'))}; its output must start with "run-script: wrote".`,
    `3. Run the Workflow tool with scriptPath set to the path it printed, and args {"repo": ${j(repo)}, "tree": ${j(join(stateDir, 'tree'))}, "configDir": ${j(configDir)}, "stateDir": ${j(stateDir)}, "mode": "fix", "fixBranch": ${j(branch)}}.`,
    '   It runs in the background and notifies you when it completes: wait for that notification, never a ScheduleWakeup or a sleep.',
    `4. Write the ledger it returns, as JSON, to ${join(stateDir, 'result.json')}.`,
    `5. node ${q(findings)} save ${q(join(stateDir, 'ledger.json'))} ${q(join(stateDir, 'intake.json'))} ${q(join(stateDir, 'result.json'))} --repo ${q(join(stateDir, 'tree'))}`,
    `6. node ${q(evidence)} recheck ${q(stateDir)} (with the Bash tool's timeout set to 600000 ms)`,
    `7. node ${q(findings)} report ${q(join(stateDir, 'ledger.json'))} ${q(join(stateDir, 'evidence'))} > ${q(join(stateDir, 'report.md'))}`,
    'Never push, never commit yourself, never switch branches, never ask a question. Then stop.',
  ].join('\n')
}

// The caller's own checks on the hunt's fix branch before it lands: every
// commit is one evidence.mjs fix commit that the ledger still calls verified,
// no frozen file changed, the worktree is clean, and its own verify passes on
// the branch, run in the repo itself (where the dependencies are installed),
// with the branch checked out detached and `integration` checked out again after.
// `frozen` lists exact paths; a file the fixes add is never in it.
// Returns {problems, commits}.
export function bughuntChecks({ repo, integration, branch, worktree, frozen, verifyCommand, verified = [], verifyTimeoutMs = 40 * 60_000 }) {
  const problems = []
  if (!git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).ok) return { problems: [`no branch ${branch}`], commits: 0 }
  if (!git(repo, ['merge-base', '--is-ancestor', integration, branch]).ok) problems.push(`${branch} does not build on ${integration}, so it cannot be fast-forwarded`)
  const subjects = git(repo, ['log', '--format=%s', `${integration}..${branch}`]).stdout.split('\n').filter(Boolean)
  const foreign = subjects.filter(s => !/^bughunt: fix F[1-9][0-9]*$/.test(s))
  if (foreign.length) problems.push(`commits that are not "bughunt: fix F<n>": ${foreign.map(s => JSON.stringify(s)).join(', ')}`)
  const shas = git(repo, ['rev-list', `${integration}..${branch}`]).stdout.split('\n').filter(Boolean)
  const unverified = shas.filter(sha => !verified.includes(sha))
  if (!foreign.length && unverified.length) problems.push(`fix commits the hunt's ledger does not call verified: ${unverified.map(s => s.slice(0, 7)).join(', ')}`)
  const changed = git(repo, ['diff', '--name-only', '--no-renames', `${integration}...${branch}`]).stdout.split('\n').filter(Boolean)
  const touchedFrozen = changed.filter(f => frozen.includes(f))
  if (touchedFrozen.length) problems.push(`frozen tests from earlier slices changed: ${touchedFrozen.join(', ')}`)
  if (existsSync(worktree)) {
    const dirty = git(worktree, [...SAFE, 'status', '--porcelain']).stdout.trim()
    if (dirty) problems.push(`the fix worktree has uncommitted changes:\n${tail(dirty, 15)}`)
  }
  if (!problems.length && subjects.length) {
    if (!git(repo, [...SAFE, 'checkout', '-q', '--detach', branch]).ok) return { problems: [`could not check out ${branch} to verify it`], commits: subjects.length }
    try {
      const v = run('bash', ['-c', verifyCommand], { cwd: repo, timeoutMs: verifyTimeoutMs })
      const last = v.out.trimEnd().split('\n').pop() || ''
      if (last !== 'VERIFY: PASS') problems.push(`the driver's own verify did not pass on ${branch} (last line ${JSON.stringify(last)}):\n${tail(v.out, 30)}`)
      const left = git(repo, ['status', '--porcelain']).stdout.trim()
      if (left) problems.push(`the driver's own verify left files git does not ignore: ${left.split('\n').map(l => l.slice(3)).join(', ')}`)
    } finally {
      git(repo, [...SAFE, 'checkout', '-q', '-f', integration])
    }
  }
  return { problems, commits: subjects.length }
}

// Lands a finished hunt: bughuntChecks, then a fast-forward of `integration` to
// the fix branch when it has commits, then the worktree and branch go. Returns
// {problems} when the checks refuse it, {ffFailed: true} when git refuses the
// fast-forward, else {commits}. `stopped()` is asked once the checks are done.
export function landHunt({ repo, integration, prep, frozen, verifyCommand, ledger, stopped = () => false }) {
  const checks = bughuntChecks({ repo, integration, branch: prep.branch, worktree: prep.fixDir, frozen, verifyCommand, verified: verifiedCommits(ledger) })
  if (stopped()) return { stopped: true }
  if (checks.problems.length) return { problems: checks.problems }
  if (checks.commits && !(git(repo, ['checkout', '-q', integration]).ok && git(repo, [...SAFE, 'merge', '-q', '--ff-only', prep.branch]).ok)) return { ffFailed: true }
  git(repo, ['worktree', 'remove', '--force', prep.fixDir])
  git(repo, ['branch', '-q', '-D', prep.branch])
  return { commits: checks.commits }
}

// One paragraph from the hunt's ledger: what was found, what was fixed (now in
// this branch), and what is left for the reviewer.
export function bughuntLine(ledger, landed) {
  const live = ledger.findings.filter(f => !f.stale)
  const real = live.filter(f => ['reproduced', 'confirmed'].includes(f.verification_status))
  const fixed = real.filter(f => f.fix_status === 'verified')
  const open = real.filter(f => f.fix_status !== 'verified')
  const unverified = live.filter(f => ['candidate', 'contested', 'not_reproduced'].includes(f.verification_status))
  const lines = [`The bug hunt (\`/bughunt --fix\`) ran over the whole branch: ${real.length} confirmed bug(s), ${live.filter(f => f.verification_status === 'reproduced').length} of them reproduced by a failing test; ${fixed.length} fixed and independently verified${landed ? ' (in this branch, one `bughunt: fix F<n>` commit each, with its regression test)' : ''}.`]
  for (const f of open) lines.push(`- **Still open:** ${f.finding_id} [${f.severity}] ${f.title} (\`${f.file_path}:${f.line_range[0]}\`; ${f.verification_status}, fix ${f.fix_status}${f.fix_artifact && f.fix_artifact.last_feedback ? `: ${f.fix_artifact.last_feedback}` : ''})`)
  if (unverified.length) lines.push(`- ${unverified.length} more finding(s) were not confirmed; see the hunt's report.`)
  // A hunt that did not cover everything is never reported as clean.
  const d = residualDisposition(ledger)
  if (d.disposition !== 'pass') lines.push(`- **Disposition: ${d.disposition.replace('_', ' ')}** (${d.because.join(', ')}).`)
  const run_ = ledger.runs && ledger.runs.length ? ledger.runs[ledger.runs.length - 1] : null
  if (run_ && run_.budget_stop) lines.push(`- The hunt stopped before ${run_.budget_stop}: its token budget was nearly spent.`)
  return lines.join('\n')
}

// The disposition once the verified fixes have landed: those findings no longer count.
export function residualDisposition(ledger) {
  const fixedIds = new Set(ledger.findings.filter(f => !f.stale && ['reproduced', 'confirmed'].includes(f.verification_status) && f.fix_status === 'verified').map(f => f.finding_id))
  return disposition({ ...ledger, findings: ledger.findings.filter(f => !fixedIds.has(f.finding_id)) })
}
