// codex-hook.test.mjs — the review gate as a Codex hook (graphs/hunt/skills/bughunt/codex-hook.mjs):
// merging our one entry into $CODEX_HOME/hooks.json and removing it, trusting it through the
// app-server (a fake one: no real Codex runs here), and gate.mjs answering the input Codex
// actually sends (captured from Codex 0.167: tests/fixtures/codex-pretooluse.json).
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { gateCommand, mergeHooks, unmergeHooks, parseHooksFile, HookFileError, findOurHook, entryIsExactlyOurs, withAppServer, MATCHER } from '../skills/bughunt/codex-hook.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER = join(HERE, '..', 'skills', 'bughunt', 'codex-hook.mjs')
const GATE_HOOK = join(HERE, '..', 'skills', 'bughunt', 'gate.mjs')
const FAKE = join(HERE, 'fixtures', 'fake-codex-app-server.mjs')
const PAYLOAD = JSON.parse(readFileSync(join(HERE, 'fixtures', 'codex-pretooluse.json'), 'utf8'))
const GATE = '/home/dev/.agents/skills/bughunt/gate.mjs'
const OURS = { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${GATE}"`, timeout: 30 }] }
const FOREIGN = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /opt/other/guard.mjs' }] }

// A Codex home with a fake codex binary in front of it.
function codexHome() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-hook-')))
  const home = join(root, 'codex')
  mkdirSync(home)
  const bin = join(root, 'codex-bin')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(bin, 0o755)
  return { root, home, bin, hooksFile: join(home, 'hooks.json') }
}
function cli(args, { home, bin, extra = {} }) {
  const env = { ...process.env, PANDASTACK_CODEX_BIN: bin, ...extra }
  delete env.CODEX_HOME
  return spawnSync(process.execPath, [HELPER, ...args, '--codex-home', home, '--gate', GATE], { encoding: 'utf8', env })
}
const calls = home => (existsSync(join(home, 'fake-calls.jsonl')) ? readFileSync(join(home, 'fake-calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [])
const writes = home => calls(home).filter(c => c.method === 'config/batchWrite')

console.log('== the hooks.json entry')
await test('the gate command is node on an absolute, shell-safe path', () => {
  assert.equal(gateCommand(GATE), `node "${GATE}"`)
  for (const bad of ['gate.mjs', 'skills/bughunt/gate.mjs', '/a/$HOME/gate.mjs', '/a/`x`/gate.mjs', '/a/"b"/gate.mjs', '/a/b\\c', '/a/b\nc', null, undefined, 3, {}]) {
    assert.throws(() => gateCommand(bad), HookFileError, String(bad))
  }
})
await test('hooks.json must be an object with an object `hooks` and an array PreToolUse; a byte-order mark is fine', () => {
  for (const bad of ['{', '[]', 'null', '"x"', '3', '{"hooks":[]}', '{"hooks":"x"}', '{"hooks":{"PreToolUse":{}}}']) assert.throws(() => parseHooksFile(bad), HookFileError, bad)
  assert.deepEqual(parseHooksFile('﻿{"hooks":{}}'), { hooks: {} })
  assert.deepEqual(parseHooksFile('{}'), {})
})
await test('merge: a new file gets our one entry; other events and other PreToolUse entries are kept, ours goes last', () => {
  assert.deepEqual(mergeHooks(null, GATE), { config: { hooks: { PreToolUse: [OURS] } }, added: true })
  const theirs = { other: 1, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }], PreToolUse: [FOREIGN] } }
  const { config, added } = mergeHooks(theirs, GATE)
  assert.equal(added, true)
  assert.deepEqual(config, { other: 1, hooks: { SessionStart: theirs.hooks.SessionStart, PreToolUse: [FOREIGN, OURS] } })
  assert.deepEqual(theirs.hooks.PreToolUse, [FOREIGN], 'the input is not changed')
})
await test('merge twice adds nothing; an entry of ours already there, even edited or sharing a group, is left exactly as it is', () => {
  const once = mergeHooks(null, GATE).config
  assert.deepEqual(mergeHooks(once, GATE), { config: once, added: false })
  const edited = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${GATE}"`, timeout: 99 }] }] } }
  assert.deepEqual(mergeHooks(edited, GATE), { config: edited, added: false }, 'rewriting it would make Codex report it modified and skip it')
  const shared = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [FOREIGN.hooks[0], OURS.hooks[0]] }] } }
  assert.equal(mergeHooks(shared, GATE).added, false)
  const otherMatcher = { hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [OURS.hooks[0]] }] } }
  assert.equal(mergeHooks(otherMatcher, GATE).added, true, 'our command under another matcher does not gate Bash')
})
await test('unmerge removes only ours: a sibling hook in the same group stays; an emptied group and PreToolUse go', () => {
  const theirs = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }], PreToolUse: [FOREIGN, OURS, { matcher: 'Bash', hooks: [FOREIGN.hooks[0], OURS.hooks[0]] }] } }
  const { config, removed } = unmergeHooks(theirs, GATE)
  assert.equal(removed, 2)
  assert.deepEqual(config.hooks.PreToolUse, [FOREIGN, { matcher: 'Bash', hooks: [FOREIGN.hooks[0]] }])
  assert.deepEqual(config.hooks.SessionStart, theirs.hooks.SessionStart)
  assert.deepEqual(unmergeHooks({ hooks: { PreToolUse: [OURS] } }, GATE).config, { hooks: {} })
  assert.deepEqual(unmergeHooks({ x: 1 }, GATE), { config: { x: 1 }, removed: 0 })
})

