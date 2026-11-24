// install-codex-shared-skills.test.mjs — the shared skills layout, ~/.agents/skills -> ~/.claude/skills
// (the Codex skills dir is a symlink to the Claude skills dir the Claude install links). --codex links,
// backs up and unlinks nothing through that symlink, but still registers and trusts the review gate,
// and --uninstall --codex removes only the gate. Any other symlinked layout is still refused
// (tests/install-codex.test.mjs keeps covering a shared dir that holds no PandaStack link).
// Throwaway HOME and a fake `codex app-server` (graphs/hunt/tests/fixtures/fake-codex-app-server.mjs):
// no real Codex runs, and the real ~/.codex and ~/.claude are never touched.
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync, rmSync, readdirSync, symlinkSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'

const FAKE = join(REPO, 'graphs', 'hunt', 'tests', 'fixtures', 'fake-codex-app-server.mjs')
const BUGHUNT = join(REPO, 'graphs', 'hunt', 'skills', 'bughunt')
const FOREIGN = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /opt/other/guard.mjs' }] }

// layout: 'shared' (~/.agents/skills -> ~/.claude/skills, bughunt linked to this checkout),
// 'elsewhere' (~/.agents/skills -> ~/elsewhere, which holds the same bughunt link),
// 'other-checkout' (shared, but bughunt links to another copy holding a gate.mjs).
function fixture(fn, { layout = 'shared' } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'install-codex-shared-')))
  const codex = join(home, '.codex')
  mkdirSync(codex)
  const claudeSkills = join(home, '.claude', 'skills')
  mkdirSync(claudeSkills, { recursive: true })
  mkdirSync(join(home, '.agents'))
  const agentsSkills = join(home, '.agents', 'skills')
  if (layout === 'elsewhere') {
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(BUGHUNT, join(elsewhere, 'bughunt'))
    symlinkSync(elsewhere, agentsSkills)
  } else if (layout === 'other-checkout') {
    const other = join(home, 'other-checkout', 'bughunt')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'gate.mjs'), 'process.exit(0)\n')
    symlinkSync(other, join(claudeSkills, 'bughunt'))
    symlinkSync(claudeSkills, agentsSkills)
  } else {
    symlinkSync(BUGHUNT, join(claudeSkills, 'bughunt'))
    symlinkSync(claudeSkills, agentsSkills)
  }
  const bin = join(home, 'fake-codex')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(bin, 0o755)
  const env = { ...process.env, HOME: home, HARNESS_NO_GIT_CONFIG: '1', PANDASTACK_CODEX_BIN: bin }
  for (const k of ['CLAUDE_CONFIG_DIR', 'PANDASTACK_BIN_DIR', 'PANDASTACK_CODEX_SKILLS_DIR', 'CODEX_HOME', 'PANDASTACK_CODEX_HOME', 'FAKE_APP_SERVER_MODE']) delete env[k]
  const run = (args = [], extra = {}) => spawnSync('bash', [join(REPO, 'install.sh'), '--codex', ...args], { encoding: 'utf8', env: { ...env, ...extra } })
  const plain = (args = []) => spawnSync('bash', [join(REPO, 'install.sh'), ...args], { encoding: 'utf8', env })
  const gate = join(agentsSkills, 'bughunt', 'gate.mjs')
  const ours = { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${gate}"`, timeout: 30 }] }
  const hooksFile = join(codex, 'hooks.json')
  const hooks = () => JSON.parse(readFileSync(hooksFile, 'utf8'))
  const trust = () => JSON.parse(readFileSync(join(codex, 'fake-trust.json'), 'utf8'))
  try { fn({ home, codex, claudeSkills, agentsSkills, run, plain, gate, ours, hooksFile, hooks, trust }) } finally { rmSync(home, { recursive: true, force: true }) }
}
const ok = r => assert.equal(r.status, 0, r.stdout + r.stderr)
const backups = home => join(home, '.agents', '.pandastack-codex-backups-skills')

await test('shared layout: install --codex links nothing through the symlink, registers the gate and trusts it', () => fixture(({ home, claudeSkills, agentsSkills, run, ours, hooks, hooksFile, trust }) => {
  const r = run()
  ok(r)
  assert.match(r.stdout, /shared skills dir: .*nothing is linked through it/)
  assert.match(r.stdout, /^CODEX-GATE: trusted/m)
  assert.deepEqual(readdirSync(claudeSkills), ['bughunt'], 'no entry linked into the shared dir')
  assert.equal(readlinkSync(join(claudeSkills, 'bughunt')), BUGHUNT, 'the Claude link is left as it was')
  assert.equal(readlinkSync(agentsSkills), claudeSkills, 'the shared symlink is left as it was')
  assert.equal(existsSync(backups(home)), false, 'no backup dir is made')
  assert.deepEqual(hooks().hooks.PreToolUse, [ours], 'the gate path goes through the Codex skills dir')
  assert.deepEqual(Object.keys(trust()), [`${hooksFile}:pre_tool_use:0:0`])
}))

