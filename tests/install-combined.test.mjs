// One plain ./install.sh serves both apps: the Claude targets as always, plus the Codex entry skills in
// ~/.agents/skills when Codex is here (`codex` on PATH, or a ~/.agents directory). --claude and --codex
// pick one. Every case runs in an owned temp HOME with a pinned PATH (a stub dir holding only `node`, plus
// /usr/bin:/bin), so the result never depends on whether this machine has codex installed.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { PARTIAL_IDS } from './codex-expected-state.mjs'

const TMP = realpathSync(tmpdir())
const isLink = p => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }

// A fresh HOME and a stub bin dir. `codexOnPath` puts an executable named codex there (never run: only looked up).
function world({ codexOnPath = false } = {}) {
  const dir = mkdtempSync(join(TMP, 'install-combined-'))
  const home = join(dir, 'home'), bin = join(dir, 'bin')
  mkdirSync(home); mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, 'node'))
  if (codexOnPath) { writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'codex'), 0o755) }
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HARNESS_NO_GIT_CONFIG: '1' }
  const run = (args = [], extra = {}) => spawnSync('bash', [join(REPO, 'install.sh'), ...args], { encoding: 'utf8', env: { ...env, ...extra }, cwd: dir })
  return { dir, home, run, agents: join(home, '.agents', 'skills'), claude: join(home, '.claude'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const using = async (opts, fn) => { const w = world(opts); try { await fn(w) } finally { w.cleanup() } }
const ok = r => assert.equal(r.status, 0, r.stdout + r.stderr)
const codexLinks = w => (existsSync(w.agents) ? readdirSync(w.agents).sort() : [])

// The scrubbed PATH really has no codex: the machine's own install cannot leak into these cases.
await test('the pinned PATH finds no codex unless the case adds one', () => using({}, w => {
  const r = spawnSync('bash', ['-c', 'command -v codex || echo none'], { encoding: 'utf8', env: { PATH: `${join(w.dir, 'bin')}:/usr/bin:/bin` } })
  assert.equal(r.stdout.trim(), 'none')
}))

await test('neither signal (no codex on PATH, no ~/.agents): Claude only, ~/.agents never created', () => using({}, w => {
  ok(w.run())
  assert.ok(isLink(join(w.claude, 'skills', 'verify')), 'a Claude skill is linked')
  assert.equal(existsSync(join(w.home, '.agents')), false)
}))

await test('codex on PATH: the Claude targets plus exactly the fixture\'s Codex entry skills', () => using({ codexOnPath: true }, w => {
  const r = w.run(); ok(r)
  assert.match(r.stdout, /== Codex found: the same as .\/install.sh --codex ==/)
  assert.ok(isLink(join(w.claude, 'skills', 'verify')))
  assert.deepEqual(codexLinks(w), PARTIAL_IDS, 'every expected-state partial row, nothing else')
  assert.equal(existsSync(join(w.home, '.codex')), false, 'nothing under ~/.codex')
}))

await test('~/.agents exists, no codex on PATH: the Codex entry skills are installed too', () => using({}, w => {
  mkdirSync(join(w.home, '.agents'))
  ok(w.run())
  assert.deepEqual(codexLinks(w), PARTIAL_IDS)
}))

await test('--claude installs the Claude targets only, even with codex on PATH and ~/.agents present', () => using({ codexOnPath: true }, w => {
  mkdirSync(join(w.home, '.agents'))
  ok(w.run(['--claude']))
  assert.ok(isLink(join(w.claude, 'skills', 'verify')))
  assert.deepEqual(codexLinks(w), [])
}))

await test('--codex installs the Codex entry skills only: no ~/.claude, whatever else is present', () => using({ codexOnPath: true }, w => {
  ok(w.run(['--codex']))
  assert.deepEqual(codexLinks(w), PARTIAL_IDS)
  assert.equal(existsSync(w.claude), false)
}))

await test('--claude with --codex is a usage error that changes nothing', () => using({ codexOnPath: true }, w => {
  for (const args of [['--claude', '--codex'], ['--codex', '--claude']]) {
    const r = w.run(args)
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /--claude and --codex are alternatives/)
  }
  assert.deepEqual(readdirSync(w.home), [])
}))

await test('--dry-run changes nothing in either app and says so for both', () => using({ codexOnPath: true }, w => {
  const r = w.run(['--dry-run']); ok(r)
  assert.deepEqual(readdirSync(w.home), [])
  assert.match(r.stdout, /\[dry-run\]/)
  assert.match(r.stdout, /Codex found/)
}))

await test('--uninstall removes the Claude links and the Codex links, and is gated on Codex being present', () => using({ codexOnPath: true }, w => {
  ok(w.run())
  assert.ok(codexLinks(w).length > 0)
  ok(w.run(['--uninstall']))
  assert.deepEqual(codexLinks(w), [])
  assert.equal(isLink(join(w.claude, 'skills', 'verify')), false)
}))

await test('--skip names reach the Codex step only when they are Codex plan targets; Claude-only names (settings.json, local-bin/autobuild) do not break it', () => using({ codexOnPath: true }, w => {
  ok(w.run(['--skip=settings.json,local-bin/autobuild,skills/dev']))
  assert.equal(isLink(join(w.claude, 'settings.json')), false, 'the Claude skip held')
  assert.equal(isLink(join(w.claude, 'skills', 'dev')), false, 'skills/dev skipped for Claude')
  assert.deepEqual(codexLinks(w), PARTIAL_IDS.filter(id => id !== 'dev'), 'skills/dev skipped for Codex too, the rest installed')
}))

await test('a Codex step that fails only warns: the Claude install stands and the install exits 0', () => using({ codexOnPath: true }, w => {
  // ~/.agents/skills a symlink: the Codex mode refuses to write through it (its own guard).
  mkdirSync(join(w.home, '.agents')); mkdirSync(join(w.home, 'elsewhere'))
  symlinkSync(join(w.home, 'elsewhere'), w.agents)
  const r = w.run(); ok(r)
  assert.match(r.stderr, /the Codex step exited [1-9]/)
  assert.ok(isLink(join(w.claude, 'skills', 'verify')), 'the Claude part is done')
  assert.deepEqual(readdirSync(join(w.home, 'elsewhere')), [], 'nothing written through the symlink')
}))