console.log('== the CLI over a hooks.json')
await test('merge writes the file, a second merge leaves it, dry-run writes nothing, unmerge keeps the rest', () => {
  const c = codexHome()
  let r = cli(['merge', '--dry-run'], c)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /\[dry-run\] would add the review gate/)
  assert.equal(existsSync(c.hooksFile), false)
  writeFileSync(c.hooksFile, JSON.stringify({ hooks: { PreToolUse: [FOREIGN] } }))
  r = cli(['merge'], c)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(readFileSync(c.hooksFile, 'utf8')).hooks.PreToolUse, [FOREIGN, OURS])
  const bytes = readFileSync(c.hooksFile, 'utf8')
  r = cli(['merge'], c)
  assert.match(r.stdout, /already has the review gate/)
  assert.equal(readFileSync(c.hooksFile, 'utf8'), bytes)
  r = cli(['unmerge', '--dry-run'], c)
  assert.match(r.stdout, /\[dry-run\] would remove/)
  assert.equal(readFileSync(c.hooksFile, 'utf8'), bytes)
  r = cli(['unmerge'], c)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(readFileSync(c.hooksFile, 'utf8')), { hooks: { PreToolUse: [FOREIGN] } })
})
await test('merge refuses a malformed hooks.json and leaves it byte for byte; no Codex home is an error; bad usage exits 2', () => {
  const c = codexHome()
  for (const bad of ['{ not json', '[1]', '{"hooks":{"PreToolUse":"x"}}']) {
    writeFileSync(c.hooksFile, bad)
    const r = cli(['merge'], c)
    assert.equal(r.status, 1, bad)
    assert.match(r.stderr, /codex-hook: hooks\.json/)
    assert.equal(readFileSync(c.hooksFile, 'utf8'), bad)
  }
  const r = cli(['merge'], { ...c, home: join(c.root, 'no-such-home') })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no Codex home/)
  assert.equal(spawnSync(process.execPath, [HELPER, 'merge'], { encoding: 'utf8' }).status, 2, 'no --gate')
  assert.equal(spawnSync(process.execPath, [HELPER, 'status', '--dry-run', '--gate', GATE], { encoding: 'utf8' }).status, 2, 'dry-run is for merge/unmerge')
})

