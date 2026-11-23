// The native Codex entry end to end against a fake `codex` (tests/fixtures/fake-source-only-codex.mjs): the toy audit from `init` to the three reports,
// through audit-native.mjs, the source-only preflight, the per-leaf reader and the Codex provider. Wiring proof, not runtime certification: the fake
// answers with the toy audit's scripted agents; the real-Codex observation is docs/evidence/codex-security-audit-live-*.md.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { test, NO_LINUX_STORES } from '../../../scripts/workflow-harness.mjs'
import { audit, meta, mkRepo, sandbox } from './audit-fixtures.mjs'
import { PLANTED, TOY_FILES } from './toy-app.mjs'
import { skillText, stepCommands } from './skill-commands.mjs'
import { HELPER_COMMANDS, main, parseNativeArgs } from '../skills/security-audit/audit-native.mjs'
import { openAuditJournal, readAuditJournal } from '../skills/security-audit/dispatch-journal.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, '..', '..', '..', 'tests', 'fixtures', 'fake-source-only-codex.mjs')
const ANSWERS = join(HERE, 'native-e2e-answers.mjs')
const AUTH_BYTES = 'not-a-real-login-file'
const work = mkdtempSync(join(sandbox, 'native-e2e-'))
const auth = join(work, 'auth.json'); writeFileSync(auth, AUTH_BYTES, { mode: 0o600 })

// A codex executable that is the fake with its scripted behavior baked in; every invocation is recorded.
function fakeCodex(name, env = {}) {
  const bin = join(work, name), record = join(work, `${name}.jsonl`)
  const vars = { FAKE_CODEX_ANSWER: ANSWERS, FAKE_CODEX_RECORD: record, FAKE_CODEX_ENV_KEYS: 'CODEX_HOME,HOME,PANDASTACK_AUDIT_READER_KEY,PATH', ...env }
  writeFileSync(bin, `#!/bin/sh\n${Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join(' ')} exec ${process.execPath} ${FAKE} "$@"\n`)
  chmodSync(bin, 0o755)
  return { bin, calls: () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) }
}
const capture = () => { const lines = []; return { lines, log: l => lines.push(l) } }
const lastLine = out => out.lines.at(-1)
const flags = (bin, extra = []) => ['--full', '--budget', '60', '--max-parallel', '2', '--codex-bin', bin, '--auth-file', auth, ...extra]
const runDirOf = out => out.lines.find(l => /native run (\S+):/.test(l)).match(/native run (\S+):/)[1]
const statModeOf = p => lstatSync(p).mode & 0o777
const readJson = f => JSON.parse(readFileSync(f, 'utf8'))
const leafCalls = f => f.calls().filter(c => c.argv[0] === 'exec' && !c.argv.some(a => a.includes('model_provider="preflight"')))
const preflightCalls = f => f.calls().filter(c => c.argv.some(a => a.includes('model_provider="preflight"')))

const repo = mkRepo(TOY_FILES, 'toy')
const fake = fakeCodex('codex-ok')
const out = capture()
const code = await main(['run', repo, ...flags(fake.bin)], { log: out.log })
const RUN = code === 0 ? runDirOf(out) : null

await test('the toy audit runs from init to done on the fake codex, exit 0, and the three reports exist and are the run\'s own', { skip: NO_LINUX_STORES }, () => {
  assert.equal(code, 0, out.lines.join('\n'))
  assert.match(lastLine(out), /^AUDIT: DONE status=complete agents_spent=\d+ budget=60 reports=/)
  for (const f of ['REPORT.md', 'NEEDS-VALIDATION.md', 'FINDINGS-DETAIL.md']) assert.ok(readFileSync(join(RUN, f), 'utf8').length > 100, f)
  const report = readFileSync(join(RUN, 'REPORT.md'), 'utf8'), needs = readFileSync(join(RUN, 'NEEDS-VALIDATION.md'), 'utf8')
  assert.match(report, /The run is \*\*complete\*\*/)
  for (const fp of ['notes-byid-no-owner-check', 'files-name-unchecked-path-join', 'cors-origin-reflected-with-credentials']) assert.ok(needs.includes(fp), fp)
  assert.ok(!/config-service-key-literal/.test(needs), 'a rejected claim is not a lead')
  assert.equal(audit(['check', RUN]).last, `AUDIT: OK ${RUN} passes check`)
  assert.equal(audit(['next', RUN]).last, 'NEXT: done status=complete')
})

