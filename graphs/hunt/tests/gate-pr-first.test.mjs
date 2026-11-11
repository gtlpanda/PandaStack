// Ordinary local Git fixtures; gate decisions only, no GitHub mutation.
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { gateDecision } from '../skills/bughunt/gate.mjs'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
function fixture(work) {
  const repo = mkdtempSync(join(tmpdir(), 'draft-gate-'))
  const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, env: ENV, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  const config = value => writeFileSync(join(repo, 'autobuild.json'), typeof value === 'string' ? value : JSON.stringify(value))
  const decide = (command, cwd = repo) => gateDecision(command, cwd, { env: { PANDASTACK_REVIEW_GATE: '1', PANDASTACK_GATE_GH: '/no/real/gh' } })
  try {
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'app.js'), 'export const value = 1\n')
    git('add', '.'); git('commit', '-qm', 'base')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    git('remote', 'add', 'origin', 'git@github.com:acme/widget.git')
    git('checkout', '-qb', 'feature')
    writeFileSync(join(repo, 'app.js'), 'export const value = 2\n')
    git('add', '.'); git('commit', '-qm', 'ordinary change')
    config({ deliveryMode: 'pr-first' })
    work({ repo, git, config, decide })
  } finally { rmSync(repo, { recursive: true, force: true }) }
}
await test('PR-first permits correctly scoped draft creation, including a repository subdirectory', () => fixture(({ repo, decide }) => {
  mkdirSync(join(repo, 'nested'))
  for (const cmd of ['gh pr create --draft --base main --head feature', 'gh pr new -d -B main -H acme:feature', 'gh --repo acme/widget pr create --draft=true', 'gh pr create --draft --repo=acme/widget']) assert.equal(decide(cmd), null, cmd)
  assert.equal(decide('gh pr create --draft', join(repo, 'nested')), null)
}))
await test('PR-first keeps repo/head/base and literal checks before draft permission', () => fixture(({ decide }) => {
  for (const cmd of ['gh pr create --draft -R other/repo', 'GH_REPO=other/repo gh pr new --draft', 'gh pr create --draft --head other:feature', 'gh pr create --draft --head missing', 'gh pr create --draft --base missing', 'gh pr create --draft --head "$BRANCH"', 'gh pr create --draft --base "$BASE"', 'gh pr create --draft -H feature --head other', 'gh pr create --draft -R acme/widget --repo other/repo', 'gh pr create --draft -B main --base missing']) assert.ok(decide(cmd), cmd)
}))
await test('Only explicit draft opt-in relaxes creation; ordinary and invalid config behavior stays gated', () => fixture(({ config, decide }) => {
  for (const cmd of ['gh pr create', 'gh pr create --draft=false', 'gh pr create -d --draft=false', 'gh pr create --draft=$DRAFT']) assert.match(decide(cmd), /no finished \/bughunt/)
  for (const value of [{}, { deliveryMode: 'full' }, { deliveryMode: 'unknown' }, '{']) {
    config(value); assert.match(decide('gh pr create --draft'), /no finished \/bughunt/)
  }
}))
await test('PR-first draft permission never permits merge, protected push, API writes or aliases', () => fixture(({ decide }) => {
  for (const cmd of ['gh pr merge 1 --squash', 'git push origin HEAD:main', 'gh api repos/acme/widget/pulls -f title=x -f head=feature -f base=main', 'gh alias set draft "pr create --draft"', 'gh pr create --draft && git push origin HEAD:main']) assert.ok(decide(cmd), cmd)
}))
