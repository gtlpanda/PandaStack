// check-refs.test.mjs — the standalone check (scripts/check-refs.mjs): every skill, agent,
// workflow, or command a repo file tells Claude to use ships in the repo.
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { findRefs, checkRefs } from '../scripts/check-refs.mjs'

const SCRIPT = join(REPO, 'scripts', 'check-refs.mjs')

// A tiny repo: one skill, one agent, one workflow, one command, and a doc that uses them.
function fixture(doc, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'check-refs-'))
  const put = (rel, body) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), body) }
  put('core/skills/verify/SKILL.md', '---\nname: verify\n---\n')
  put('kit/agents/qa-engineer.md', '---\nname: qa-engineer\n---\n')
  put('graphs/dev/workflows/dev-build.js', 'export const meta = {\n')
  put('kit/commands/founding-sales.md', 'Sell.\n')
  put('CLAUDE.md', doc)
  for (const [rel, body] of Object.entries(extra)) put(rel, body)
  return dir
}

test('findRefs reads agent types, backticked slash commands, and named skills or agents', () => {
  const refs = findRefs([
    "agent(p, { agentType: 'advisor' })",
    '"subagent_type": "Explore"',
    'Run `/dev <task>`, then `/verify`.',
    'Use the `security` skill and the `/seo` skill; ask the `wiring-check` agent.',
  ].join('\n'))
  assert.deepEqual(refs.map(r => `${r.kind}:${r.name}:${r.line}`), [
    'agent:advisor:1', 'agent:Explore:2', 'command:dev:3', 'command:verify:3',
    'command:seo:4', 'any:security:4', 'any:seo:4', 'any:wiring-check:4',
  ])
})

test('findRefs ignores look-alikes: paths, unbackticked words, plain backticked names, and plural commands', () => {
  const refs = findRefs([
    'Health check at `/api/health` and `/a/` and `/a.html`.',  // a second slash or a dot: a path
    'Run /dev from a shell.',                                   // not in backticks
    'Set `retro` in the config.',                               // a name with no skill/agent after it
    'Run the `git` commands below.',                            // "commands" is not a reference kind
    'Use `cso`skill.',                                          // no space: not the phrase
  ].join('\n'))
  assert.deepEqual(refs, [])
})

test('a repo whose references all ship in it passes; built-ins and route examples count as present', () => {
  const dir = fixture([
    'Run `/verify`, `/dev-build`, `/founding-sales`, `/loop 5m`, and `/goal`.',
    'Ask the `qa-engineer` agent. Routes: `/dashboard`, `/login`.',
    "agentType: 'general-purpose'",
  ].join('\n'))
  try {
    const r = checkRefs(dir)
    assert.equal(r.unresolved.length, 0, JSON.stringify(r.unresolved))
    assert.equal(r.total, 9)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a name only another tool ships is reported with its file and line (the gstack case)', () => {
  const dir = fixture('Line one.\n3. **`security` skill / `cso` skill** — checks.\nThen run `/ship` and `/review`.\n', {
    'kit/skills/build-bot/SKILL.md': "agent(p, { agentType: 'design-lead' })\n",
    'kit/skills/build-bot/tests/x.test.mjs': "agentType: 'fixture-only'\n",  // tests are skipped
  })
  try {
    const r = checkRefs(dir)
    assert.deepEqual(r.unresolved.map(u => `${u.file}:${u.line}:${u.kind}:${u.name}`).sort(), [
      'CLAUDE.md:2:any:cso', 'CLAUDE.md:2:any:security', 'CLAUDE.md:3:command:review', 'CLAUDE.md:3:command:ship',
      'kit/skills/build-bot/SKILL.md:1:agent:design-lead',
    ])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an agent reference needs an agent: a skill of the same name does not satisfy agentType', () => {
  const dir = fixture("agentType: 'verify'\n")
  try {
    assert.deepEqual(checkRefs(dir).unresolved.map(u => u.name), ['verify'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the CLI exits 1 with one line per unresolved reference, 0 when all resolve, and this repo passes', () => {
  const bad = fixture('Run `/ship`.\n')
  try {
    const r = spawnSync(process.execPath, [SCRIPT, bad], { encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^CLAUDE\.md:1: command 'ship' is not in this repo or built into Claude Code$/m)
    assert.match(r.stdout, /1 of 1 references do not resolve/)
  } finally { rmSync(bad, { recursive: true, force: true }) }
  const real = spawnSync(process.execPath, [SCRIPT, REPO], { encoding: 'utf8' })
  assert.equal(real.status, 0, real.stdout)
  assert.match(real.stdout, /all resolve/)
})
