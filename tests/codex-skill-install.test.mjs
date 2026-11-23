// codex-skill-install.test.mjs — offline proof for the codex-skill transport: the guidance and
// helper offerings listed in tests/fixtures/codex-expected-state.json (`skill`) run on Codex as installed
// skills. Proves, with an owned temp HOME and no network, provider, codex or claude process:
//   1. catalog: every codex-skill row carries the Claude row's limitation set (plus
//      NATIVE_UNVERIFIED only where the fixture lists it) and the transport row exists;
//   2. install: `install.sh --codex` links each one and its SKILL.md is readable and pinned;
//   3. hygiene: no installed SKILL.md sends Codex to ~/.claude or CLAUDE_SKILL_DIR without a
//      Codex alternative (the rule itself is tested on adversarial text first);
//   4. helpers: each helper that can run offline runs through the documented SKILL_DIR command
//      from the installed location. verify.sh, retention.sh and the capture helpers are never
//      executed here (syntax check only), nor the run-records doctor, which can probe `codex`.
// This is not a run of Codex: a skill staying NATIVE_UNVERIFIED means its helpers are not run here.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { installEligible, providerImplementation } from '../core/skills/native-runtime/catalog.mjs'
import { KEEP_NATIVE_UNVERIFIED, SKILL_IDS, SKILL_TRANSPORT } from './codex-expected-state.mjs'
const FIXTURE = { ids: SKILL_IDS, keepNativeUnverified: KEEP_NATIVE_UNVERIFIED, transport: SKILL_TRANSPORT }
const catalog = JSON.parse(readFileSync(join(REPO, 'spec/offering-capabilities.json'), 'utf8'))
const byId = new Map(catalog.offerings.map(o => [o.id, o]))
const rows = FIXTURE.ids.map(id => byId.get(id))
const sorted = list => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const TMP = realpathSync(tmpdir())

// ---------------------------------------------------------------- the hygiene rule

