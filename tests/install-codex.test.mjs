// Codex entry-skill installation is deliberately separate from Claude settings.
import { join, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, readdirSync, existsSync, lstatSync, symlinkSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'

function fixture(fn) {
  const home = mkdtempSync(join(tmpdir(), 'install-codex-'))
  const skills = join(home, '.agents', 'skills')
  const env = { ...process.env, HOME: home, HARNESS_NO_GIT_CONFIG: '1' }
  for (const k of ['CLAUDE_CONFIG_DIR', 'PANDASTACK_BIN_DIR', 'PANDASTACK_CODEX_SKILLS_DIR']) delete env[k]
  const run = (args = [], extra = {}) => spawnSync('bash', [join(REPO, 'install.sh'), '--codex', ...args], { encoding: 'utf8', env: { ...env, ...extra } })
  try { fn({ home, skills, run, env }) } finally { rmSync(home, { recursive: true, force: true }) }
}
const ok = r => assert.equal(r.status, 0, r.stdout + r.stderr)
const isLink = p => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }

test('Codex dry-run changes nothing; install is limited to two skills and idempotent', () => fixture(({ home, skills, run }) => {
  ok(run(['--dry-run']))
  assert.deepEqual(readdirSync(home), [])
  ok(run())
  assert.deepEqual(readdirSync(skills).sort(), ['autobuild', 'bughunt'])
  assert.equal(readlinkSync(join(skills, 'autobuild')), resolve(REPO, 'graphs/autobuild/skills/autobuild'))
  assert.equal(readlinkSync(join(skills, 'bughunt')), resolve(REPO, 'graphs/hunt/skills/bughunt'))
  for (const p of ['.claude', '.codex', '.local']) assert.equal(existsSync(join(home, p)), false)
  assert.match(run().stdout, /done: 0 linked, 2 already linked/)
  assert.equal(existsSync(join(home, '.agents', '.pandastack-codex-backups-skills')), false)
}))

test('Codex preserves foreign skills, backs up conflicts and restores them on uninstall', () => fixture(({ home, skills, run }) => {
  mkdirSync(join(skills, 'autobuild'), { recursive: true })
  mkdirSync(join(skills, 'foreign'))
  writeFileSync(join(skills, 'autobuild', 'SKILL.md'), 'my autobuild')
  writeFileSync(join(skills, 'foreign', 'SKILL.md'), 'foreign skill')
  symlinkSync('/missing-foreign-bughunt', join(skills, 'bughunt'))
  ok(run())
  const backups = join(home, '.agents', '.pandastack-codex-backups-skills')
  const dirs = readdirSync(backups)
  assert.equal(dirs.length, 1)
  assert.equal(readFileSync(join(backups, dirs[0], 'skills/autobuild/SKILL.md'), 'utf8'), 'my autobuild')
  ok(run(['--uninstall', '--dry-run']))
  assert.equal(isLink(join(skills, 'autobuild')), true)
  ok(run(['--uninstall']))
  assert.equal(readFileSync(join(skills, 'autobuild/SKILL.md'), 'utf8'), 'my autobuild')
  assert.equal(readlinkSync(join(skills, 'bughunt')), '/missing-foreign-bughunt')
  assert.equal(readFileSync(join(skills, 'foreign/SKILL.md'), 'utf8'), 'foreign skill')
}))

test('Codex uninstall preserves a replacement and keeps its backup for later recovery', () => fixture(({ home, skills, run }) => {
  mkdirSync(join(skills, 'autobuild'), { recursive: true })
  writeFileSync(join(skills, 'autobuild/SKILL.md'), 'original')
  ok(run())
  unlinkSync(join(skills, 'autobuild'))
  mkdirSync(join(skills, 'autobuild'))
  writeFileSync(join(skills, 'autobuild/SKILL.md'), 'replacement')
  const r = run(['--uninstall']); ok(r)
  assert.match(r.stderr, /already exists at target/)
  assert.equal(readFileSync(join(skills, 'autobuild/SKILL.md'), 'utf8'), 'replacement')
  const backups = join(home, '.agents', '.pandastack-codex-backups-skills')
  assert.equal(readFileSync(join(backups, readdirSync(backups)[0], 'skills/autobuild/SKILL.md'), 'utf8'), 'original')
}))

test('Codex refuses shared symlinked skill directories for install and uninstall without touching them', () => fixture(({ home, skills, run }) => {
  const shared = join(home, '.claude/skills')
  mkdirSync(shared, { recursive: true }); mkdirSync(join(home, '.agents'))
  writeFileSync(join(shared, 'mine'), 'untouched')
  symlinkSync(shared, skills)
  for (const args of [[], ['--dry-run'], ['--uninstall']]) {
    const r = run(args)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /refuses symlinked directory/)
  }
  assert.deepEqual(readdirSync(shared), ['mine'])
  assert.equal(readFileSync(join(shared, 'mine'), 'utf8'), 'untouched')
}))

test('Codex custom absolute target works without HOME and honors supported skip names', () => fixture(({ home, run }) => {
  const custom = join(home, 'custom/entries')
  const env = { HOME: '', PANDASTACK_CODEX_SKILLS_DIR: custom }
  ok(run(['--skip=skills/bughunt'], env))
  assert.deepEqual(readdirSync(custom), ['autobuild'])
  assert.notEqual(run(['--skip=settings.json'], env).status, 0)
  assert.notEqual(run(['--skip=local-bin'], env).status, 0)
  ok(run(['--uninstall'], env))
  assert.deepEqual(readdirSync(custom), [])
}))

test('Codex rejects absent, relative, root, repo-internal and symlink-ancestor targets', () => fixture(({ home, run }) => {
  for (const target of ['', 'relative', '/', join(home, 'x') + '/../skills', resolve(REPO, '.codex-test-target')]) {
    const r = run([], { HOME: '', PANDASTACK_CODEX_SKILLS_DIR: target })
    assert.notEqual(r.status, 0, target + r.stdout)
  }
  const actual = join(home, 'actual'); mkdirSync(actual)
  symlinkSync(actual, join(home, 'alias'))
  assert.notEqual(run([], { PANDASTACK_CODEX_SKILLS_DIR: join(home, 'alias/skills') }).status, 0)
  assert.deepEqual(readdirSync(actual), [])
}))

test('plain install without HOME or CLAUDE_CONFIG_DIR refuses before choosing a root target', () => {
  const env = { ...process.env }; delete env.HOME; delete env.CLAUDE_CONFIG_DIR
  const r = spawnSync('bash', [join(REPO, 'install.sh'), '--dry-run'], { encoding: 'utf8', env })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /needs HOME or CLAUDE_CONFIG_DIR/)
})