await test('the spend is the journal\'s: every leaf reserved, settled and counted once, and the critic ran as partitions plus a reconciliation', { skip: NO_LINUX_STORES }, () => {
  const journal = readAuditJournal(RUN), m = meta(RUN)
  assert.equal(m.agents_spent, journal.settledCalls)
  assert.equal(leafCalls(fake).length, journal.settledCalls)
  assert.equal(new Set(journal.rows.map(r => r.id)).size, journal.rows.length)
  assert.equal(Object.values(m.stage_spend).reduce((a, b) => a + b, 0), m.agents_spent)
  const critics = readdirSync(join(RUN, 'stages')).filter(n => /-critic-/.test(n))
  assert.equal(critics.length, 3, 'post-wave x2 and the final-clean critic')
  for (const stage of critics) {
    const manifest = readJson(join(RUN, 'stages', stage, 'critic-manifest.json'))
    assert.equal(manifest.partitions.length, 1)
    assert.equal(m.stage_spend[stage], manifest.partitions.length + 1)
  }
  assert.equal(m.run_status, 'complete')
})

await test('the preflight ran first on the exact leaf argv, once per model, and every leaf got the restricted argv with no secret in it', { skip: NO_LINUX_STORES }, () => {
  const all = fake.calls()
  const firstLeaf = all.findIndex(c => c.argv[0] === 'exec' && !c.argv.some(a => a.includes('model_provider="preflight"')))
  const pre = preflightCalls(fake)
  assert.equal(pre.length, 1, 'one model, one preflight')
  assert.ok(all.indexOf(pre[0]) < firstLeaf, 'the preflight precedes the first leaf')
  for (const call of leafCalls(fake)) {
    const a = call.argv
    assert.equal(a[a.indexOf('--sandbox') + 1], 'read-only')
    for (const f of ['shell_tool', 'unified_exec', 'multi_agent', 'apps', 'plugins']) assert.ok(a.includes(f), `--disable ${f}`)
    assert.ok(a.some(x => x === 'web_search="disabled"') && a.some(x => x.startsWith('model_catalog_json=')))
    assert.ok(a.some(x => x.startsWith('mcp_servers.reader.url="http://127.0.0.1:')))
    assert.ok(!a.some(x => /workspace-write|danger-full-access|network_access/.test(x)))
    assert.ok(call.env.PANDASTACK_AUDIT_READER_KEY && !a.join(' ').includes(call.env.PANDASTACK_AUDIT_READER_KEY), 'the reader credential is in the environment, never argv')
    assert.equal(call.cwd, join(RUN, 'native-codex', 'cwd'), 'the leaf runs in the empty directory, not the repo or the snapshot')
    assert.ok(call.env.CODEX_HOME.startsWith(join(RUN, 'native-codex')) && call.env.HOME.startsWith(join(RUN, 'native-codex')))
  }
  assert.equal(new Set(leafCalls(fake).map(c => c.env.PANDASTACK_AUDIT_READER_KEY)).size, leafCalls(fake).length, 'a reader and credential per leaf')
})

await test('the credential is a symlink to the login file, never a copy; the cwd is empty; the receipts record the preflight', { skip: NO_LINUX_STORES }, () => {
  const link = join(RUN, 'native-codex', 'codex-home', 'auth.json')
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(readlinkSync(link), auth)
  assert.deepEqual(readdirSync(join(RUN, 'native-codex', 'cwd')), [])
  const receipt = readJson(join(RUN, 'native-codex', 'preflight.json'))
  assert.equal(receipt.codexVersion, '0.167.0'); assert.equal(receipt.versionPinned, true)
  assert.deepEqual(receipt.receipts.map(r => [r.model, r.ok]), [['gpt-6.1-sol', true]])
  assert.ok(!JSON.stringify(receipt).includes(AUTH_BYTES))
  assert.equal(statModeOf(join(RUN, 'native-codex')), 0o700)
})
await test('the audited repository was not touched, the run lives in its git directory, and the leads are at their planted lines', { skip: NO_LINUX_STORES }, () => {
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).stdout.trim()
  assert.equal(git('status', '--porcelain'), '')
  assert.ok(RUN.startsWith(join(repo, '.git', 'security-audit')))
  const needs = readFileSync(join(RUN, 'NEEDS-VALIDATION.md'), 'utf8')
  for (const fp of ['notes-byid-no-owner-check', 'files-name-unchecked-path-join', 'cors-origin-reflected-with-credentials']) assert.ok(needs.includes(`${PLANTED[fp].file}:${PLANTED[fp].line}`))
})

await test('a failed wire preflight refuses before any leaf: exit 1, the problem named, no journal row, no model call', { skip: NO_LINUX_STORES }, async () => {
  const bad = fakeCodex('codex-exec-command', { FAKE_CODEX_WIRE: 'exec_command' })
  const o = capture()
  const rc = await main(['run', mkRepo(TOY_FILES, 'toy-refused'), ...flags(bad.bin)], { log: o.log })
  assert.equal(rc, 1)
  assert.match(o.lines.join('\n'), /nested-in-exec tools outside the allowed set: exec_command/)
  assert.equal(leafCalls(bad).length, 0)
  const dir = runDirOf(o)
  assert.equal(readAuditJournal(dir).rows.length, 0)
  assert.equal(readJson(join(dir, 'native-codex', 'preflight.json')).receipts[0].ok, false)
  assert.equal(meta(dir).agents_spent, 0)
})