const IDIOM = /^(node|bash) "\$\{SKILL_DIR:-\$\{CLAUDE_SKILL_DIR\}\}\/([A-Za-z0-9._-]+)"(?: (.*))?$/
const HOME_PATH = /~\/\.claude|\$HOME\/\.claude|CLAUDE_CONFIG_DIR/
const PROJECT_PATH = /\.claude\//
const SKILL_DIR_TOKEN = /CLAUDE_SKILL_DIR/
const CLAUDE_TOOL = /AskUserQuestion|TodoWrite|subagent_type|\bSkill tool\b|ExitPlanMode|EnterPlanMode|claude -p|\bAgent tool\b|\bTask tool\b|\bWorkflow tool\b/
const SHELL_INJECTION = /!`/
const PINNED_PARAGRAPH = /^through its `CLAUDE_SKILL_DIR` substitution, so there the helper commands in$/

// Violations of "no Claude-only reference without a Codex alternative", as `line N: why`.
// A Codex alternative is an "On Codex" statement in the file. A home path (~/.claude,
// CLAUDE_CONFIG_DIR) is also refused unless its own line says it is the Claude Code case.
// CLAUDE_SKILL_DIR may appear only in a SKILL_DIR idiom line or the pinned paragraph.
export function claudeOnlyViolations(text) {
  const lines = text.split('\n')
  const hasCodexAlternative = /On Codex/.test(text)
  const out = []
  lines.forEach((line, i) => {
    const at = `line ${i + 1}`
    if (SKILL_DIR_TOKEN.test(line) && !IDIOM.test(line) && !PINNED_PARAGRAPH.test(line)) out.push(`${at}: CLAUDE_SKILL_DIR outside the idiom`)
    if (HOME_PATH.test(line)) {
      if (!(/Claude Code/.test(line) && hasCodexAlternative)) out.push(`${at}: Claude home path`)
    } else if (PROJECT_PATH.test(line) && !hasCodexAlternative) out.push(`${at}: .claude/ path with no Codex alternative`)
    if (CLAUDE_TOOL.test(line) && !hasCodexAlternative) out.push(`${at}: Claude-only tool with no Codex alternative`)
    if (SHELL_INJECTION.test(line) && !hasCodexAlternative) out.push(`${at}: Claude shell injection with no Codex alternative`)
  })
  return out
}

await test('the hygiene rule flags Claude-only references and accepts the SKILL_DIR idiom and labelled alternatives', () => {
  const idiom = 'node "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/helper.mjs" check x'
  assert.deepEqual(claudeOnlyViolations(idiom), [])
  assert.deepEqual(claudeOnlyViolations('through its `CLAUDE_SKILL_DIR` substitution, so there the helper commands in'), [])
  // bare and lookalike forms
  assert.equal(claudeOnlyViolations('node ~/.claude/skills/x/helper.mjs check').length, 1)
  assert.equal(claudeOnlyViolations('run `$HOME/.claude/skills/x`').length, 1)
  assert.equal(claudeOnlyViolations('node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/x/h.mjs"').length, 1)
  assert.equal(claudeOnlyViolations('node "${CLAUDE_SKILL_DIR}/h.mjs"').length, 1, 'the token alone, not nested as the idiom default')
  assert.equal(claudeOnlyViolations('Use `${CLAUDE_SKILL_DIR}` in prose').length, 1)
  assert.equal(claudeOnlyViolations('Ask with AskUserQuestion').length, 1)
  assert.equal(claudeOnlyViolations('- status: !`git status`').length, 1)
  assert.equal(claudeOnlyViolations('create `.claude/settings.local.json`').length, 1)
  // a Codex alternative makes project paths and tools acceptable, but never a bare home path
  const alt = 'On Codex: skip this.\ncreate `.claude/settings.local.json`\nuse the Agent tool'
  assert.deepEqual(claudeOnlyViolations(alt), [])
  assert.equal(claudeOnlyViolations(`${alt}\nnode ~/.claude/skills/x/h.mjs`).length, 1)
  assert.deepEqual(claudeOnlyViolations(`${alt}\nUnder Claude Code that is \${CLAUDE_CONFIG_DIR:-$HOME/.claude}/workflows/x.js`), [])
  // near misses are not references
  assert.deepEqual(claudeOnlyViolations('the claude backend and a .claudeignore file, see claude.yml'), [])
  assert.deepEqual(claudeOnlyViolations('Agent toolbox, Task toolkit'), [])
})

// ---------------------------------------------------------------- the catalog

await test('the fixture names exactly the codex rows on the codex-skill transport, 39 of them', () => {
  assert.equal(FIXTURE.ids.length, 39)
  assert.equal(new Set(FIXTURE.ids).size, 39)
  assert.deepEqual(sorted(catalog.offerings.filter(o => o.providers.codex.transportId === FIXTURE.transport.id).map(o => o.id)), sorted(FIXTURE.ids))
  assert.deepEqual(catalog.transports.filter(t => t.id === FIXTURE.transport.id), [FIXTURE.transport])
  assert.ok(existsSync(join(REPO, FIXTURE.transport.entry)), 'the transport entry exists')
  assert.deepEqual(FIXTURE.keepNativeUnverified.filter(id => !FIXTURE.ids.includes(id)), [], 'every kept-unverified id is a codex-skill id')
})

await test('every codex-skill row is partial with the Claude row\'s limitation set (NATIVE_UNVERIFIED only where listed)', () => {
  for (const row of rows) {
    const { claude, codex } = row.providers
    assert.equal(codex.implementation, 'partial', `${row.id} implementation`)
    assert.equal(codex.transportId, 'codex-skill', `${row.id} transport`)
    const unverified = FIXTURE.keepNativeUnverified.includes(row.id)
    assert.deepEqual(codex.limitations.filter(l => l !== 'NATIVE_UNVERIFIED'), claude.limitations, `${row.id}: the Claude limitation set`)
    assert.equal(codex.limitations.includes('NATIVE_UNVERIFIED'), unverified, `${row.id}: NATIVE_UNVERIFIED iff listed`)
    assert.deepEqual(codex.limitations, sorted(codex.limitations), `${row.id}: sorted`)
    for (const dropped of ['NO_PROVIDER_TRANSPORT', 'NO_NATIVE_ENTRY', 'PROFILE_UNSUPPORTED']) {
      assert.ok(!codex.limitations.includes(dropped), `${row.id} no ${dropped}`)
    }
    assert.equal(codex.limitations.includes('LIBRARY_ONLY'), !row.entrySkill, `${row.id}: library rows keep LIBRARY_ONLY`)
    assert.equal(claude.limitations.includes('LIBRARY_ONLY'), !row.entrySkill, `${row.id}: claude library rule`)
    assert.equal(installEligible(row, 'codex'), true, `${row.id} install eligible`)
    assert.equal(providerImplementation(row, 'codex'), 'partial', `${row.id} accessor`)
  }
})

await test('no codex-skill row claims a graph or CLI runtime: they carry no codex-graph-host, autobuild or bughunt transport', () => {
  for (const row of catalog.offerings) {
    const id = row.providers.codex.transportId
    if (['codex-autobuild', 'codex-bughunt', 'codex-graph-host'].includes(id)) assert.ok(!FIXTURE.ids.includes(row.id), row.id)
  }
})

// ---------------------------------------------------------------- the install

function ownedHome() {
  const home = mkdtempSync(join(TMP, 'codex-skill-'))
  const skills = join(home, '.agents', 'skills')
  const env = { ...process.env, HOME: home, PANDASTACK_CODEX_SKILLS_DIR: skills, HARNESS_NO_GIT_CONFIG: '1' }
  for (const k of ['CLAUDE_CONFIG_DIR', 'PANDASTACK_BIN_DIR', 'CLAUDE_SKILL_DIR', 'SKILL_DIR']) delete env[k]
  const install = (args = []) => spawnSync('bash', [join(REPO, 'install.sh'), '--codex', ...args], { encoding: 'utf8', env })
  return { home, skills, env, install }
}

const fixtureHome = ownedHome()
const installed = fixtureHome.install()
assert.equal(installed.status, 0, installed.stdout + installed.stderr)
const link = id => join(fixtureHome.skills, id)

await test('install.sh --codex links every codex-skill offering to its source; libraries link without a SKILL.md', () => {
  for (const row of rows) {
    assert.equal(lstatSync(link(row.id)).isSymbolicLink(), true, `${row.id} is a symlink`)
    assert.equal(readlinkSync(link(row.id)), join(REPO, row.source), `${row.id} -> its source`)
    assert.equal(existsSync(join(link(row.id), 'SKILL.md')), row.entrySkill, `${row.id}: SKILL.md present iff an entry skill`)
    assert.ok(readdirSync(link(row.id)).length > 0, `${row.id}: the directory is readable`)
  }
  const names = sorted(readdirSync(fixtureHome.skills))
  for (const row of rows) assert.ok(names.includes(row.id))
  assert.equal(existsSync(join(fixtureHome.home, '.claude')), false, 'nothing under ~/.claude')
})

await test('each installed SKILL.md is readable through the link, pinned by the catalog and starts with its own frontmatter', () => {
  for (const row of rows.filter(r => r.entrySkill)) {
    const bytes = readFileSync(join(link(row.id), 'SKILL.md'))
    assert.equal(sha(bytes), row.entrySha256, `${row.id}: entrySha256`)
    const text = bytes.toString('utf8')
    assert.ok(text.startsWith('---\n'), `${row.id}: frontmatter`)
    assert.match(text.split('\n---\n')[0], new RegExp(`^---\\nname: ${row.id}$`, 'm'), `${row.id}: name matches the offering id`)
  }
})

await test('no installed SKILL.md of a codex-skill offering sends Codex to a Claude-only path, tool or injection', () => {
  const bad = []
  for (const row of rows.filter(r => r.entrySkill)) {
    for (const why of claudeOnlyViolations(readFileSync(join(link(row.id), 'SKILL.md'), 'utf8'))) bad.push(`${row.id} ${why}`)
  }
  assert.deepEqual(bad, [])
})

await test('every documented helper command in an installed SKILL.md is the SKILL_DIR idiom and names a helper that exists', () => {
  for (const row of rows.filter(r => r.entrySkill)) {
    const text = readFileSync(join(link(row.id), 'SKILL.md'), 'utf8')
    let fenced = false
    for (const line of text.split('\n')) {
      if (/^```/.test(line)) { fenced = !fenced; continue }
      const m = fenced ? IDIOM.exec(line) : null
      if (m) assert.ok(existsSync(join(link(row.id), m[2])), `${row.id}: documented helper ${m[2]} exists`)
    }
  }
})

