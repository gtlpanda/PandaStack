// CP-03d frozen acceptance: provider-neutral skill paths in role bodies
// (spec/contracts/codex-parity-cp-03d.md). The role loader rewrites the exact
// skill-path token to the skill file in the installation tree; the raw role body
// keeps the token, whose shell default is today's Claude path. Real-tree cases read
// the shipped files under PANDASTACK_CANDIDATE_ROOT and derive role sets from the
// catalog. Fixture cases use owned temp roots. Shell cases run bash and sh with an
// explicit environment (temp HOME and PATH only). Wiring proof, not runtime
// certification: no real HOME, network or provider.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const loadModule = () => import(pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/role-files.mjs')))

// The hunt runner's strip rule (CP-03c rule 2).
const STRIP = /^---\n[\s\S]*?\n---\n/
const strip = text => text.replace(STRIP, '')
const skillBodyOf = text => strip(text).replace(/^\n+/, '')

// The contract's token, written independently of the module under test.
const TOKEN = /\$\{PANDASTACK_SKILL_PATH:-\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}\/skills\/([a-z0-9][a-z0-9-]{0,63})\/([A-Za-z0-9._-]+)\}/g
const token = (id, file) => '${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/' + id + '/' + file + '}'
const TODAY = (id, file) => '${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/' + id + '/' + file
const MENTION = /skills\/([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9._-]+)?/g
const VERIFY_ROLES = ['checker', 'fixer', 'implementer']
const NAMED_WORKFLOWS = ['graphs/qa/workflows/harness-repair.js', 'graphs/blueprint/workflows/blueprint-design.js',
  'graphs/dev/workflows/dev-build.js']

const throwsCode = (fn, code, label) =>
  assert.throws(fn, e => e.code === code && e.message === `Native runtime: ${code}.`, label ?? `expected ${code}`)

// ---- disk readers independent of the module under test --------------------