await test('a model the catalog lacks is refused before any leaf, and an unpinned codex version passes only by its preflight', { skip: NO_LINUX_STORES }, async () => {
  const none = fakeCodex('codex-no-model', { FAKE_CODEX_MODELS: 'some-other-model' })
  const o = capture()
  assert.equal(await main(['run', mkRepo(TOY_FILES, 'toy-nomodel'), ...flags(none.bin)], { log: o.log }), 1)
  assert.match(o.lines.join('\n'), /no entry for this model/)
  assert.equal(leafCalls(none).length, 0)
  const unpinned = fakeCodex('codex-unpinned', { FAKE_CODEX_VERSION: '9.9.9', FAKE_CODEX_WIRE: 'exec_command' })
  const o2 = capture()
  assert.equal(await main(['run', mkRepo(TOY_FILES, 'toy-unpinned'), ...flags(unpinned.bin)], { log: o2.log }), 1)
  assert.equal(readJson(join(runDirOf(o2), 'native-codex', 'preflight.json')).versionPinned, false)
})

await test('a native run needs a finite budget and usage errors are exit 2; nothing is created', { skip: NO_LINUX_STORES }, async () => {
  const target = mkRepo(TOY_FILES, 'toy-nobudget')
  const o = capture()
  assert.equal(await main(['run', target, '--full', '--codex-bin', fake.bin, '--auth-file', auth], { log: o.log }), 1)
  assert.match(o.lines.join('\n'), /needs --budget N/)
  assert.ok(!existsSync(join(target, '.git', 'security-audit')))
  const quiet = { log() {} }, err = console.error; console.error = () => {}
  try { for (const argv of [[], ['nope'], ['run', target, '--budget', 'x'], ['resume'], ['resume', '/a', '/b'], ['run', target, '--full', '--budget', '10', '--grant', '5'], ['run', target, '--full', '--budget', '10', '--budget', '10']]) assert.equal(await main(argv, quiet), 2, argv.join(' ')) } finally { console.error = err }
  assert.throws(() => parseNativeArgs(['resume', '/run', '--max-budget', '9']))
})

await test('a budget pause stops with exit 3, and resume with --grant replays completed leaves and finishes without repeating one', { skip: NO_LINUX_STORES }, async () => {
  const target = mkRepo(TOY_FILES, 'toy-pause')
  const f = fakeCodex('codex-pause')
  const init = spawnSync(process.execPath, [join(HERE, '..', 'skills', 'security-audit', 'audit-run.mjs'), 'init', target, '--full', '--budget', '60', '--max-parallel', '2'], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stdout + init.stderr)
  const dir = init.stdout.split('\n')[0]
  mkdirSync(join(dir, 'native-codex'), { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'native-codex', 'native-run.json'), JSON.stringify({ version: 1, grant: 3, maxBudget: 60 }))
  const o = capture()
  assert.equal(await main(['resume', dir, '--codex-bin', f.bin, '--auth-file', auth], { log: o.log }), 3, o.lines.join('\n'))
  assert.match(lastLine(o), /^AUDIT: PAUSED blockers=paused_budget.*--grant/)
  const first = leafCalls(f).length
  assert.ok(first >= 1 && first <= 3, `leaves before the pause: ${first}`)
  const o2 = capture()
  assert.equal(await main(['resume', dir, '--grant', '60', '--codex-bin', f.bin, '--auth-file', auth], { log: o2.log }), 0, o2.lines.join('\n'))
  const journal = readAuditJournal(dir)
  assert.equal(leafCalls(f).length, journal.settledCalls, 'no leaf was called twice: replay is free')
  assert.equal(meta(dir).run_status, 'complete')
  const o3 = capture()
  assert.equal(await main(['resume', dir, '--grant', '61', '--codex-bin', f.bin, '--auth-file', auth], { log: o3.log }), 1, '--grant applies only to a paused run')
})

await test('the helper commands are the skill table\'s, argument for argument', () => {
  const table = stepCommands(skillText())
  for (const [step, command] of table) {
    if (step === 'done') continue
    const [script, ...args] = HELPER_COMMANDS[step]('$RUN')
    const expected = command.replace(/^node "\$AUDIT\/([^"]+)" /, '$1 ').replace(/"\$RUN"/g, '$RUN').replace(/"\$RUN\/([^"]+)"/g, '$RUN/$1')
    assert.equal([script, ...args].join(' '), expected, step)
  }
  assert.deepEqual(Object.keys(HELPER_COMMANDS).sort(), [...table.keys()].filter(s => s !== 'done').sort())
})