// ---------------------------------------------------------------- helpers, run from the installed location

// The first documented idiom prefix of an installed SKILL.md, e.g. `node "${SKILL_DIR:-...}/backlog.mjs"`.
function documentedPrefix(id) {
  const text = readFileSync(join(link(id), 'SKILL.md'), 'utf8')
  for (const line of text.split('\n')) {
    const m = IDIOM.exec(line)
    if (m) return line.slice(0, line.length - (m[3] === undefined ? 0 : m[3].length + 1))
  }
  assert.fail(`${id}: no SKILL_DIR idiom line`)
}
// Runs the documented command the Codex way: SKILL_DIR set to the installed skill directory, no CLAUDE_* variable.
function runDocumented(id, args, extraEnv = {}) {
  const env = { ...fixtureHome.env, ...extraEnv }
  return spawnSync('bash', ['-c', `SKILL_DIR="$1"; shift; ${documentedPrefix(id)} "$@"`, '_', link(id), ...args], { encoding: 'utf8', env, cwd: fixtureHome.home })
}
const noModuleError = r => assert.doesNotMatch(r.stdout + r.stderr, /Cannot find module|ERR_MODULE_NOT_FOUND|No such file or directory|command not found/)

await test('backlog, findings and gtm-brief run from the installed location and refuse a missing input with their verdict line', () => {
  for (const [id, arg, verdict] of [['backlog', 'docs/none.json', 'BACKLOG: FAIL'], ['findings', 'none.json', 'FINDINGS: FAIL'],
    ['gtm-brief', 'docs/none.md', 'GTM-BRIEF: FAIL']]) {
    const r = runDocumented(id, ['check', arg])
    noModuleError(r)
    assert.equal(r.status, 1, `${id}: ${r.stdout}${r.stderr}`)
    assert.equal(r.stdout.trimEnd().split('\n').pop(), verdict, id)
  }
})