await test('shared layout: an entry already there exactly as install adds it is left byte-identical and stays trusted', () => fixture(({ run, ours, hooksFile, trust }) => {
  // Written by hand with its own formatting, the way an earlier manual registration left it.
  const text = `{"hooks":{"PreToolUse":[${JSON.stringify(FOREIGN)},\n  ${JSON.stringify(ours)}]}}\n`
  writeFileSync(hooksFile, text)
  let r = run()
  ok(r)
  assert.match(r.stdout, /already has the review gate/)
  assert.equal(readFileSync(hooksFile, 'utf8'), text, 'hooks.json is not rewritten')
  assert.deepEqual(Object.keys(trust()), [`${hooksFile}:pre_tool_use:1:0`])
  r = run()
  ok(r)
  assert.match(r.stdout, /already trusted/)
  assert.equal(readFileSync(hooksFile, 'utf8'), text)
}))

await test('a Codex skills symlink to any other directory is still refused, untouched', () => fixture(({ home, codex, run }) => {
  for (const args of [[], ['--dry-run'], ['--uninstall']]) {
    const r = run(args)
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /refuses symlinked directory/)
  }
  assert.deepEqual(readdirSync(join(home, 'elsewhere')), ['bughunt'])
  assert.equal(existsSync(join(codex, 'hooks.json')), false)
}, { layout: 'elsewhere' }))

await test('a shared dir whose bughunt links to another checkout is refused: no gate from a foreign copy', () => fixture(({ codex, run }) => {
  const r = run()
  assert.notEqual(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stderr, /refuses symlinked directory/)
  assert.equal(existsSync(join(codex, 'hooks.json')), false)
}, { layout: 'other-checkout' }))

await test('shared layout: uninstall --codex removes only the gate and unlinks nothing; with no gate left it refuses as before', () => fixture(({ claudeSkills, run, hooks, hooksFile }) => {
  writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [FOREIGN] } }))
  ok(run())
  assert.equal(hooks().hooks.PreToolUse.length, 2)
  let r = run(['--uninstall', '--dry-run'])
  ok(r)
  assert.match(r.stdout, /\[dry-run\] would remove the review gate/)
  assert.equal(hooks().hooks.PreToolUse.length, 2, 'dry-run removes nothing')
  r = run(['--uninstall'])
  ok(r)
  assert.match(r.stdout, /nothing is unlinked through/)
  assert.match(r.stdout, /removed the review gate/)
  assert.deepEqual(hooks(), { hooks: { PreToolUse: [FOREIGN] } })
  assert.deepEqual(readdirSync(claudeSkills), ['bughunt'], 'the Claude link is not removed by the Codex uninstall')
  r = run(['--uninstall'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /refuses symlinked directory/)
}))

await test('shared layout: --dry-run writes nothing and starts no Codex; --skip=skills/bughunt registers no gate', () => fixture(({ codex, claudeSkills, run }) => {
  let r = run(['--dry-run'])
  ok(r)
  assert.match(r.stdout, /\[dry-run\] would add the review gate/)
  assert.equal(existsSync(join(codex, 'hooks.json')), false)
  assert.equal(existsSync(join(codex, 'fake-calls.jsonl')), false, 'dry-run never starts codex')
  assert.deepEqual(readdirSync(claudeSkills), ['bughunt'])
  r = run(['--skip=skills/bughunt'])
  ok(r)
  assert.match(r.stdout, /skills\/bughunt is skipped, so the gate hook is not registered/)
  assert.equal(existsSync(join(codex, 'hooks.json')), false)
}))

await test('shared layout: plain ./install.sh registers the gate after the Claude links; plain --uninstall removes it', () => fixture(({ claudeSkills, plain, ours, hooks, hooksFile }) => {
  let r = plain()
  ok(r)
  assert.doesNotMatch(r.stderr, /the Codex step exited/, r.stderr)
  assert.match(r.stdout, /^CODEX-GATE: trusted/m)
  assert.deepEqual(hooks().hooks.PreToolUse, [ours])
  assert.ok(readdirSync(claudeSkills).length > 1, 'the Claude part linked its skills')
  r = plain(['--uninstall'])
  ok(r)
  assert.doesNotMatch(r.stderr, /the Codex step exited/, r.stderr)
  assert.deepEqual(hooks(), { hooks: {} }, 'the gate is removed even though the Claude part unlinked bughunt first')
  assert.equal(existsSync(join(claudeSkills, 'bughunt')), false)
  assert.equal(existsSync(hooksFile), true)
}))
