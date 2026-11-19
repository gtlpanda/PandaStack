// CP-03c implementation edges the frozen acceptance does not pin: missing roots and
// graphs, symlinked or non-directory containers, unreadable agents directories,
// extra frontmatter grammar cases, a leading BOM, malformed options objects, error
// text that never carries a path or name, listing that reads no file contents, and
// exact (case-sensitive) name matching.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'

const api = () => import('../core/skills/native-runtime/role-files.mjs')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'native-role-files-')))
const AS_ROOT = process.getuid?.() === 0 ? 'running as root reads through any mode bits' : false

const roleText = (name, lines = [], body = '\nFixture role.\n') =>
  `---\nname: ${name}\ndescription: A fixture role\nmodel: sonnet\n${lines.map(l => `${l}\n`).join('')}---\n${body}`
const skillText = (name, body = '\n# skill\n') => `---\nname: ${name}\ndescription: d\n---\n${body}`

// files: { 'core/agents/x.md': text | Buffer | { symlinkTo } }
function fixture(files = {}) {
  const root = mkdtempSync(join(WORK, 'case-'))
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    if (typeof content === 'string' || Buffer.isBuffer(content)) writeFileSync(file, content)
    else symlinkSync(content.symlinkTo, file)
  }
  return root
}

// The error is the boundary's: fixed code, fixed message, nothing echoed.
function throwsCode(fn, code, ...secrets) {
  assert.throws(fn, e => {
    assert.equal(e.code, code)
    assert.equal(e.message, `Native runtime: ${code}.`)
    for (const s of secrets) assert.ok(!String(e.stack).includes(s), `stack echoes ${s}`)
    return true
  })
}

