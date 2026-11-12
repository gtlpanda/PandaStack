// gate.test.mjs — the review gate (graphs/hunt/skills/bughunt/gate.mjs) and
// the coverage check under it (review-status.mjs), over throwaway git repos
// with hand-written /bughunt ledgers and a fake gh.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { gateDecision, repoSlug } from '../skills/bughunt/gate.mjs'
import { reviewStatus, isDocPath } from '../skills/bughunt/review-status.mjs'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'bughunt', 'gate.mjs')
const INTAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'bughunt', 'intake.mjs')
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const put = (repo, file, text) => { mkdirSync(dirname(join(repo, file)), { recursive: true }); writeFileSync(join(repo, file), text) }
const commit = (repo, files, msg) => { for (const [f, t] of Object.entries(files)) put(repo, f, t); sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', msg); return sh(repo, 'rev-parse', 'HEAD') }

function finding(id, over = {}) {
  return {
    finding_id: id, title: `bug ${id}`, description: 'd', file_path: 'src/a.js', line_range: [1, 1], bug_category: 'logic', severity: 'HIGH', confidence: 90,
    expected_behavior: 'e', actual_behavior: 'a', failure_scenario: { trigger: 't', path: 'p', observable: 'o' }, evidence: [{ file: 'src/a.js', line: 1, quote: 'q' }],
    verification_status: 'reproduced', fix_status: 'none', head: 'x', history: [], test_results: [], ...over,
  }
}
// A ledger whose latest run ended `status` at `head`, having hunted from
// mergeBase (default: where head leaves main).
function ledger(repo, key, head, { findings = [], status = 'done', mergeBase = null, pr = null } = {}) {
  const common = sh(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const from = mergeBase || sh(repo, 'merge-base', 'main', head)
  const l = { version: 1, key, target: { kind: pr ? 'pr' : 'branch', pr, head, mergeBase: from }, findings, coverage: [], routing: null, status, reason: null, runs: [{ at: '2026-11-07T00:00:00Z', mode: 'discover', head, status }] }
  put(common, `bughunt/${key}/ledger.json`, JSON.stringify(l))
}

// main with src/a.js pushed to a bare origin (origin/HEAD -> main); branch feat with one code commit.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gate-test-'))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  sh(root, 'init', '-q', '--bare', 'origin.git')
  sh(repo, 'init', '-q', '-b', 'main')
  commit(repo, { 'src/a.js': 'export const a = 1\n', 'README.md': '# r\n' }, 'base')
  sh(repo, 'remote', 'add', 'origin', join(root, 'origin.git'))
  sh(repo, 'push', '-q', 'origin', 'main')
  sh(repo, 'remote', 'set-head', 'origin', 'main')
  sh(repo, 'checkout', '-q', '-b', 'feat')
  const head = commit(repo, { 'src/a.js': 'export const a = 2\n' }, 'change')
  return { root, repo, head }
}
function fakeGh(root, pr) {
  const f = join(root, 'gh')
  writeFileSync(f, pr === null ? '#!/bin/sh\necho "no PR" >&2\nexit 1\n' : `#!/bin/sh\necho '${JSON.stringify(pr)}'\n`)
  chmodSync(f, 0o755)
  return f
}

console.log('== review status: which hunts cover which commits')
await test('documentation paths', () => {
  for (const p of ['README.md', 'docs/x/y.png', 'changelogs/2026-11-07.md', 'LICENSE', 'sub/LICENSE.txt', 'a/B.MD', 'CLAUDE.md', 'docs/commands/init.md', 'graphs/x/agents/a.md']) assert.ok(isDocPath(p), p)
  for (const p of ['src/a.js', 'package.json', 'docsite/x.js', 'tests/a.test.js', 'README.md.js', '.github/workflows/test.yml', 'mydocs/a.js',
    // Code under docs/, and markdown Claude Code runs (.claude/), are not documentation (review of #34).
    'docs/conf.py', 'docs/.vitepress/config.js', 'docs/package.json', 'docs/openapi.yaml', '.claude/agents/merger.md', '.claude/commands/x.md', 'sub/.claude/settings.json']) assert.ok(!isDocPath(p), p)
})
await test('no ledger: not hunted; a finished hunt at the exact head: hunted, its disposition', () => {
  const { repo, head } = fixture()
  assert.equal(reviewStatus(repo, head).hunted, false)
  ledger(repo, 'feat-abc123', head)
  const s = reviewStatus(repo, head)
  assert.equal(s.hunted, true)
  assert.equal(s.disposition, 'pass')
  assert.deepEqual(s.exempt, [])
})
await test('after the hunted head, docs-only commits are exempt; a code commit, a merge, or too old a hunt is not', () => {
  const { repo, head } = fixture()
  ledger(repo, 'k', head)
  const docs = commit(repo, { 'docs/notes.md': 'n\n', 'CHANGELOG.md': 'c\n' }, 'docs')
  const s = reviewStatus(repo, docs)
  assert.equal(s.hunted, true)
  assert.deepEqual(s.exempt.map(e => e.because), ['docs only'])
  const code = commit(repo, { 'src/b.js': 'x\n' }, 'more code')
  assert.equal(reviewStatus(repo, code).hunted, false, 'new code after the hunt is unreviewed')
  // A merge commit can bring in anything, even when its own diff looks small.
  const { repo: r2, head: h2 } = fixture()
  ledger(r2, 'k', h2)
  sh(r2, 'checkout', '-q', '-b', 'side', 'main')
  commit(r2, { 'docs/side.md': 's\n' }, 'side docs')
  sh(r2, 'checkout', '-q', 'feat')
  sh(r2, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
  assert.equal(reviewStatus(r2, sh(r2, 'rev-parse', 'HEAD')).hunted, false)
})
await test('a hunt whose last run did not finish covers nothing', () => {
  const { repo, head } = fixture()
  ledger(repo, 'k', head, { status: 'escalate' })
  assert.equal(reviewStatus(repo, head).hunted, false)
})
await test('the verified repair commit (or the same patch) is exempt and closes its finding; a commit that only borrows the subject is not', () => {
  const { repo, head } = fixture()
  const fixed = commit(repo, { 'src/a.js': 'export const a = 3\n' }, 'bughunt: fix F1')
  const findings = [finding('F1', { fix_status: 'verified', fix_artifact: { commit: fixed, branch: 'bughunt/k' } }), finding('F2', { fix_status: 'rejected', severity: 'MEDIUM' })]
  ledger(repo, 'k', head, { findings })
  assert.equal(reviewStatus(repo, head).disposition, 'changes_requested', 'at the hunted head both bugs are open')
  const s = reviewStatus(repo, fixed)
  assert.equal(s.hunted, true)
  assert.deepEqual(s.exempt.map(e => e.because), ['verified repair of F1'])
  assert.deepEqual(s.because, ['F2'], 'F1 is fixed in this commit; F2 is still open')
  // An empty commit, or other code, under the same subject proves nothing (review of #34).
  const { repo: r2, head: h2 } = fixture()
  const real = commit(r2, { 'src/a.js': 'export const a = 3\n' }, 'bughunt: fix F1')
  ledger(r2, 'k', h2, { findings: [finding('F1', { fix_status: 'verified', fix_artifact: { commit: real } })] })
  sh(r2, 'reset', '-q', '--hard', h2)
  sh(r2, 'commit', '-q', '--allow-empty', '-m', 'bughunt: fix F1')
  assert.equal(reviewStatus(r2, sh(r2, 'rev-parse', 'HEAD')).hunted, false, 'an empty "fix" is new, unreviewed history')
  sh(r2, 'reset', '-q', '--hard', h2)
  const evil = commit(r2, { 'src/evil.js': 'x\n' }, 'bughunt: fix F1')
  assert.equal(reviewStatus(r2, evil).hunted, false)
  // The same patch cherry-picked (a new commit id) is still the verified repair.
  sh(r2, 'reset', '-q', '--hard', h2)
  sh(r2, 'cherry-pick', '-x', real)
  const picked = sh(r2, 'rev-parse', 'HEAD')
  assert.notEqual(picked, real)
  const p = reviewStatus(r2, picked)
  assert.equal(p.hunted, true)
  assert.equal(p.disposition, 'pass', 'the fix is in this commit')
  assert.match(p.exempt[0].because, /same patch/)
})
await test('a hunt of only part of the branch covers nothing; several covering hunts give the worst result, or this PR\'s', () => {
  const { repo, head } = fixture()
  const second = commit(repo, { 'src/b.js': 'b\n' }, 'second')
  ledger(repo, 'range', second, { mergeBase: head })
  assert.equal(reviewStatus(repo, second, { base: 'origin/main' }).hunted, false, 'the first commit was never hunted')
  assert.equal(reviewStatus(repo, second).hunted, true, 'with no base to compare, the range is not checked')
  ledger(repo, 'aaa', second)
  ledger(repo, 'zzz', second, { findings: [finding('F1')] })
  assert.equal(reviewStatus(repo, second, { base: 'origin/main' }).disposition, 'changes_requested', 'the worst of two hunts at one head')
  ledger(repo, 'pr-4', second, { pr: 4 })
  const s = reviewStatus(repo, second, { base: 'origin/main', pr: 4 })
  assert.equal(s.key, 'pr-4')
  assert.equal(s.disposition, 'pass', 'the hunt of this very PR decides')
})
await test('a rename from code into docs is not a documentation-only change', () => {
  const { repo } = fixture()
  sh(repo, 'checkout', '-q', '-b', 'ren', 'main')
  mkdirSync(join(repo, 'docs'), { recursive: true })
  sh(repo, 'mv', 'src/a.js', 'docs/a.md')
  sh(repo, 'commit', '-qm', 'move')
  assert.equal(reviewStatus(repo, 'ren', { base: 'origin/main' }).docsOnly, false)
})
await test('a change that is documentation only from its base needs no hunt', () => {
  const { repo } = fixture()
  sh(repo, 'checkout', '-q', '-b', 'docs-only', 'main')
  const d = commit(repo, { 'README.md': '# better\n' }, 'docs')
  assert.equal(reviewStatus(repo, d, { base: 'origin/main' }).docsOnly, true)
  assert.equal(reviewStatus(repo, d).docsOnly, false, 'without a base, no exemption')
  assert.match(reviewStatus(repo, 'deadbeef').reason, /not a commit/)
})

await test('a hunt that skipped declared evidence covers the real head; a later evidence-only commit still needs a hunt', () => {
  const { repo } = fixture()
  sh(repo, 'checkout', '-q', 'main')
  commit(repo, { '.gitattributes': 'runs/*/evidence/** bughunt-skip\n' }, 'declare evidence')
  sh(repo, 'checkout', '-q', 'feat')
  sh(repo, 'rebase', '-q', 'main')
  const head = commit(repo, { 'runs/r1/evidence/gate.json': '{"ok":true}\n', 'runs/r1/evidence/check.mjs': 'export {}\n', 'src/b.js': 'export const b = 1\n' }, 'code and evidence')
  const intake = spawnSync('node', [INTAKE, repo, '--range', 'main..feat'], { encoding: 'utf8', env: ENV })
  assert.equal(intake.status, 0, intake.stdout + intake.stderr)
  assert.match(intake.stdout, /INTAKE: OK .* skipped=1 /)
  const state = JSON.parse(readFileSync(intake.stdout.split('\n')[0].trim(), 'utf8'))
  assert.equal(state.target.head, head, 'the hunt targets the real head, skips or not')
  assert.deepEqual(JSON.parse(readFileSync(state.target.skipped.list, 'utf8')).files.map(s => s.path), ['runs/r1/evidence/gate.json'], 'code inside the evidence dir is hunted')
  ledger(repo, state.key, state.target.head, { mergeBase: state.target.mergeBase })
  assert.equal(reviewStatus(repo, head, { base: 'main' }).hunted, true)
  const later = commit(repo, { 'runs/r1/evidence/gate.json': '{"ok":false}\n' }, 'more evidence')
  const s = reviewStatus(repo, later, { base: 'main' })
  assert.equal(s.hunted, false, 'a skip never widens what counts as exempt after the hunt')
})
console.log('== the gate: gh pr create')
await test('opening a PR needs a finished hunt over its head; docs-only, dry runs, and the web flow pass', () => {
  const { root, repo, head } = fixture()
  for (const cmd of ['gh pr create --title x --body y', 'gh pr new -t x -b y', 'gh pr create --fill --base main']) {
    assert.match(gateDecision(cmd, repo) || '', /no finished \/bughunt covers feat/, cmd)
  }
  assert.match(gateDecision('gh pr create', repo), /Run `\/bughunt feat`/, 'it says what to run')
  assert.match(gateDecision('gh pr create', repo), /PANDASTACK_REVIEW_GATE=0/, 'and how a person overrides it')
  assert.equal(gateDecision('gh pr create --dry-run', repo), null)
  ledger(repo, 'feat-k', head)
  assert.equal(gateDecision('gh pr create --title x', repo), null)
  // --head names the branch, also as owner:branch; the checked-out branch does not matter then.
  sh(repo, 'checkout', '-q', '-b', 'other', 'main')
  commit(repo, { 'src/o.js': 'o\n' }, 'other code')
  assert.match(gateDecision('gh pr create', repo), /covers other/)
  assert.equal(gateDecision('gh pr create --head feat', repo), null)
  assert.match(gateDecision('gh pr create -H someone:feat', repo), /a branch of another fork/, 'a fork\'s branch has no record here (review of #34)')
  assert.match(gateDecision('gh pr create --head nope', repo), /branch nope is not in this clone/)
  sh(repo, 'checkout', '-q', '-b', 'docs-only', 'main')
  commit(repo, { 'docs/x.md': 'x\n' }, 'docs')
  assert.equal(gateDecision('gh pr create', repo), null, 'documentation needs no hunt')
  assert.match(gateDecision('gh pr create', root) || '', /cannot tell which branch|not in this clone|could not|cannot/, 'outside a repo it does not allow')
})
await test('-R must be this checkout\'s own repo', () => {
  const { repo, head } = fixture()
  ledger(repo, 'k', head)
  assert.match(gateDecision('gh pr create -R someone/else', repo), /names a repo other than this checkout/)
  assert.match(gateDecision('gh -R someone/else pr create', repo), /names a repo other than this checkout/)
  sh(repo, 'remote', 'set-url', 'origin', 'git@github.com:Acme/widget.git')
  assert.equal(gateDecision('gh pr create -R acme/widget', repo), null)
  assert.equal(gateDecision('gh pr create --repo=https://github.com/acme/widget', repo), null)
  assert.equal(repoSlug('https://github.com/Acme/Widget.git'), 'acme/widget')
  assert.equal(repoSlug('github.com/acme/widget'), 'acme/widget')
  assert.equal(repoSlug(''), null)
})

await test('GH_REPO, and -R between the group and the verb, are checked like -R', () => {
  const { root, repo, head } = fixture()
  ledger(repo, 'pr-5', head, { pr: 5 })
  const env = { ...process.env, PANDASTACK_GATE_GH: fakeGh(root, { number: 5, headRefOid: head, baseRefName: 'main' }) }
  for (const cmd of ['gh pr -R other/repo merge 5', 'GH_REPO=other/repo gh pr merge 5 --squash', 'export GH_REPO=other/repo; gh pr merge 5', 'GH_REPO=other/repo gh pr create --title x', 'gh pr -R other/repo create --title x', 'env GH_REPO=other/repo gh pr merge 5']) {
    assert.match(gateDecision(cmd, repo, { env }) || '', /names a repo other than this checkout/, cmd)
  }
  assert.match(gateDecision('gh pr merge 5', repo, { env: { ...env, GH_REPO: 'other/repo' } }), /GH_REPO=other\/repo/, 'GH_REPO in the session itself')
  assert.match(gateDecision('GH_REPO=$R gh pr merge 5', repo, { env }), /literal value/)
  assert.equal(gateDecision('gh pr merge 5 --squash', repo, { env }), null)
})
await test('when the local branch and origin differ, both must be covered; $VARIABLES are not guessed', () => {
  const { root, repo, head } = fixture()
  ledger(repo, 'k', head)
  sh(repo, 'push', '-q', 'origin', 'feat')
  commit(repo, { 'src/u.js': 'u\n' }, 'unreviewed')
  sh(repo, 'push', '-q', 'origin', 'feat')
  sh(repo, 'reset', '-q', '--hard', head)
  sh(repo, 'checkout', '-q', 'main')
  assert.match(gateDecision('gh pr create --head feat --title x', repo), /origin\/feat/, 'origin/feat holds an unreviewed commit')
  assert.match(gateDecision('gh pr create --head "bughunt/$KEY"', repo), /literal value/)
  assert.match(gateDecision('gh pr create --head feat --base release/9', repo), /base release\/9 is not in this clone/, 'an unknown base is not a pass (review of #34)')
  assert.match(gateDecision('gh pr merge 5 --match-head-commit "$SHA"', repo, { env: { ...process.env, PANDASTACK_GATE_GH: fakeGh(root, null) } }), /literal value/)
  assert.match(gateDecision('git -C "$REPO" push -u origin bughunt/x', repo), /literal value/)
  // A fork-qualified head of this very repo's owner is this clone's branch.
  sh(repo, 'push', '-q', '-f', 'origin', 'feat')
  sh(repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/widget.git')
  assert.equal(gateDecision('gh pr create -H acme:feat --title x', repo), null)
})

await test('origin behind a hunted local branch: the denial says to push, not to hunt again', () => {
  const { repo, head } = fixture()
  sh(repo, 'reset', '-q', '--hard', 'HEAD~1')
  commit(repo, { 'src/a.js': 'export const a = 0\n' }, 'first')
  sh(repo, 'push', '-q', 'origin', 'feat')
  const hunted = commit(repo, { 'src/b.js': 'b\n' }, 'second')
  ledger(repo, 'k', hunted)
  assert.match(gateDecision('gh pr create --title x', repo), /origin\/feat is behind the hunted commit.*Push feat/)
  assert.ok(head)
})

console.log('== the gate: gh pr merge')
await test('merging needs a covering hunt whose result is pass', () => {
  const { root, repo, head } = fixture()
  const env = pr => ({ ...process.env, PANDASTACK_GATE_GH: fakeGh(root, pr) })
  const pr = { number: 7, headRefOid: head, headRefName: 'feat', baseRefName: 'main' }
  assert.match(gateDecision('gh pr merge 7 --squash', repo, { env: env(pr) }), /no finished \/bughunt covers PR #7.*Run `\/bughunt 7`/)
  ledger(repo, 'pr-7', head, { findings: [finding('F3')] })
  assert.match(gateDecision('gh pr merge 7 --squash', repo, { env: env(pr) }), /is changes_requested: F3.*\/bughunt 7 --fix/)
  ledger(repo, 'pr-7', head, { findings: [finding('F3', { verification_status: 'candidate' })] })
  assert.match(gateDecision('gh pr merge 7', repo, { env: env(pr) }), /manual_review/)
  ledger(repo, 'pr-7', head)
  assert.equal(gateDecision('gh pr merge 7 --squash --delete-branch', repo, { env: env(pr) }), null)
  assert.equal(gateDecision('gh pr merge --squash', repo, { env: env(pr) }), null, 'no argument: the current branch\'s PR')
})
await test('the pinned head wins; an unreadable or missing head is denied', () => {
  const { root, repo, head } = fixture()
  ledger(repo, 'k', head)
  const noGh = { ...process.env, PANDASTACK_GATE_GH: fakeGh(root, null) }
  assert.match(gateDecision('gh pr merge 7', repo, { env: noGh }), /could not read the PR/)
  assert.match(gateDecision(`gh pr merge 7 --squash --match-head-commit ${head}`, repo, { env: noGh }), /could not read the PR/, 'without the PR\'s base the hunted range cannot be checked (review of #34)')
  const gh = { ...process.env, PANDASTACK_GATE_GH: fakeGh(root, { number: 7, headRefOid: head, baseRefName: 'main' }) }
  assert.equal(gateDecision(`gh pr merge 7 --squash --match-head-commit ${head}`, repo, { env: gh }), null, 'the merger agent\'s exact form')
  const later = commit(repo, { 'src/c.js': 'c\n' }, 'unreviewed')
  assert.match(gateDecision(`gh pr merge 7 --merge --match-head-commit ${later}`, repo, { env: gh }), /no finished \/bughunt covers/, 'the pinned head wins over gh\'s')
  assert.match(gateDecision('gh pr merge 7 --match-head-commit 1111111111111111111111111111111111111111', repo, { env: gh }), /not in this clone.*git fetch origin pull/)
  const otherBase = { ...process.env, PANDASTACK_GATE_GH: fakeGh(root, { number: 7, headRefOid: head, baseRefName: 'release/9' }) }
  assert.match(gateDecision('gh pr merge 7', repo, { env: otherBase }), /base origin\/release\/9 is not in this clone.*git fetch origin release\/9/)
  assert.equal(gateDecision('gh pr merge 7 --disable-auto', repo, { env: noGh }), null)
})
await test('the release flow: a docs commit after the hunt still merges', () => {
  const { root, repo, head } = fixture()
  ledger(repo, 'pr-9', head)
  const withNotes = commit(repo, { 'changelogs/2026-11-07.md': 'notes\n', 'retro.md': 'r\n', 'CLAUDE.md': '## Deploy Configuration\n' }, 'docs: release notes')
  const env = { ...process.env, PANDASTACK_GATE_GH: fakeGh(root, { number: 9, headRefOid: withNotes, baseRefName: 'main' }) }
  assert.equal(gateDecision(`gh pr merge 9 --squash --match-head-commit ${withNotes}`, repo, { env }), null)
})

console.log('== the gate: other routes to the default branch')
await test('gh api merges are denied; other gh api calls are not', () => {
  const { repo } = fixture()
  for (const cmd of ['gh api -X PUT repos/a/b/pulls/3/merge', "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    // Opening a PR or writing a branch through the API (review of #34).
    'gh api repos/o/r/pulls -f title=x -f head=feat -f base=main', 'gh api -X POST repos/o/r/merges -f base=main -f head=feat',
    'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc -F force=true', 'gh api -X PUT repos/o/r/contents/README.md -f branch=main -f message=m -f content=eA==',
    "gh api graphql -f query='mutation { createPullRequest(input: {}) { clientMutationId } }'"]) {
    assert.match(gateDecision(cmd, repo) || '', /through `gh api` skips the review check/, cmd)
  }
  for (const cmd of ["gh api /graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'", "gh api https://api.github.com/graphql -f query='mutation{mergePullRequest(input:{}){clientMutationId}}'", "gh api 'repos/o/r/pulls?x=1' -X POST -f head=feat -f base=main", 'gh api /repos/o/r/pulls/3/merge -X PUT']) {
    assert.match(gateDecision(cmd, repo) || '', /through `gh api` skips the review check/, cmd)
  }
  assert.match(gateDecision('gh api graphql --input q.json', repo), /read from a file/)
  assert.match(gateDecision('gh api /graphql --input q.json', repo), /read from a file/)
  assert.match(gateDecision('gh api graphql -F query=@merge.graphql', repo), /read from a file/)
  for (const cmd of ['gh api repos/a/b/pulls/3/comments', 'gh api repos/a/b/pulls?state=open', 'gh api repos/a/b/pulls', 'gh api repos/a/b/issues/3/comments -f body=hi', "gh api graphql -f query='{ viewer { login } }'", 'gh api repos/a/b/git/refs/heads/main']) {
    assert.equal(gateDecision(cmd, repo), null, cmd)
  }
  assert.match(gateDecision('hub pull-request -m x', repo), /`hub` opens or merges/)
  assert.match(gateDecision('gh alias set mp "pr merge"', repo), /gh alias/)
  assert.equal(gateDecision('gh alias set co "pr checkout"', repo), null)
})
await test('git push to the default branch is denied in its common spellings; branches, tags, and dry runs pass', () => {
  const { repo } = fixture()
  for (const cmd of ['git push origin HEAD:main', 'git push origin feat:main', 'git push origin +feat:refs/heads/main', 'git push origin main', 'git push --all', 'git push origin --mirror', `git -C ${repo} push origin main`, 'git push -u origin :main',
    // Other spellings git resolves to main (review of #34).
    'git push origin feat:heads/main', 'git push origin :', "git push origin 'refs/heads/*:refs/heads/*'", "git push origin '+refs/heads/*:refs/heads/*'", 'git push --branches origin']) {
    assert.match(gateDecision(cmd, repo) || '', /default branch/, cmd)
  }
  for (const cmd of ['git push origin feat', 'git push -u origin feat', 'git push origin v1.0', 'git push --dry-run origin main', 'git push origin feat:feat']) {
    assert.equal(gateDecision(cmd, repo), null, cmd)
  }
  assert.equal(gateDecision('git push', repo), null, 'on feat, a bare push goes to feat')
  assert.equal(gateDecision('git push origin --tags', repo), null, 'tags only')
  sh(repo, 'checkout', '-q', 'main')
  assert.match(gateDecision('git push', repo), /default branch/, 'on main, a bare push goes to main')
  assert.match(gateDecision('git push origin HEAD', repo), /default branch/)
  assert.equal(gateDecision('git push --tags', repo), null, 'on main, --tags pushes tags only')
  assert.equal(gateDecision('git push origin --tags', repo), null)
})
await test('words in data are not commands; nested and substituted commands are', () => {
  const { repo } = fixture()
  for (const cmd of ['echo "gh pr merge 1"', 'git commit -m "then git push origin main"', 'grep -rn "gh pr create" .', "git commit -F - <<'EOF'\nfix: x\n\ngh pr create later; git push origin main\nEOF", 'ls', 'gh pr view 3', 'gh pr list', 'git status']) {
    assert.equal(gateDecision(cmd, repo), null, cmd)
  }
  for (const cmd of ['bash -c "gh pr create"', 'echo $(gh pr create --fill)', 'true && gh pr create', 'eval gh pr create', 'env FOO=1 gh pr create', 'sh -c \'git push origin main\'',
    // Reserved words, prefix options, combined shell flags, heredocs and pipes into a shell, quoting tricks (review of #34).
    'for n in 5 6; do gh pr create --fill; done', 'if true; then git push origin main; fi', '{ git push origin main; }', '! git push origin main',
    'timeout 30 gh pr create --title x', 'nice -n 5 gh pr create', 'sudo -u bob gh pr create', 'env -u FOO gh pr create', 'bash -lc "gh pr create"', 'sh -ec "git push origin main"',
    "bash <<'EOF'\ngh pr create --fill\nEOF", 'echo "gh pr create --fill" | bash', 'g\\h pr create', "g''h pr create",
    'bash <<< "gh pr create --title x"', 'bash <<< "git push origin main"', 'sh < /tmp/s.sh; gh pr view', 'function f { git push origin main; }; f']) {
    assert.ok(gateDecision(cmd, repo), cmd)
  }
})
await test('a cd before the command is followed; one the gate cannot resolve is denied', () => {
  const { repo, head } = fixture()
  const { repo: unreviewed } = fixture()
  ledger(repo, 'k', head)
  assert.equal(gateDecision('gh pr create', repo), null)
  assert.match(gateDecision(`cd ${unreviewed} && gh pr create`, repo), /no finished \/bughunt covers/)
  assert.equal(gateDecision(`cd ${unreviewed} && cd ${repo} && gh pr create`, repo), null)
  assert.match(gateDecision('cd "$OTHER" && gh pr create', repo), /cannot tell which repo.*literal value/)
  assert.match(gateDecision('cd - && git push origin main', repo), /cannot tell which repo/)
})
await test('the off switch', () => {
  const { repo } = fixture()
  assert.equal(gateDecision('gh pr create', repo, { env: { ...process.env, PANDASTACK_REVIEW_GATE: '0' } }), null)
  assert.ok(gateDecision('gh pr create', repo, { env: { ...process.env, PANDASTACK_REVIEW_GATE: '1' } }))
})

console.log('== the gate as a hook process')
await test('it prints a PreToolUse deny for a gated Bash call, and nothing otherwise', () => {
  const { repo } = fixture()
  const run = input => spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, PANDASTACK_REVIEW_GATE: '' } })
  let r = run({ tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, cwd: repo })
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^review gate: no finished \/bughunt/)
  for (const input of [{ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: repo }, { tool_name: 'Edit', tool_input: { file_path: 'x' }, cwd: repo }, 'not json', { tool_name: 'Bash' }]) {
    r = run(input)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '', JSON.stringify(input))
  }
})