await test('seo-check runs from the installed location on a built directory and ends in its verdict line', () => {
  const site = join(fixtureHome.home, 'site')
  mkdirSync(site)
  writeFileSync(join(site, 'index.html'), '<!doctype html><html lang="en"><head><title>Test page title for the proof</title></head><body>x</body></html>\n')
  const r = runDocumented('seo-check', ['check', site, '--site', 'https://example.com'])
  noModuleError(r)
  assert.ok([0, 1].includes(r.status), `${r.status} ${r.stderr}`)
  assert.match(r.stdout.trimEnd().split('\n').pop(), /^SEO-CHECK: (PASS|FAIL)$/)
  assert.equal(r.status, r.stdout.includes('SEO-CHECK: PASS') ? 0 : 1)
})

await test('render runs from the installed location and refuses a missing key file before any network call', () => {
  const r = runDocumented('render', ['services'], { RENDER_API_KEY_FILE: join(fixtureHome.home, 'no-such-key'), RENDER_API_BASE: 'http://127.0.0.1:9' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stderr, /API key file missing/)
  assert.equal(r.stdout, '')
})

await test('workflow-state run-script runs from the installed location and writes only the seam line', () => {
  const dir = mkdtempSync(join(fixtureHome.home, 'ws-'))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ plan: ['a', 'b'] }))
  writeFileSync(join(dir, 'wf.js'), "export const meta = { name: 'x' }\nconst INJECTED_PLAN = null\nreturn INJECTED_PLAN\n")
  const out = join(dir, 'out.js')
  const r = runDocumented('workflow-state', ['INJECTED_PLAN', join(dir, 'state.json'), join(dir, 'wf.js'), out])
  noModuleError(r)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^run-script: wrote /)
  const before = readFileSync(join(dir, 'wf.js'), 'utf8').split('\n'), after = readFileSync(out, 'utf8').split('\n')
  assert.equal(after.length, before.length)
  assert.deepEqual(after.map((l, i) => (l === before[i] ? null : i)).filter(i => i !== null), [1], 'only the seam line differs')
  assert.match(after[1], /INJECTED_PLAN/)
  const bad = runDocumented('workflow-state', ['not-a-seam', join(dir, 'state.json'), join(dir, 'wf.js'), join(dir, 'never.js')])
  assert.equal(bad.status, 1)
  assert.equal(existsSync(join(dir, 'never.js')), false)
})