const graphDirs = () => readdirSync(join(ROOT, 'graphs'), { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name).sort()
const agentDirs = () => ['core/agents', 'kit/agents', ...graphDirs().map(g => `graphs/${g}/agents`)]
  .filter(d => existsSync(join(ROOT, d)))
const skillRoots = () => ['core/skills', 'kit/skills', ...graphDirs().map(g => `graphs/${g}/skills`)]

function diskRoles() {
  const rows = []
  for (const dir of agentDirs()) {
    for (const file of readdirSync(join(ROOT, dir)).filter(f => f.endsWith('.md')).sort()) {
      rows.push({ stem: file.slice(0, -3), path: `${dir}/${file}`, text: readFileSync(join(ROOT, dir, file), 'utf8') })
    }
  }
  return rows
}
const declaredSkills = text => {
  const lines = text.match(STRIP)[0].split('\n').slice(1, -2), at = lines.indexOf('skills:')
  if (at < 0) return []
  const names = []
  for (const line of lines.slice(at + 1)) { if (!line.startsWith('  - ')) break; names.push(line.slice(4)) }
  return names
}
function diskSkillRoot(id) {
  const hits = skillRoots().filter(r => existsSync(join(ROOT, r, id, 'SKILL.md')))
  assert.equal(hits.length, 1, `skill ${id} has exactly one SKILL.md on disk`)
  return hits[0]
}
// The contract's rewrite over the CP-03c text, against the real tree.
function expectedInstructions(row) {
  const bodies = declaredSkills(row.text).map(id => skillBodyOf(readFileSync(join(ROOT, diskSkillRoot(id), id, 'SKILL.md'), 'utf8')))
  return [strip(row.text), ...bodies].join('\n').replace(TOKEN, (_, id, file) => {
    const target = join(ROOT, diskSkillRoot(id), id, file)
    assert.ok(lstatSync(target).isFile(), `${row.path}: token target skills/${id}/${file} is a regular file`)
    return target
  })
}
const catalogRoles = sources => {
  const catalog = JSON.parse(readFileSync(join(ROOT, 'spec/offering-capabilities.json'), 'utf8'))
  const rows = catalog.workflows.filter(w => sources.includes(w.source))
  assert.equal(rows.length, sources.length, 'every named workflow has a catalog row')
  return [...new Set(rows.flatMap(w => w.roles))].sort()
}

// ---- fixture installation roots --------------------------------------------

const roleText = (name, body, lines = []) =>
  `---\nname: ${name}\ndescription: A fixture role\nmodel: sonnet\n${lines.map(l => `${l}\n`).join('')}---\n${body}`
const skillText = (name, body = '\n# fixture skill\n') => `---\nname: ${name}\ndescription: routing metadata only\n---\n${body}`

function owned(t, prefix = 'cp-03d-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
// files: { rel: text | { symlinkTo: absolute } | { dir: true } }
function build(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    if (typeof content === 'string') writeFileSync(file, content)
    else if (content.dir) mkdirSync(file, { recursive: true })
    else symlinkSync(content.symlinkTo, file)
  }
  return root
}
const fixture = (t, files) => build(owned(t), files)

function shell(program, script, env) {
  const r = spawnSync(program, ['-c', script], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout }
}

// ---- real tree ----------------------------------------------------------------

test('checker, fixer and implementer run verify.sh from the installation tree; the advisor points at backlog there', async () => {
  const api = await loadModule()
  const verify = `bash "${join(ROOT, 'core/skills/verify/verify.sh')}"`
  for (const name of VERIFY_ROLES) {
    const result = api.assembleRoleInstructions({ installationRoot: ROOT, name })
    assert.ok(result.instructions.includes(verify), `${name}: instructions run ${verify}`)
    assert.ok(result.body.includes(`bash "${token('verify', 'verify.sh')}"`), `${name}: the raw body keeps the token`)
    assert.ok(!result.instructions.includes('PANDASTACK_SKILL_PATH'), `${name}: no token survives`)
  }
  const advisor = api.assembleRoleInstructions({ installationRoot: ROOT, name: 'advisor' })
  assert.ok(advisor.instructions.includes(join(ROOT, 'core/skills/backlog/SKILL.md')), 'advisor: backlog path in the tree')
  assert.ok(advisor.body.includes(token('backlog', 'SKILL.md')), 'advisor: the raw body keeps the token')
})

// Amended (user-authorized correction of this frozen test): the check scans the instruction TEXT for a Claude
// path. The instructions embed absolute paths into the installation tree, so a checkout that itself lives under
// a `.claude` directory (a Claude Code worktree) put `.claude` in every one of them and failed the check for a
// reason that has nothing to do with the roles. The tree's own path is removed before scanning; any `.claude`,
// CLAUDE_CONFIG_DIR or PANDASTACK_SKILL_PATH left in the text is a real reference and still fails.
const CLAUDE_PATH_NEEDLES = ['.claude', 'CLAUDE_CONFIG_DIR', 'PANDASTACK_SKILL_PATH']
function claudePathLeaks(instructions, root) {
  const trees = [...new Set([resolve(root), realpathSync(root)])].sort((a, b) => b.length - a.length)
  const text = trees.reduce((out, tree) => out.split(tree).join('<installation-root>'), instructions)
  return CLAUDE_PATH_NEEDLES.filter(needle => text.includes(needle))
}

test('no role of harness-repair, blueprint-design or dev-build names a Claude path in its instructions', async () => {
  const api = await loadModule()
  const roles = catalogRoles(NAMED_WORKFLOWS)
  for (const name of ['advisor', ...VERIFY_ROLES]) assert.ok(roles.includes(name), `${name} is in the named workflows`)
  for (const name of roles) {
    const { instructions } = api.assembleRoleInstructions({ installationRoot: ROOT, name })
    assert.deepEqual(claudePathLeaks(instructions, ROOT), [], `${name}: instructions name a Claude path`)
  }
})

test('the Claude-path check ignores the checkout\'s own location (a root under a .claude directory passes) and still catches a real reference', async t => {
  const api = await loadModule()
  const roleFiles = {
    'core/agents/clean.md': roleText('clean', `\nRun \`bash "${token('verify', 'verify.sh')}"\`.\n`),
    'core/skills/verify/SKILL.md': skillText('verify'),
    'core/skills/verify/verify.sh': 'printf ok\n',
  }
  // The same installation tree, once in a plain temp directory and once under <tmp>/.claude/worktrees/.
  const plain = build(owned(t), roleFiles)
  const underClaude = build(join(owned(t), '.claude', 'worktrees', 'agent-x'), roleFiles)
  assert.ok(underClaude.includes('/.claude/'), 'fixture: the root path contains .claude')
  for (const root of [plain, underClaude]) {
    const { instructions } = api.assembleRoleInstructions({ installationRoot: root, name: 'clean' })
    assert.ok(instructions.includes(join(root, 'core/skills/verify/verify.sh')), 'the token became the tree path')
    assert.deepEqual(claudePathLeaks(instructions, root), [], `no leak in ${root}`)
    assert.deepEqual(claudePathLeaks(`${instructions}\n${root}/`, `${root}/`), [], 'a trailing slash on the root changes nothing')
  }

  // A real Claude path in the role text is caught in both places: written out, as the config dir, or as the token.
  for (const [label, text] of [['a literal ~/.claude path', 'bash ~/.claude/skills/verify/verify.sh'],
    ['$HOME/.claude', 'bash "$HOME/.claude/skills/verify/verify.sh"'],
    ['CLAUDE_CONFIG_DIR', 'bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/verify/verify.sh"'],
    ['a near-miss token the loader leaves alone', 'bash "${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/ghost/sub/run.sh}"']]) {
    for (const base of [owned(t), join(owned(t), '.claude', 'worktrees', 'agent-y')]) {
      const root = build(base, { ...roleFiles, 'core/agents/leaky.md': roleText('leaky', `\nRun \`${text}\`.\n`) })
      const { instructions } = api.assembleRoleInstructions({ installationRoot: root, name: 'leaky' })
      assert.notDeepEqual(claudePathLeaks(instructions, root), [], `${label} is caught under ${base.includes('.claude') ? 'a .claude' : 'a plain'} root`)
    }
  }
  // The tree path itself is the only thing removed: a .claude directory INSIDE the tree is still a reference.
  const inner = build(owned(t), roleFiles)
  assert.deepEqual(claudePathLeaks(`Open ${inner}/.claude/settings.json`, inner), ['.claude'])
})

test('every shipped role assembles to the rewritten CP-03c text; bodies stay raw; the hunter equals the runner strip', async () => {
  const api = await loadModule()
  const disk = diskRoles()
  assert.ok(disk.length > 0)
  assert.equal(api.listRoleFiles({ installationRoot: ROOT }).length, disk.length)
  for (const row of disk) {
    const result = api.assembleRoleInstructions({ installationRoot: ROOT, name: row.stem })
    assert.equal(result.body, strip(row.text), `${row.path}: body is the raw strip`)
    for (const skill of result.skills) {
      assert.equal(skill.body, skillBodyOf(readFileSync(join(ROOT, skill.path), 'utf8')), `${row.path}: ${skill.name} body is raw`)
    }
    assert.equal(result.instructions, expectedInstructions(row), row.path)
  }
  const runner = readFileSync(join(ROOT, 'graphs/hunt/skills/bughunt/native-runner.mjs'), 'utf8')
  assert.ok(runner.includes(String.raw`.replace(/^---\n[\s\S]*?\n---\n/, '')`))
  const hunter = readFileSync(join(ROOT, 'graphs/hunt/agents/hunter.md'), 'utf8')
  const lenses = skillBodyOf(readFileSync(join(ROOT, 'core/skills/bug-lenses/SKILL.md'), 'utf8'))
  const result = api.assembleRoleInstructions({ installationRoot: ROOT, name: 'hunter' })
  assert.equal(result.body, strip(hunter))
  assert.equal(result.instructions, `${strip(hunter)}\n${lenses}`)
})

test('CP-03b still reads the skill paths in the raw bodies, and they exist', async () => {
  const api = await loadModule()
  const expected = { checker: 'verify/verify.sh', fixer: 'verify/verify.sh', implementer: 'verify/verify.sh', advisor: 'backlog/SKILL.md' }
  for (const [name, path] of Object.entries(expected)) {
    const { body } = api.loadRoleFile({ installationRoot: ROOT, name })
    const found = [...body.matchAll(MENTION)].map(m => `${m[1]}/${m[2] ?? ''}`)
    assert.ok(found.includes(path), `${name}: mentions skills/${path}`)
    assert.ok(lstatSync(join(ROOT, 'core/skills', path)).isFile(), `core/skills/${path} is a regular file`)
  }
})

test('the shipped token expands under bash and sh exactly as today, for every CLAUDE_CONFIG_DIR state', async t => {
  const api = await loadModule()
  const { body } = api.loadRoleFile({ installationRoot: ROOT, name: 'checker' })
  const shipped = body.match(new RegExp(TOKEN.source))?.[0]
  assert.equal(shipped, token('verify', 'verify.sh'), 'checker carries the verify token')
  const home = owned(t), config = join(home, 'config dir')
  const states = [
    [{ HOME: home }, join(home, '.claude/skills/verify/verify.sh')],
    [{ HOME: home, CLAUDE_CONFIG_DIR: config }, join(config, 'skills/verify/verify.sh')],
    [{ HOME: home, CLAUDE_CONFIG_DIR: '' }, join(home, '.claude/skills/verify/verify.sh')],
  ]
  for (const program of ['bash', 'sh']) {
    for (const [env, path] of states) {
      const now = shell(program, `printf '%s' "${shipped}"`, env)
      const before = shell(program, `printf '%s' "${TODAY('verify', 'verify.sh')}"`, env)
      assert.equal(now.status, 0, `${program} ${JSON.stringify(env)}`)
      assert.equal(now.stdout, path, `${program} ${JSON.stringify(env)}`)
      assert.equal(now.stdout, before.stdout, `${program}: identical to today's form`)
    }
  }
})

// ---- fixtures: rewrite ----------------------------------------------------------

test('tokens in any skills root, repeated tokens and tokens in a SKILL.md are rewritten; bodies stay raw', async t => {
  const api = await loadModule()
  const body = `\nRun \`bash "${token('alpha', 'run.sh')}"\`.\nThen \`${token('beta', 'tool.mjs')}\` and ${token('gamma', 'SKILL.md')}.\nAgain "${token('alpha', 'run.sh')}".\n`
  const skillBody = `\n# delta\n\nUse \`${token('alpha', 'run.sh')}\`.\n`
  const root = fixture(t, {
    'core/agents/multi.md': roleText('multi', body, ['skills:', '  - delta']),
    'core/skills/alpha/SKILL.md': skillText('alpha'),
    'core/skills/alpha/run.sh': 'printf alpha\n',
    'kit/skills/beta/SKILL.md': skillText('beta'),
    'kit/skills/beta/tool.mjs': '// tool\n',
    'graphs/g/skills/gamma/SKILL.md': skillText('gamma'),
    'graphs/g/skills/delta/SKILL.md': skillText('delta', skillBody),
  })
  const alpha = join(root, 'core/skills/alpha/run.sh')
  const expected = `\nRun \`bash "${alpha}"\`.\nThen \`${join(root, 'kit/skills/beta/tool.mjs')}\` and ${join(root, 'graphs/g/skills/gamma/SKILL.md')}.\nAgain "${alpha}".\n` +
    `\n# delta\n\nUse \`${alpha}\`.\n`
  for (const installationRoot of [root, `${root}/`]) {
    const result = api.assembleRoleInstructions({ installationRoot, name: 'multi' })
    assert.equal(result.instructions, expected, `root ${installationRoot === root ? 'plain' : 'with a trailing slash'}`)
    assert.equal(result.body, body, 'body keeps the tokens')
    assert.deepEqual(result.skills, [{ name: 'delta', path: 'graphs/g/skills/delta/SKILL.md', body: skillBody.replace(/^\n+/, '') }])
  }
  assert.equal(api.loadRoleFile({ installationRoot: root, name: 'multi' }).body, body)
})

test('a rewritten command runs the skill file in a Codex HOME; the raw command needs a Claude layout', async t => {
  const api = await loadModule()
  const root = fixture(t, {
    'core/agents/runs.md': roleText('runs', `\nRun \`bash "${token('verify', 'verify.sh')}"\` now.\n`),
    'core/skills/verify/SKILL.md': skillText('verify'),
    'core/skills/verify/verify.sh': "printf 'REPO-COPY'\n",
  })
  const codexHome = owned(t)
  const claudeHome = build(owned(t), { '.claude/skills/verify/verify.sh': "printf 'CLAUDE-COPY'\n" })
  const command = text => text.match(/`(bash "[^`]*")`/)[1]
  const result = api.assembleRoleInstructions({ installationRoot: root, name: 'runs' })
  assert.equal(command(result.instructions), `bash "${join(root, 'core/skills/verify/verify.sh')}"`)
  assert.deepEqual(shell('bash', command(result.instructions), { HOME: codexHome }), { status: 0, stdout: 'REPO-COPY' })
  assert.equal(shell('bash', command(result.body), { HOME: codexHome }).status, 127, 'the raw path does not exist in a Codex HOME')
  assert.deepEqual(shell('bash', command(result.body), { HOME: claudeHome }), { status: 0, stdout: 'CLAUDE-COPY' })
})

test('near-miss text is untouched and never looked up', async t => {
  const api = await loadModule()
  const tail = '/.claude}/skills/ghost/run.sh}'
  const nearMisses = [
    '${PANDASTACK_SKILL_PATH:- ${CLAUDE_CONFIG_DIR:-$HOME' + tail,
    '${PANDASTACK_SKILL_PATH :-${CLAUDE_CONFIG_DIR:-$HOME' + tail,
    '${ PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-$HOME' + tail,
    '${PANDASTACK_SKILLS_PATH:-${CLAUDE_CONFIG_DIR:-$HOME' + tail,
    '${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_HOME:-$HOME' + tail,
    '${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-${HOME}' + tail,
    '${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-~' + tail,
    '${PANDASTACK_SKILL_PATH-${CLAUDE_CONFIG_DIR:-$HOME' + tail,
    '${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/ghost/run.sh',
    '${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/ghost/run.sh }',
    '${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/ghost/sub/run.sh}',
    '${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Ghost/run.sh}',
    '${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/' + 'g'.repeat(65) + '/run.sh}',
    '${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills//run.sh}',
    '${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/ghost/run.sh',
    '$HOME/.claude/skills/ghost/run.sh',
    '~/.claude/skills/ghost/run.sh',
  ]
  const files = {}
  nearMisses.forEach((text, i) => { files[`core/agents/near${i}.md`] = roleText(`near${i}`, `\nRun \`bash "${text}"\`.\n`) })
  const root = fixture(t, files)
  nearMisses.forEach((text, i) => {
    const result = api.assembleRoleInstructions({ installationRoot: root, name: `near${i}` })
    assert.equal(result.instructions, result.body, `untouched: ${text}`)
    assert.ok(result.instructions.includes(text), `kept verbatim: ${text}`)
  })
})

// ---- fixtures: fail closed ------------------------------------------------------

test('a token that does not resolve to one regular file fails closed; loadRoleFile still loads the role', async t => {
  const api = await loadModule()
  const outside = build(owned(t), { 'run.sh': 'printf outside\n', 'skill/SKILL.md': skillText('linkd'), 'skill/run.sh': 'printf x\n' })
  const cases = {
    unknown: ['ghost', 'run.sh', 'UNKNOWN_SKILL'],
    missing: ['verify', 'absent.sh', 'UNKNOWN_SKILL'],
    linkfile: ['linkf', 'run.sh', 'UNKNOWN_SKILL'],
    dirnamed: ['dirf', 'verify.sh', 'UNKNOWN_SKILL'],
    dot: ['verify', '.', 'UNKNOWN_SKILL'],
    dotdot: ['verify', '..', 'UNKNOWN_SKILL'],
    bare: ['bare', 'run.sh', 'UNKNOWN_SKILL'],
    linkdir: ['linkd', 'run.sh', 'UNKNOWN_SKILL'],
    twin: ['twin', 'run.sh', 'DUPLICATE_SKILL'],
  }
  const files = {
    'core/skills/verify/SKILL.md': skillText('verify'),
    'core/skills/verify/verify.sh': 'printf ok\n',
    'core/skills/linkf/SKILL.md': skillText('linkf'),
    'core/skills/linkf/run.sh': { symlinkTo: join(outside, 'run.sh') },
    'core/skills/dirf/SKILL.md': skillText('dirf'),
    'core/skills/dirf/verify.sh': { dir: true },
    'core/skills/bare/run.sh': 'printf bare\n',
    'core/skills/linkd': { symlinkTo: join(outside, 'skill') },
    'core/skills/twin/SKILL.md': skillText('twin'),
    'core/skills/twin/run.sh': 'printf a\n',
    'kit/skills/twin/SKILL.md': skillText('twin'),
    'kit/skills/twin/run.sh': 'printf b\n',
    'core/agents/control.md': roleText('control', `\nRun \`bash "${token('verify', 'verify.sh')}"\`.\n`),
  }
  for (const [name, [id, file]] of Object.entries(cases)) files[`core/agents/${name}.md`] = roleText(name, `\nRun \`bash "${token(id, file)}"\`.\n`)
  const root = fixture(t, files)
  assert.ok(api.assembleRoleInstructions({ installationRoot: root, name: 'control' }).instructions
    .includes(join(root, 'core/skills/verify/verify.sh')), 'the control role resolves')
  for (const [name, [, , code]] of Object.entries(cases)) {
    assert.ok(api.loadRoleFile({ installationRoot: root, name }).body.includes('PANDASTACK_SKILL_PATH'), `${name}: loads raw`)
    throwsCode(() => api.assembleRoleInstructions({ installationRoot: root, name }), code, `${name}: ${code}`)
  }
})

test('an installation root with a character special inside double quotes fails closed before any lookup', async t => {
  const api = await loadModule()
  const parent = owned(t)
  for (const ch of ['"', '$', '`', '\\', '\n']) {
    const label = JSON.stringify(ch)
    const root = join(parent, `root${ch}x`)
    build(root, {
      'core/agents/tokened.md': roleText('tokened', `\nRun \`bash "${token('verify', 'verify.sh')}"\`.\n`),
      'core/agents/dangling.md': roleText('dangling', `\nRun \`bash "${token('ghost', 'run.sh')}"\`.\n`),
      'core/agents/plain.md': roleText('plain', '\nNo skill path here.\n'),
      'core/skills/verify/SKILL.md': skillText('verify'),
      'core/skills/verify/verify.sh': 'printf ok\n',
    })
    throwsCode(() => api.assembleRoleInstructions({ installationRoot: root, name: 'tokened' }), 'INVALID_ROLE_ROOT', label)
    throwsCode(() => api.assembleRoleInstructions({ installationRoot: root, name: 'dangling' }), 'INVALID_ROLE_ROOT', `${label} before lookup`)
    assert.equal(api.assembleRoleInstructions({ installationRoot: root, name: 'plain' }).instructions, '\nNo skill path here.\n', `${label}: no token`)
    assert.equal(api.loadRoleFile({ installationRoot: root, name: 'tokened' }).name, 'tokened', `${label}: loadRoleFile`)
    assert.equal(api.listRoleFiles({ installationRoot: root }).length, 3, `${label}: listRoleFiles`)
  }
  // Spaces and other punctuation are fine: the path sits inside double quotes.
  const spaced = build(join(parent, "a dir (x) 'y' #z"), {
    'core/agents/tokened.md': roleText('tokened', `\nRun \`bash "${token('verify', 'verify.sh')}"\`.\n`),
    'core/skills/verify/SKILL.md': skillText('verify'),
    'core/skills/verify/verify.sh': 'printf ok\n',
  })
  assert.ok(api.assembleRoleInstructions({ installationRoot: spaced, name: 'tokened' }).instructions
    .includes(`bash "${join(spaced, 'core/skills/verify/verify.sh')}"`))
})

test('the target file is listed, never read: an unreadable file still resolves', async t => {
  const api = await loadModule()
  if (process.getuid?.() === 0) { t.diagnostic('unreadable-file case skipped: running as root'); return }
  const root = fixture(t, {
    'core/agents/lister.md': roleText('lister', `\nRun \`bash "${token('closed', 'run.sh')}"\`.\n`),
    'core/skills/closed/SKILL.md': skillText('closed'),
    'core/skills/closed/run.sh': 'printf closed\n',
  })
  const file = join(root, 'core/skills/closed/run.sh')
  chmodSync(file, 0o000)
  try {
    assert.equal(api.assembleRoleInstructions({ installationRoot: root, name: 'lister' }).instructions, `\nRun \`bash "${file}"\`.\n`)
  } finally { chmodSync(file, 0o600) }
})

test('an unreadable skill directory is IO_ERROR', async t => {
  const api = await loadModule()
  if (process.getuid?.() === 0) { t.diagnostic('unreadable-directory case skipped: running as root'); return }
  const root = fixture(t, {
    'core/agents/reader.md': roleText('reader', `\nRun \`bash "${token('locked', 'run.sh')}"\`.\n`),
    'core/skills/locked/SKILL.md': skillText('locked'),
    'core/skills/locked/run.sh': 'printf locked\n',
  })
  const locked = join(root, 'core/skills/locked')
  chmodSync(locked, 0o000)
  // Restored here, not in an after hook: the fixture's own removal runs first and needs it.
  try {
    throwsCode(() => api.assembleRoleInstructions({ installationRoot: root, name: 'reader' }), 'IO_ERROR')
  } finally { chmodSync(locked, 0o700) }
})
