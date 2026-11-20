// CP-03c frozen acceptance: role-file loader with skills inlining
// (spec/contracts/codex-parity-cp-03c.md). Offline and static: no provider, no
// child process. Real-tree cases derive every expectation from the shipped files
// on disk, so no count or key list is hand-kept. Negative cases build fixture
// installation roots in owned temp directories.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, realpathSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const loadModule = () => import(pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/role-files.mjs')))

// The hunt runner's strip rule (graphs/hunt/skills/bughunt/native-runner.mjs agentInstructions).
const STRIP = /^---\n[\s\S]*?\n---\n/
const strip = text => text.replace(STRIP, '')
const skillBodyOf = text => strip(text).replace(/^\n+/, '')

const throwsCode = (fn, code) =>
  assert.throws(fn, e => e.code === code && e.message === `Native runtime: ${code}.`, `expected ${code}`)

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
      const text = readFileSync(join(ROOT, dir, file), 'utf8')
      rows.push({ stem: file.slice(0, -3), path: `${dir}/${file}`, text })
    }
  }
  return rows.sort((a, b) => (a.path < b.path ? -1 : 1))
}
const frontmatterLines = text => text.match(STRIP)[0].split('\n').slice(1, -2)
const keysOn = text => frontmatterLines(text).map(l => l.match(/^([a-z][a-z-]*):/)).filter(Boolean).map(m => m[1])
const declaredSkills = text => {
  const lines = frontmatterLines(text), at = lines.indexOf('skills:')
  if (at < 0) return []
  const names = []
  for (const line of lines.slice(at + 1)) { if (!line.startsWith('  - ')) break; names.push(line.slice(4)) }
  return names
}
function diskSkillText(name) {
  const hits = skillRoots().map(r => join(ROOT, r, name, 'SKILL.md')).filter(existsSync)
  assert.equal(hits.length, 1, `skill ${name} must have exactly one SKILL.md on disk`)
  return readFileSync(hits[0], 'utf8')
}

// ---- fixture installation roots --------------------------------------------

const roleText = (name, lines = [], body = '\nYou are the fixture role.\n') =>
  `---\nname: ${name}\ndescription: A fixture role\nmodel: sonnet\n${lines.map(l => `${l}\n`).join('')}---\n${body}`
const skillText = (name, body = '\n# fixture skill\n\nRule text.\n') =>
  `---\nname: ${name}\ndescription: routing metadata only\n---\n${body}`

// files: { 'core/agents/x.md': text | { symlinkTo: absolute } }
function fixture(t, files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-03c-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    if (typeof content === 'string') writeFileSync(file, content)
    else symlinkSync(content.symlinkTo, file)
  }
  return root
}

// ---- real tree --------------------------------------------------------------

test('every shipped role file lists and parses; count and key set come from disk', async () => {
  const api = await loadModule()
  const disk = diskRoles()
  assert.ok(disk.length > 0)
  const listed = api.listRoleFiles({ installationRoot: ROOT })
  assert.equal(listed.length, disk.length)
  assert.deepEqual(listed.map(r => r.path), disk.map(r => r.path))
  assert.deepEqual(listed.map(r => r.name), disk.map(r => r.stem))
  for (const row of listed) {
    const role = api.loadRoleFile({ installationRoot: ROOT, name: row.name })
    assert.equal(role.name, row.name)
    assert.equal(role.path, row.path)
    assert.equal(role.root, row.path.split('/agents/')[0])
    assert.deepEqual(Object.keys(role.frontmatter),
      ['name', 'description', 'model', 'effort', 'tools', 'skills', 'memory'])
    assert.equal(role.frontmatter.name, row.name)
  }
  // The allowed key set is exactly what the shipped files use, no more and no less.
  const used = [...new Set(disk.flatMap(r => keysOn(r.text)))].sort()
  assert.deepEqual([...api.ROLE_FRONTMATTER_KEYS].sort(), used)
  assert.ok(Object.isFrozen(api.ROLE_FRONTMATTER_KEYS))
})