await test('native-runtime: the installed library prints the Codex plan and its preflight CLI shows its help', () => {
  // install-plan.mjs resolves its own realpath, so it runs through the link. preflight-cli.mjs compares
  // process.argv[1] to its real URL without realpath (a test forbids it importing node:fs), so through the
  // link it would exit 0 and print nothing; it is run from the link's real directory instead.
  const lib = link('native-runtime'), realLib = realpathSync(lib)
  assert.equal(realLib, join(REPO, 'core/skills/native-runtime'))
  const plan = spawnSync(process.execPath, [join(lib, 'install-plan.mjs'), '--installation-root', REPO, '--backend', 'codex'], { encoding: 'utf8', env: fixtureHome.env })
  assert.equal(plan.status, 0, plan.stderr)
  assert.equal(plan.stderr, '')
  const planned = plan.stdout.split('\n').filter(Boolean).map(l => l.split('\t')[0].slice('skills/'.length))
  for (const row of rows) assert.ok(planned.includes(row.id), `the plan holds ${row.id}`)
  const help = spawnSync(process.execPath, [join(realLib, 'preflight-cli.mjs'), '--help'], { encoding: 'utf8', env: fixtureHome.env })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /Usage: preflight-cli/)
  // A codex-skill library is refused as a library, never reported runnable.
  const preflight = spawnSync(process.execPath, [join(realLib, 'preflight-cli.mjs'), '--installation-root', REPO, '--skills-root', fixtureHome.skills,
    '--backend', 'codex', '--offering', 'decisions'], { encoding: 'utf8', env: fixtureHome.env })
  assert.equal(preflight.status, 2, preflight.stdout + preflight.stderr)
  assert.ok(JSON.parse(preflight.stdout).refusal.reasons.includes('LIBRARY_ONLY'))
})

await test('verify stays NATIVE_UNVERIFIED: its scripts are present and parse, and none is executed here', () => {
  assert.ok(FIXTURE.keepNativeUnverified.includes('verify'))
  for (const script of ['verify.sh', 'retention.sh', 'capture-owner.sh']) {
    const file = join(link('verify'), script)
    assert.ok(existsSync(file), script)
    const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${script}: ${r.stderr}`)
  }
})

await test('uninstall removes every link it made and leaves the HOME otherwise empty', () => {
  const r = fixtureHome.install(['--uninstall'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  for (const row of rows) assert.equal(existsSync(link(row.id)) || (() => { try { lstatSync(link(row.id)); return true } catch { return false } })(), false, row.id)
  rmSync(fixtureHome.home, { recursive: true, force: true })
})
