// CP-03d implementation edges the frozen acceptance does not pin: lookups run in
// text order, errors never echo the root, id or file, the root check also covers a
// token that only an inlined SKILL.md carries, a skills directory without SKILL.md
// does not shadow the real skill elsewhere, symlinked skills roots are absent, the
// longest id and dot-led file names resolve, and a role without a token keeps its
// CP-03c text under any root.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'

const api = () => import('../core/skills/native-runtime/role-files.mjs')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'native-role-skill-paths-')))

const token = (id, file) => '${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/' + id + '/' + file + '}'
const roleText = (name, body, lines = []) =>
  `---\nname: ${name}\ndescription: A fixture role\nmodel: sonnet\n${lines.map(l => `${l}\n`).join('')}---\n${body}`
const skillText = (name, body = '\n# skill\n') => `---\nname: ${name}\ndescription: d\n---\n${body}`

// files: { rel: text | { symlinkTo } }; `under` names the parent (default: WORK).
function fixture(files, under = WORK) {
  const root = mkdtempSync(join(under, 'case-'))
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    if (typeof content === 'string') writeFileSync(file, content)
    else symlinkSync(content.symlinkTo, file)
  }
  return root
}

function throwsCode(fn, code, ...secrets) {
  assert.throws(fn, e => {
    assert.equal(e.code, code)
    assert.equal(e.message, `Native runtime: ${code}.`)
    for (const s of secrets) assert.ok(!String(e.stack).includes(s), `stack echoes ${s}`)
    return true
  })
}

try {
  await test('tokens are looked up in text order: the first unresolved token decides the code', async () => {
    const { assembleRoleInstructions } = await api()
    const root = fixture({
      'core/agents/unknown-first.md': roleText('unknown-first', `\n${token('ghost', 'a.sh')} ${token('twin', 'a.sh')}\n`),
      'core/agents/twin-first.md': roleText('twin-first', `\n${token('twin', 'a.sh')} ${token('ghost', 'a.sh')}\n`),
      'core/skills/twin/SKILL.md': skillText('twin'),
      'core/skills/twin/a.sh': 'x\n',
      'kit/skills/twin/SKILL.md': skillText('twin'),
      'kit/skills/twin/a.sh': 'y\n',
    })
    throwsCode(() => assembleRoleInstructions({ installationRoot: root, name: 'unknown-first' }), 'UNKNOWN_SKILL')
    throwsCode(() => assembleRoleInstructions({ installationRoot: root, name: 'twin-first' }), 'DUPLICATE_SKILL')
  })

  await test('errors never echo the root, the skill id or the file name', async () => {
    const { assembleRoleInstructions } = await api()
    const root = fixture({
      'core/agents/secretive.md': roleText('secretive', `\nRun ${token('hidden-skill-id', 'hidden-file.sh')}.\n`),
      'core/skills/hidden-skill-id/SKILL.md': skillText('hidden-skill-id'),
    })
    throwsCode(() => assembleRoleInstructions({ installationRoot: root, name: 'secretive' }), 'UNKNOWN_SKILL',
      root, 'hidden-skill-id', 'hidden-file.sh', 'PANDASTACK_SKILL_PATH')
  })

  await test('a token only in an inlined SKILL.md still triggers the root check', async () => {
    const { assembleRoleInstructions } = await api()
    const parent = realpathSync(mkdtempSync(join(WORK, 'unsafe$root-')))
    const root = fixture({
      'core/agents/carrier.md': roleText('carrier', '\nNo token in the role body.\n', ['skills:', '  - inner']),
      'core/skills/inner/SKILL.md': skillText('inner', `\nUse ${token('inner', 'tool.sh')}.\n`),
      'core/skills/inner/tool.sh': 'x\n',
    }, parent)
    throwsCode(() => assembleRoleInstructions({ installationRoot: root, name: 'carrier' }), 'INVALID_ROLE_ROOT', root)
  })

  await test('a role without a token keeps its CP-03c text under an unsafe root, skills included', async () => {
    const { assembleRoleInstructions } = await api()
    const parent = realpathSync(mkdtempSync(join(WORK, 'quote"root-')))
    const root = fixture({
      'core/agents/plain.md': roleText('plain', '\nPlain role.\n', ['skills:', '  - helper']),
      'core/skills/helper/SKILL.md': skillText('helper', '\n# helper\n'),
    }, parent)
    assert.equal(assembleRoleInstructions({ installationRoot: root, name: 'plain' }).instructions, '\nPlain role.\n\n# helper\n')
  })

  await test('a skills directory without SKILL.md does not shadow the real skill in another root', async () => {
    const { assembleRoleInstructions } = await api()
    const root = fixture({
      'core/agents/shadow.md': roleText('shadow', `\n${token('tool', 'run.sh')}\n`),
      'core/skills/tool/run.sh': 'not a skill\n',
      'graphs/g/skills/tool/SKILL.md': skillText('tool'),
      'graphs/g/skills/tool/run.sh': 'the skill\n',
    })
    assert.equal(assembleRoleInstructions({ installationRoot: root, name: 'shadow' }).instructions,
      `\n${join(root, 'graphs/g/skills/tool/run.sh')}\n`)
  })

  await test('a symlinked skills root is absent', async () => {
    const { assembleRoleInstructions } = await api()
    const outside = fixture({ 'skills/away/SKILL.md': skillText('away'), 'skills/away/run.sh': 'x\n' })
    const root = fixture({
      'core/agents/far.md': roleText('far', `\n${token('away', 'run.sh')}\n`),
      'core/skills': { symlinkTo: join(outside, 'skills') },
    })
    throwsCode(() => assembleRoleInstructions({ installationRoot: root, name: 'far' }), 'UNKNOWN_SKILL', outside)
  })

  await test('a 64-character id and a dot-led file name resolve', async () => {
    const { assembleRoleInstructions } = await api()
    const id = 'a' + '-b'.repeat(31) + 'c'
    assert.equal(id.length, 64)
    const root = fixture({
      'core/agents/edge.md': roleText('edge', `\n${token(id, '.env.sample')}\n`),
      [`kit/skills/${id}/SKILL.md`]: skillText(id),
      [`kit/skills/${id}/.env.sample`]: 'x\n',
    })
    assert.equal(assembleRoleInstructions({ installationRoot: root, name: 'edge' }).instructions,
      `\n${join(root, 'kit/skills', id, '.env.sample')}\n`)
  })
} finally {
  rmSync(WORK, { recursive: true, force: true })
}