test('role body equals the hunt runner strip for every shipped role', async () => {
  const api = await loadModule()
  for (const row of diskRoles()) {
    const role = api.loadRoleFile({ installationRoot: ROOT, name: row.stem })
    assert.equal(role.body, row.text.replace(STRIP, ''), row.path)
    assert.ok(role.body.startsWith('\n'), `${row.path}: body is untrimmed`)
  }
  // agentInstructions is module-private, so the rule is re-derived here. Fail if the
  // runner's own rule changes, so the two cannot drift apart silently.
  const runner = readFileSync(join(ROOT, 'graphs/hunt/skills/bughunt/native-runner.mjs'), 'utf8')
  assert.ok(runner.includes(String.raw`.replace(/^---\n[\s\S]*?\n---\n/, '')`))
  const hunter = diskRoles().find(r => r.stem === 'hunter')
  const role = api.loadRoleFile({ installationRoot: ROOT, name: 'hunter' })
  assert.equal(role.body, readFileSync(join(ROOT, 'graphs/hunt/agents/hunter.md'), 'utf8').replace(STRIP, ''))
  assert.equal(role.body, strip(hunter.text))
})

test('frontmatter values: tools split on commas, absent keys take their defaults', async () => {
  const api = await loadModule()
  const cases = [
    ['hunter', 'tools', ['Read', 'Grep', 'Glob', 'Bash']],
    ['implementer', 'tools', ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash']],
    ['hunter', 'effort', 'high'],
    ['hunter', 'skills', ['bug-lenses']],
    ['hunter', 'memory', null],
    ['wiring-check', 'tools', []],
    ['wiring-check', 'skills', []],
    ['wiring-check', 'effort', null],
    ['wiring-check', 'memory', 'project'],
    ['wiring-check', 'model', 'opus'],
  ]
  for (const [name, key, expected] of cases) {
    const role = api.loadRoleFile({ installationRoot: ROOT, name })
    assert.deepEqual(role.frontmatter[key], expected, `${name}.${key}`)
  }
  // description is the raw remainder of the line: kit files keep their quotes.
  const wiring = api.loadRoleFile({ installationRoot: ROOT, name: 'wiring-check' })
  assert.ok(wiring.frontmatter.description.startsWith('"'))
})

test('tools splitting tolerates spacing and rejects an empty element', async t => {
  const api = await loadModule()
  const root = fixture(t, {
    'core/agents/spaced.md': roleText('spaced', ['tools:  Read,Grep ,   Glob']),
    'core/agents/gappy.md': roleText('gappy', ['tools: Read,,Bash']),
    'core/agents/trailing.md': roleText('trailing', ['tools: Read, Bash,']),
  })
  assert.deepEqual(api.loadRoleFile({ installationRoot: root, name: 'spaced' }).frontmatter.tools, ['Read', 'Grep', 'Glob'])
  for (const name of ['gappy', 'trailing']) {
    throwsCode(() => api.loadRoleFile({ installationRoot: root, name }), 'INVALID_ROLE_FRONTMATTER')
  }
})

test('hunter assembly inlines the bug-lenses body once, after the role body, with no frontmatter', async () => {
  const api = await loadModule()
  const hunterText = readFileSync(join(ROOT, 'graphs/hunt/agents/hunter.md'), 'utf8')
  const skillText = readFileSync(join(ROOT, 'core/skills/bug-lenses/SKILL.md'), 'utf8')
  const body = hunterText.replace(STRIP, '')
  const skillBody = skillBodyOf(skillText)
  const result = api.assembleRoleInstructions({ installationRoot: ROOT, name: 'hunter' })

  assert.equal(result.name, 'hunter')
  assert.equal(result.path, 'graphs/hunt/agents/hunter.md')
  assert.equal(result.root, 'graphs/hunt')
  assert.equal(result.body, body)
  assert.deepEqual(result.skills, [{ name: 'bug-lenses', path: 'core/skills/bug-lenses/SKILL.md', body: skillBody }])
  assert.equal(result.instructions, `${body}\n${skillBody}`)

  const text = result.instructions
  assert.ok(text.startsWith(body))
  assert.equal(text.split(skillBody).length, 2, 'skill body appears exactly once')
  assert.ok(text.indexOf(skillBody) >= body.length, 'skill body comes after the role body')
  assert.ok(!text.split('\n').includes('---'), 'no frontmatter delimiter line survives')
  assert.ok(!text.includes('name: bug-lenses'))
  assert.ok(!text.includes('skills:\n  - bug-lenses'), 'role frontmatter is stripped too')
})

test('every shipped role inlines each declared skill once, in declared order', async () => {
  const api = await loadModule()
  const disk = diskRoles()
  const withSkills = disk.filter(r => declaredSkills(r.text).length > 0)
  assert.ok(withSkills.length > 0)
  // Only what the files declare: planner, scout and architect say knowledge-map.
  for (const name of ['planner', 'scout', 'architect']) {
    assert.ok(declaredSkills(disk.find(r => r.stem === name).text).includes('knowledge-map'), name)
  }
  for (const row of disk) {
    const declared = declaredSkills(row.text)
    const bodies = declared.map(name => skillBodyOf(diskSkillText(name)))
    const result = api.assembleRoleInstructions({ installationRoot: ROOT, name: row.stem })
    assert.deepEqual(result.skills.map(s => s.name), declared, row.path)
    // CP-03d rewrites skill-path tokens in instructions; its own test pins those roles' text.
    const tokened = row.text.includes('${PANDASTACK_SKILL_PATH:-')
    if (!tokened) assert.equal(result.instructions, [strip(row.text), ...bodies].join('\n'), row.path)
    for (const body of bodies) assert.equal(result.instructions.split(body).length, 2, `${row.path}: skill once`)
    if (declared.length === 0 && !tokened) assert.equal(result.instructions, strip(row.text))
  }
})

// ---- fixtures: assembly shape ------------------------------------------------

test('assembly joins skill bodies in declared order and strips SKILL.md frontmatter', async t => {
  const api = await loadModule()
  const root = fixture(t, {
    'core/agents/lead.md': roleText('lead', ['skills:', '  - beta', '  - alpha']),
    'core/agents/plain.md': roleText('plain'),
    'core/skills/alpha/SKILL.md': skillText('alpha', '\n\n# alpha\n\nA rule.\n'),
    'graphs/g/skills/beta/SKILL.md': skillText('beta', '\n# beta\n\nB rule.\n'),
    'kit/skills/unused/SKILL.md': skillText('unused'),
    'core/skills/not-a-skill/notes.md': 'no SKILL.md here\n',
  })
  const lead = api.assembleRoleInstructions({ installationRoot: root, name: 'lead' })
  assert.deepEqual(lead.skills, [
    { name: 'beta', path: 'graphs/g/skills/beta/SKILL.md', body: '# beta\n\nB rule.\n' },
    { name: 'alpha', path: 'core/skills/alpha/SKILL.md', body: '# alpha\n\nA rule.\n' },
  ])
  assert.equal(lead.body, '\nYou are the fixture role.\n')
  assert.equal(lead.instructions, '\nYou are the fixture role.\n\n# beta\n\nB rule.\n\n# alpha\n\nA rule.\n')
  assert.ok(!lead.instructions.includes('routing metadata only'))
  const plain = api.assembleRoleInstructions({ installationRoot: root, name: 'plain' })
  assert.deepEqual(plain.skills, [])
  assert.equal(plain.instructions, plain.body)
})

// ---- fixtures: fail closed ----------------------------------------------------

test('a valid fixture role parses (control for the negative cases below)', async t => {
  const api = await loadModule()
  const root = fixture(t, { 'core/agents/ok.md': roleText('ok', ['effort: high', 'tools: Read, Bash', 'skills:', '  - s']) })
  const role = api.loadRoleFile({ installationRoot: root, name: 'ok' })
  assert.equal(role.frontmatter.effort, 'high')
  assert.deepEqual(role.frontmatter.skills, ['s'])
})

test('malformed frontmatter fails closed with INVALID_ROLE_FRONTMATTER', async t => {
  const api = await loadModule()
  const head = stem => [`name: ${stem}`, 'description: d', 'model: sonnet']
  const text = (lines, body = '\nBody.\n') => `---\n${lines.join('\n')}\n---\n${body}`
  // Each case builds a role file for the given stem that breaks exactly one rule.
  const cases = {
    'unknown key': s => text([...head(s), 'color: red']),
    // Every line below the opener is itself a valid `key: value`, so only the missing close can fail it.
    'missing closing delimiter': s => `---\n${head(s).join('\n')}\neffort: high\n`,
    'closing delimiter at EOF without newline': s => `---\n${head(s).join('\n')}\n---`,
    'no opening delimiter': s => `${head(s).join('\n')}\n---\nBody.\n`,
    'duplicate key': s => text([...head(s), 'model: opus']),
    'missing description': s => text([`name: ${s}`, 'model: sonnet']),
    'missing model': s => text([`name: ${s}`, 'description: d']),
    'missing name': () => text(['description: d', 'model: sonnet']),
    'name differs from the file stem': () => text(['name: other', 'description: d', 'model: sonnet']),
    'empty value': s => text([...head(s), 'effort:']),
    'blank line inside frontmatter': s => text([...head(s), '', 'effort: high']),
    'line without a colon': s => text([...head(s), 'effort high']),
    // The opener is clean, so only the CR rule can reject it (value trimming would hide it otherwise).
    'carriage return in frontmatter': s => text([`name: ${s}\r`, 'description: d', 'model: sonnet']),
    'inline skills value': s => text([...head(s), 'skills: bug-lenses']),
    'empty skills list': s => text([...head(s), 'skills:']),
    'list item not under skills': s => text([...head(s), 'effort: high', '  - stray']),
    'duplicate skill entry': s => text([...head(s), 'skills:', '  - s', '  - s']),
    'skills entry with a slash': s => text([...head(s), 'skills:', '  - a/b']),
    'skills entry with ..': s => text([...head(s), 'skills:', '  - ..']),
    'skills entry with a path escape': s => text([...head(s), 'skills:', '  - ../x']),
    'skills entry in the wrong case': s => text([...head(s), 'skills:', '  - Skill']),
  }
  const labels = Object.keys(cases)
  const root = fixture(t, Object.fromEntries(
    labels.map((label, i) => [`core/agents/bad${i}.md`, cases[label](`bad${i}`)])))
  for (const [i, label] of labels.entries()) {
    assert.throws(
      () => api.loadRoleFile({ installationRoot: root, name: `bad${i}` }),
      e => e.code === 'INVALID_ROLE_FRONTMATTER' && e.message === 'Native runtime: INVALID_ROLE_FRONTMATTER.',
      label)
  }
})

test('a duplicate role name across roots fails closed', async t => {
  const api = await loadModule()
  const root = fixture(t, {
    'core/agents/twin.md': roleText('twin'),
    'graphs/g/agents/twin.md': roleText('twin'),
    'kit/agents/solo.md': roleText('solo'),
  })
  throwsCode(() => api.loadRoleFile({ installationRoot: root, name: 'twin' }), 'DUPLICATE_ROLE')
  throwsCode(() => api.assembleRoleInstructions({ installationRoot: root, name: 'twin' }), 'DUPLICATE_ROLE')
  throwsCode(() => api.listRoleFiles({ installationRoot: root }), 'DUPLICATE_ROLE')
  // loadRoleFile only checks the name it was asked for.
  assert.equal(api.loadRoleFile({ installationRoot: root, name: 'solo' }).path, 'kit/agents/solo.md')
})

test('a skills entry that does not resolve fails closed at assembly, not at load', async t => {
  const api = await loadModule()
  const outside = fixture(t, { 'SKILL.md': skillText('real') })
  const root = fixture(t, {
    'core/agents/dangling.md': roleText('dangling', ['skills:', '  - missing']),
    'core/agents/empty-dir.md': roleText('empty-dir', ['skills:', '  - hollow']),
    'core/agents/linked.md': roleText('linked', ['skills:', '  - linked-skill']),
    'core/agents/ambiguous.md': roleText('ambiguous', ['skills:', '  - shared']),
    'core/agents/headless.md': roleText('headless', ['skills:', '  - broken']),
    'core/skills/hollow/notes.md': 'a directory without SKILL.md is not a skill\n',
    'core/skills/linked-skill/SKILL.md': { symlinkTo: join(outside, 'SKILL.md') },
    'core/skills/shared/SKILL.md': skillText('shared'),
    'kit/skills/shared/SKILL.md': skillText('shared'),
    'core/skills/broken/SKILL.md': '# no frontmatter at all\n',
  })
  const expected = {
    dangling: 'UNKNOWN_SKILL',
    'empty-dir': 'UNKNOWN_SKILL',
    linked: 'UNKNOWN_SKILL',
    ambiguous: 'DUPLICATE_SKILL',
    headless: 'INVALID_SKILL_FILE',
  }
  for (const [name, code] of Object.entries(expected)) {
    assert.equal(api.loadRoleFile({ installationRoot: root, name }).name, name)
    throwsCode(() => api.assembleRoleInstructions({ installationRoot: root, name }), code)
  }
})

test('a hostile or malformed requested name fails closed before any file access', async t => {
  const api = await loadModule()
  // A file the traversal would reach if the name were ever joined into a path.
  const root = fixture(t, {
    'core/escape.md': roleText('escape'),
    'core/agents/real.md': roleText('real'),
  })
  const names = ['a/b', '../escape', '..', 'a..b', 'real\n', 'real\nreal', '\nreal', 'real/', '/real', 'Real', '', ' real', 'a\\b', 'a'.repeat(65)]
  for (const name of names) {
    for (const call of [api.loadRoleFile, api.assembleRoleInstructions]) {
      assert.throws(() => call({ installationRoot: root, name }),
        e => e.code === 'INVALID_ROLE_NAME' && e.message === 'Native runtime: INVALID_ROLE_NAME.' && !e.message.includes('escape'),
        JSON.stringify(name))
    }
  }
  for (const name of [undefined, null, 7, {}, ['real'], { toString: () => 'real' }]) {
    throwsCode(() => api.loadRoleFile({ installationRoot: root, name }), 'INVALID_ROLE_NAME')
  }
  throwsCode(() => api.loadRoleFile({ installationRoot: root, name: 'absent' }), 'ROLE_NOT_FOUND')
  for (const installationRoot of ['relative/root', '', undefined, null, 7]) {
    throwsCode(() => api.loadRoleFile({ installationRoot, name: 'real' }), 'INVALID_ROLE_ROOT')
    throwsCode(() => api.listRoleFiles({ installationRoot }), 'INVALID_ROLE_ROOT')
  }
})

test('listing ignores non-markdown files, rejects bad stems, and never follows a symlinked role', async t => {
  const api = await loadModule()
  const outside = fixture(t, { 'outside.md': roleText('linked') })
  const clean = fixture(t, {
    'core/agents/real.md': roleText('real'),
    'core/agents/notes.txt': 'not a role\n',
    'core/agents/linked.md': { symlinkTo: join(outside, 'outside.md') },
    'graphs/empty/README.md': 'a graph with no agents directory\n',
  })
  assert.deepEqual(api.listRoleFiles({ installationRoot: clean }).map(r => r.path), ['core/agents/real.md'])
  throwsCode(() => api.loadRoleFile({ installationRoot: clean, name: 'linked' }), 'ROLE_NOT_FOUND')

  const stray = fixture(t, { 'core/agents/README.md': '# not a role\n', 'core/agents/real.md': roleText('real') })
  throwsCode(() => api.listRoleFiles({ installationRoot: stray }), 'INVALID_ROLE_NAME')
})

test('invalid UTF-8 and unreadable files fail closed with fixed codes', async t => {
  const api = await loadModule()
  const invalid = Buffer.concat([Buffer.from(roleText('mojibake', [], '\nbody ')), Buffer.from([0xff, 0xfe]), Buffer.from('\n')])
  const badSkill = Buffer.concat([Buffer.from(skillText('garbled', '\nrule ')), Buffer.from([0xc3, 0x28]), Buffer.from('\n')])
  const root = fixture(t, {
    'core/agents/uses-garbled.md': roleText('uses-garbled', ['skills:', '  - garbled']),
    'core/agents/locked.md': roleText('locked'),
  })
  writeFileSync(join(root, 'core/agents/mojibake.md'), invalid)
  mkdirSync(join(root, 'core/skills/garbled'), { recursive: true })
  writeFileSync(join(root, 'core/skills/garbled/SKILL.md'), badSkill)
  throwsCode(() => api.loadRoleFile({ installationRoot: root, name: 'mojibake' }), 'INVALID_ROLE_FILE')
  throwsCode(() => api.assembleRoleInstructions({ installationRoot: root, name: 'uses-garbled' }), 'INVALID_SKILL_FILE')

  // Root reads through any mode bits, so the unreadable case needs an ordinary user.
  if (process.getuid?.() === 0) { t.diagnostic('unreadable-file case skipped: running as root'); return }
  const locked = join(root, 'core/agents/locked.md')
  chmodSync(locked, 0o000)
  t.after(() => { try { chmodSync(locked, 0o600) } catch { /* the fixture may already be removed */ } })
  throwsCode(() => api.loadRoleFile({ installationRoot: root, name: 'locked' }), 'IO_ERROR')
})
