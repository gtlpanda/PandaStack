// install-codex-gate.test.mjs — install.sh --codex registers the review gate as a trusted Codex hook
// (graphs/hunt/skills/bughunt/codex-hook.mjs), against a throwaway HOME and a fake `codex app-server`
// (graphs/hunt/tests/fixtures/fake-codex-app-server.mjs): no real Codex runs here, and the real
// ~/.codex is never touched (HOME is a temp dir and CODEX_HOME is unset).
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync, rmSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'

const FAKE = join(REPO, 'graphs', 'hunt', 'tests', 'fixtures', 'fake-codex-app-server.mjs')
const FOREIGN = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /opt/other/guard.mjs' }] }

function fixture(fn, { codexHome = true } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'install-codex-gate-')))
  const codex = join(home, '.codex')
  if (codexHome) mkdirSync(codex)
  const bin = join(home, 'fake-codex')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(bin, 0o755)
  const env = { ...process.env, HOME: home, HARNESS_NO_GIT_CONFIG: '1', PANDASTACK_CODEX_BIN: bin }
  for (const k of ['CLAUDE_CONFIG_DIR', 'PANDASTACK_BIN_DIR', 'PANDASTACK_CODEX_SKILLS_DIR', 'CODEX_HOME', 'FAKE_APP_SERVER_MODE']) delete env[k]
  const run = (args = [], extra = {}) => spawnSync('bash', [join(REPO, 'install.sh'), '--codex', ...args], { encoding: 'utf8', env: { ...env, ...extra } })
  const gate = join(home, '.agents', 'skills', 'bughunt', 'gate.mjs')
  const ours = { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${gate}"`, timeout: 30 }] }
  const hooks = () => JSON.parse(readFileSync(join(codex, 'hooks.json'), 'utf8'))
  const trust = () => JSON.parse(readFileSync(join(codex, 'fake-trust.json'), 'utf8'))
  try { fn({ home, codex, env, run, gate, ours, hooks, trust }) } finally { rmSync(home, { recursive: true, force: true }) }
}
const ok = r => assert.equal(r.status, 0, r.stdout + r.stderr)

await test('install --codex adds the gate to hooks.json, trusts it and checks it; a second install changes nothing', () => fixture(({ codex, run, gate, ours, hooks, trust }) => {
  writeFileSync(join(codex, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [FOREIGN] } }))
  const r = run()
  ok(r)
  assert.equal(readlinkSync(join(gate, '..')), join(REPO, 'graphs', 'hunt', 'skills', 'bughunt'))
  assert.deepEqual(hooks().hooks.PreToolUse, [FOREIGN, ours], 'theirs kept, ours appended with the installed gate path')
  assert.deepEqual(Object.keys(trust()), [`${join(codex, 'hooks.json')}:pre_tool_use:1:0`])
  assert.match(r.stdout, /trusted the review gate/)
  assert.match(r.stdout, /^CODEX-GATE: trusted/m)
  const bytes = readFileSync(join(codex, 'hooks.json'), 'utf8')
  const again = run()
  ok(again)
  assert.match(again.stdout, /already has the review gate/)
  assert.match(again.stdout, /already trusted/)
  assert.equal(readFileSync(join(codex, 'hooks.json'), 'utf8'), bytes)
}))

await test('dry-run writes nothing to the Codex home; --skip=skills/bughunt registers no gate', () => fixture(({ codex, run }) => {
  let r = run(['--dry-run'])
  ok(r)
  assert.match(r.stdout, /\[dry-run\] would add the review gate/)
  assert.equal(existsSync(join(codex, 'hooks.json')), false)
  assert.equal(existsSync(join(codex, 'fake-calls.jsonl')), false, 'dry-run never starts codex')
  r = run(['--skip=skills/bughunt'])
  ok(r)
  assert.match(r.stdout, /skills\/bughunt is skipped, so the gate hook is not registered/)
  assert.equal(existsSync(join(codex, 'hooks.json')), false)
}))

await test('with no Codex home the skills install, the gate is not registered, and the warning says so', () => fixture(({ home, run }) => {
  const r = run()
  ok(r)
  assert.match(r.stderr, /no Codex home at .*\.codex: the review gate is not registered for Codex/)
  assert.equal(existsSync(join(home, '.codex')), false, 'install never creates a Codex home')
  assert.equal(existsSync(join(home, '.agents', 'skills', 'bughunt')), true)
}, { codexHome: false }))

await test('a gate Codex will not trust fails --codex loudly; the plain install only warns', () => fixture(({ home, codex, run, env }) => {
  let r = run([], { FAKE_APP_SERVER_MODE: 'ignore-trust' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stderr, /the gate is NOT active/)
  assert.equal(existsSync(join(home, '.agents', 'skills', 'bughunt')), true, 'the skills are linked before the gate step')
  writeFileSync(join(codex, 'hooks.json'), '{ broken')
  r = run()
  assert.equal(r.status, 1)
  assert.match(r.stderr, /hooks\.json is not valid JSON/)
  assert.equal(readFileSync(join(codex, 'hooks.json'), 'utf8'), '{ broken', 'a malformed hooks.json is left as it is')
  rmSync(join(codex, 'hooks.json'))
  // Plain ./install.sh: the Claude targets, then the same --codex step, whose failure is a warning.
  const plain = spawnSync('bash', [join(REPO, 'install.sh')], { encoding: 'utf8', env: { ...env, FAKE_APP_SERVER_MODE: 'ignore-trust' } })
  assert.equal(plain.status, 0, plain.stdout + plain.stderr)
  assert.match(plain.stderr, /the gate is NOT active/)
  assert.match(plain.stderr, /the Codex step exited 1; the Claude part is done/)
}))

await test('uninstall --codex removes only the gate from hooks.json', () => fixture(({ codex, run, hooks }) => {
  writeFileSync(join(codex, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }], PreToolUse: [FOREIGN] } }))
  ok(run())
  let r = run(['--uninstall', '--dry-run'])
  ok(r)
  assert.match(r.stdout, /\[dry-run\] would remove the review gate/)
  assert.equal(hooks().hooks.PreToolUse.length, 2)
  r = run(['--uninstall'])
  ok(r)
  assert.match(r.stdout, /removed the review gate/)
  assert.deepEqual(hooks(), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }], PreToolUse: [FOREIGN] } })
}))