console.log('== trust and status, through the app-server')
await test('untrusted -> trust -> trusted: one batchWrite of hooks.state for our user-level key, with the hash Codex gave', () => {
  const c = codexHome()
  let r = cli(['status'], c)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^CODEX-GATE: missing$/m)
  cli(['merge'], c)
  r = cli(['status'], c)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^CODEX-GATE: untrusted \(.*hooks\.json:pre_tool_use:0:0\)$/m)
  r = cli(['trust'], c)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /trusted the review gate \(.*:pre_tool_use:0:0, sha256:[0-9a-f]{64}\)/)
  const w = writes(c.home)
  assert.equal(w.length, 1)
  const [edit] = w[0].params.edits
  assert.equal(edit.keyPath, 'hooks.state')
  assert.equal(edit.mergeStrategy, 'upsert')
  assert.deepEqual(Object.keys(edit.value), [`${c.hooksFile}:pre_tool_use:0:0`])
  r = cli(['status'], c)
  assert.equal(r.status, 0)
  assert.match(r.stdout, /^CODEX-GATE: trusted/m)
  r = cli(['trust'], c)
  assert.match(r.stdout, /already trusted/)
  assert.equal(writes(c.home).length, 1, 'trusting a trusted gate writes nothing')
})
await test('an entry added before ours moves its key and leaves it untrusted; trust again trusts it at its new place', () => {
  const c = codexHome()
  cli(['merge'], c)
  assert.equal(cli(['trust'], c).status, 0)
  const config = JSON.parse(readFileSync(c.hooksFile, 'utf8'))
  config.hooks.PreToolUse.unshift(FOREIGN)
  writeFileSync(c.hooksFile, JSON.stringify(config))
  let r = cli(['status'], c)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^CODEX-GATE: untrusted \(.*:pre_tool_use:1:0\)$/m)
  r = cli(['trust'], c)
  assert.equal(r.status, 0, r.stderr)
  assert.match(cli(['status'], c).stdout, /^CODEX-GATE: trusted \(.*:pre_tool_use:1:0\)$/m)
})
await test('trust refuses a project-level hook with our command, and an edited entry of ours: nothing is written', () => {
  const c = codexHome()
  writeFileSync(c.hooksFile, JSON.stringify({ hooks: { PreToolUse: [FOREIGN] } }))
  const project = [{ key: '/work/repo/.codex/hooks.json:pre_tool_use:0:0', source: 'project', command: `node "${GATE}"`, currentHash: 'sha256:aa', trustStatus: 'untrusted' }]
  let r = cli(['trust'], { ...c, extra: { FAKE_EXTRA_HOOKS: JSON.stringify(project) } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /does not list the review gate/)
  assert.equal(writes(c.home).length, 0)
  writeFileSync(c.hooksFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ ...OURS.hooks[0], timeout: 1 }] }] } }))
  r = cli(['trust'], c)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /not exactly the one install adds/)
  assert.equal(writes(c.home).length, 0)
  writeFileSync(c.hooksFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [FOREIGN.hooks[0], OURS.hooks[0]] }] } }))
  r = cli(['trust'], c)
  assert.equal(r.status, 1, 'our hook sharing a group with another is not the entry install adds')
  assert.equal(writes(c.home).length, 0)
})
await test('a trust that does not hold, a hooks/list error, a crash and a missing codex all fail with the reason', () => {
  const c = codexHome()
  cli(['merge'], c)
  let r = cli(['trust'], { ...c, extra: { FAKE_APP_SERVER_MODE: 'ignore-trust' } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /still reports the review gate as untrusted/)
  r = cli(['status'], { ...c, extra: { FAKE_APP_SERVER_MODE: 'list-error' } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /hooks\/list: list failed on purpose/)
  r = cli(['trust'], { ...c, extra: { FAKE_APP_SERVER_MODE: 'crash' } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /app-server exited \(1\) before answering: fake codex: crashed on purpose/)
  r = cli(['status'], { ...c, bin: join(c.root, 'no-codex-here') })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /codex was not found/)
})
await test('an app-server that never answers is given up on at the timeout', async () => {
  const c = codexHome()
  const started = Date.now()
  process.env.FAKE_APP_SERVER_MODE = 'hang'
  try {
    await assert.rejects(withAppServer(c.home, call => call('hooks/list', {}), { bin: c.bin, timeoutMs: 500 }), /did not answer within 0\.5s/)
  } finally { delete process.env.FAKE_APP_SERVER_MODE }
  assert.ok(Date.now() - started < 5000)
})
await test('findOurHook and entryIsExactlyOurs read only our user-level entry at the place its key names', () => {
  const file = '/h/.codex/hooks.json'
  const user = { key: `${file}:pre_tool_use:1:0`, source: 'user', command: `node "${GATE}"`, trustStatus: 'untrusted' }
  const list = { data: [{ hooks: [{ ...user, source: 'project' }, { ...user, key: '/elsewhere/hooks.json:pre_tool_use:1:0' }, { ...user, command: 'node other' }, user] }] }
  assert.equal(findOurHook(list, [file], `node "${GATE}"`), user)
  assert.equal(findOurHook({ data: 'x' }, [file], `node "${GATE}"`), null)
  assert.equal(findOurHook(null, [file], `node "${GATE}"`), null)
  const config = { hooks: { PreToolUse: [FOREIGN, OURS] } }
  assert.equal(entryIsExactlyOurs(config, `${file}:pre_tool_use:1:0`, [file], GATE), true)
  assert.equal(entryIsExactlyOurs(config, `${file}:pre_tool_use:0:0`, [file], GATE), false)
  assert.equal(entryIsExactlyOurs(config, `${file}:pre_tool_use:1:1`, [file], GATE), false)
  assert.equal(entryIsExactlyOurs(config, `${file}:post_tool_use:1:0`, [file], GATE), false)
  assert.equal(entryIsExactlyOurs(config, `/other/hooks.json:pre_tool_use:1:0`, [file], GATE), false)
  assert.equal(entryIsExactlyOurs(config, `${file}:pre_tool_use:1:0x`, [file], GATE), false)
  assert.equal(MATCHER, 'Bash')
})

console.log('== gate.mjs on the input Codex sends')
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' }
delete ENV.PANDASTACK_REVIEW_GATE
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
// main pushed to a bare origin; branch feat with one code commit and no hunt.
function repoFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-gate-')))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.js'), 'export const a = 1\n')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base')
  git(repo, 'remote', 'add', 'origin', join(root, 'origin.git'))
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'remote', 'set-head', 'origin', 'main')
  git(repo, 'checkout', '-q', '-b', 'feat')
  writeFileSync(join(repo, 'a.js'), 'export const a = 2\n')
  git(repo, 'commit', '-qam', 'change')
  return repo
}
const codexCall = (repo, command, env = ENV) => {
  const input = { ...PAYLOAD, cwd: repo, tool_input: { command } }
  const r = spawnSync(process.execPath, [GATE_HOOK], { input: JSON.stringify(input), encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null
}
await test('the captured Codex payload: a push to the default branch and a PR with no hunt are denied, a plain command passes', () => {
  assert.equal(PAYLOAD.tool_name, 'Bash')
  assert.equal(PAYLOAD.hook_event_name, 'PreToolUse')
  const repo = repoFixture()
  const push = codexCall(repo, 'git push origin HEAD:main')
  assert.equal(push.hookEventName, 'PreToolUse')
  assert.equal(push.permissionDecision, 'deny')
  assert.match(push.permissionDecisionReason, /pushes straight to origin\/main/)
  assert.match(push.permissionDecisionReason, /start the agent \(Claude Code or Codex\) with PANDASTACK_REVIEW_GATE=0/)
  const pr = codexCall(repo, 'gh pr create --title t --body b')
  assert.equal(pr.permissionDecision, 'deny')
  assert.match(pr.permissionDecisionReason, /bughunt/)
  assert.equal(codexCall(repo, 'echo probe-ok'), null)
  assert.equal(codexCall(repo, 'git push origin HEAD:main', { ...ENV, PANDASTACK_REVIEW_GATE: '0' }), null, 'the off switch a person sets at launch reaches the hook through its environment')
})