try {
  await test('a missing root, absent graphs and absent kit give an empty listing, not an error', async () => {
    const { listRoleFiles, loadRoleFile } = await api()
    const missing = join(WORK, 'never-created')
    assert.deepEqual(listRoleFiles({ installationRoot: missing }), [])
    throwsCode(() => loadRoleFile({ installationRoot: missing, name: 'any' }), 'ROLE_NOT_FOUND', missing)
    const root = fixture({ 'core/agents/only.md': roleText('only') })
    assert.deepEqual(listRoleFiles({ installationRoot: root }), [{ name: 'only', path: 'core/agents/only.md', root: 'core' }])
  })

  await test('symlinked and non-directory containers are treated as absent', async () => {
    const { listRoleFiles, loadRoleFile, assembleRoleInstructions } = await api()
    const outside = fixture({
      'agents/away.md': roleText('away'),
      'graph/agents/far.md': roleText('far'),
      'skills/remote/SKILL.md': skillText('remote'),
    })
    const root = fixture({
      'core/agents': { symlinkTo: join(outside, 'agents') },
      'graphs/linked': { symlinkTo: join(outside, 'graph') },
      'kit/agents': 'a file where a directory belongs\n',
      'graphs/g/agents/user.md': roleText('user', ['skills:', '  - remote']),
      'graphs/g/skills/remote': { symlinkTo: join(outside, 'skills/remote') },
    })
    assert.deepEqual(listRoleFiles({ installationRoot: root }).map(r => r.path), ['graphs/g/agents/user.md'])
    for (const name of ['away', 'far']) throwsCode(() => loadRoleFile({ installationRoot: root, name }), 'ROLE_NOT_FOUND')
    throwsCode(() => assembleRoleInstructions({ installationRoot: root, name: 'user' }), 'UNKNOWN_SKILL')
  })

  await test('an unreadable agents directory is IO_ERROR with no path in the error', { skip: AS_ROOT }, async () => {
    const { listRoleFiles, loadRoleFile } = await api()
    const root = fixture({ 'core/agents/real.md': roleText('real') })
    const dir = join(root, 'core/agents')
    chmodSync(dir, 0o000)
    try {
      throwsCode(() => listRoleFiles({ installationRoot: root }), 'IO_ERROR', root)
      throwsCode(() => loadRoleFile({ installationRoot: root, name: 'real' }), 'IO_ERROR', root)
    } finally { chmodSync(dir, 0o700) }
  })

  await test('frontmatter grammar edges fail closed', async () => {
    const { loadRoleFile } = await api()
    const head = s => `name: ${s}\ndescription: d\nmodel: m`
    const cases = {
      'empty block': () => '---\n\n---\nBody.\n',
      'skills as the last line': s => `---\n${head(s)}\nskills:\n---\n`,
      'extra space before a skill name': s => `---\n${head(s)}\nskills:\n  -  x\n---\n`,
      'trailing space after a skill name': s => `---\n${head(s)}\nskills:\n  - x \n---\n`,
      'three-space skill indent': s => `---\n${head(s)}\nskills:\n   - x\n---\n`,
      'skill item without a space': s => `---\n${head(s)}\nskills:\n  -x\n---\n`,
      'key with leading space': s => `---\n${head(s)}\n effort: high\n---\n`,
      'repeated skills key': s => `---\n${head(s)}\nskills:\n  - x\nskills:\n  - y\n---\n`,
      'empty tools': s => `---\n${head(s)}\ntools:\n---\n`,
      'leading byte-order mark': s => `﻿---\n${head(s)}\n---\n`,
      'CRLF delimiters': s => `---\r\n${head(s)}\r\n---\r\n`,
      'inherited key name': s => `---\n${head(s)}\nconstructor: x\n---\n`,
    }
    const labels = Object.keys(cases)
    const root = fixture(Object.fromEntries(labels.map((label, i) => [`core/agents/bad${i}.md`, cases[label](`bad${i}`)])))
    for (const [i, label] of labels.entries()) {
      assert.throws(() => loadRoleFile({ installationRoot: root, name: `bad${i}` }),
        e => e.code === 'INVALID_ROLE_FRONTMATTER', label)
    }
  })

  await test('values keep the raw remainder after the first colon, and a valid list closes before the next key', async () => {
    const { loadRoleFile } = await api()
    const root = fixture({ 'core/agents/raw.md': roleText('raw', ['skills:', '  - one', '  - two', 'effort:   max  ', 'memory: a: b']) })
    const { frontmatter } = loadRoleFile({ installationRoot: root, name: 'raw' })
    assert.deepEqual(frontmatter.skills, ['one', 'two'])
    assert.equal(frontmatter.effort, 'max')
    assert.equal(frontmatter.memory, 'a: b')
  })

  await test('malformed options objects are INVALID_ROLE_ROOT; a NUL in the root too', async () => {
    const { listRoleFiles, loadRoleFile, assembleRoleInstructions } = await api()
    const root = fixture({ 'core/agents/real.md': roleText('real') })
    let ran = false
    const getter = { get installationRoot() { ran = true; return root }, name: 'real' }
    const bad = [undefined, null, 'string', [root], new Proxy({ installationRoot: root, name: 'real' }, {}), getter,
      { installationRoot: `${root}\0x`, name: 'real' }]
    for (const options of bad) {
      for (const call of [listRoleFiles, loadRoleFile, assembleRoleInstructions]) throwsCode(() => call(options), 'INVALID_ROLE_ROOT')
    }
    assert.equal(ran, false, 'a getter never runs')
    const nullProto = Object.assign(Object.create(null), { installationRoot: root, name: 'real' })
    assert.equal(loadRoleFile(nullProto).path, 'core/agents/real.md')
  })

  await test('errors never echo the requested name, the root or file content', async () => {
    const { loadRoleFile, assembleRoleInstructions } = await api()
    const root = fixture({
      'core/agents/leaky.md': roleText('leaky', ['color: secret-value']),
      'core/agents/dangles.md': roleText('dangles', ['skills:', '  - secret-skill']),
    })
    throwsCode(() => loadRoleFile({ installationRoot: root, name: 'secret-role' }), 'ROLE_NOT_FOUND', 'secret-role', root)
    throwsCode(() => loadRoleFile({ installationRoot: root, name: 'leaky' }), 'INVALID_ROLE_FRONTMATTER', 'secret-value', root)
    throwsCode(() => assembleRoleInstructions({ installationRoot: root, name: 'dangles' }), 'UNKNOWN_SKILL', 'secret-skill', root)
  })

  await test('listing reads no file contents', async () => {
    const { listRoleFiles } = await api()
    const root = fixture({
      'core/agents/garbage.md': 'no frontmatter at all\n',
      'kit/agents/bytes.md': Buffer.from([0xff, 0xfe, 0x00]),
    })
    assert.deepEqual(listRoleFiles({ installationRoot: root }).map(r => r.name), ['garbage', 'bytes'])
  })

  await test('names match directory entries exactly, never case-insensitively', async () => {
    const { loadRoleFile, assembleRoleInstructions } = await api()
    const root = fixture({
      'core/agents/Upper.md': roleText('upper'),
      'core/agents/user.md': roleText('user', ['skills:', '  - lens']),
      'core/skills/Lens/SKILL.md': skillText('lens'),
    })
    throwsCode(() => loadRoleFile({ installationRoot: root, name: 'upper' }), 'ROLE_NOT_FOUND')
    throwsCode(() => assembleRoleInstructions({ installationRoot: root, name: 'user' }), 'UNKNOWN_SKILL')
  })

  await test('skills in different graphs resolve in declared order under a kit role', async () => {
    const { assembleRoleInstructions } = await api()
    const root = fixture({
      'kit/agents/multi.md': roleText('multi', ['skills:', '  - first', '  - second']),
      'graphs/a/skills/first/SKILL.md': skillText('first', '\n# first\n'),
      'graphs/b/skills/second/SKILL.md': skillText('second', '# second\n'),
    })
    const result = assembleRoleInstructions({ installationRoot: root, name: 'multi' })
    assert.deepEqual(result.skills.map(s => s.path), ['graphs/a/skills/first/SKILL.md', 'graphs/b/skills/second/SKILL.md'])
    assert.equal(result.instructions, '\nFixture role.\n\n# first\n\n# second\n')
    assert.equal(result.root, 'kit')
  })
} finally {
  for (const name of readdirSync(WORK)) { try { chmodSync(join(WORK, name, 'core/agents'), 0o700) } catch { /* best effort */ } }
  rmSync(WORK, { recursive: true, force: true })
}
