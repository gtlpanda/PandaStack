// render-skill-path.test.mjs — kit/skills/render/SKILL.md must document a command that runs:
// the wrapper is not on PATH (and an alias would not survive the next Bash call), so every
// documented call uses its full installed path, and that path is where install.sh links it.
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'

const SKILL = readFileSync(join(REPO, 'kit', 'skills', 'render', 'SKILL.md'), 'utf8')
const FULL = '~/.claude/skills/render/render'

test('every documented render call uses the full installed path, never a bare `render`', () => {
  const lines = [...SKILL.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap(m => m[1].split('\n')).filter(l => l && !l.startsWith('#'))
  const calls = lines.filter(l => /(^|\/)render\s/.test(l))
  assert.ok(calls.length >= 5, `BUGHUNT-F9 expected the documented examples, found ${calls.length}`)
  for (const l of calls) assert.ok(l.startsWith(`${FULL} `), `BUGHUNT-F9 a documented call is not runnable (not on PATH): ${l}`)
  const steps = SKILL.split('## How to invoke from Claude')[1] || ''
  assert.doesNotMatch(steps, /`render /, 'BUGHUNT-F9 the how-to steps call a bare `render`')
  assert.doesNotMatch(SKILL, /added to PATH/, 'BUGHUNT-F9 the doc promises a PATH entry that does not exist')
})

test('the full path is where install.sh links the skill: kit/skills/render/render, executable', () => {
  const script = join(REPO, 'kit', 'skills', 'render', 'render')
  assert.ok(existsSync(script))
  assert.match(readFileSync(script, 'utf8').split('\n')[0], /^#!.*bash/)
})
