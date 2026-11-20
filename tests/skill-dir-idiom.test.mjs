// CP-03a implementation edges the frozen acceptance does not pin: the contract's
// file-wide rules in their stricter forms (every CLAUDE_SKILL_DIR read is the nested
// default, no fenced line consults a project or home skills path), the frozen
// readers' constraints (validate.sh rule sentences, no other skill's path), the
// paragraph's single placement, and the two bash facts the contract's idiom rests
// on, run for real: an env-prefix assignment does not reach the expansion, and the
// reversed nesting becomes a syntax error once Claude Code substitutes the token.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, REPO } from '../scripts/workflow-harness.mjs'

const NAMES = ['backlog', 'findings', 'gtm-brief', 'verify']
const IDIOM_PREFIX = '"${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/'
const PARAGRAPH_START = '`SKILL_DIR` is the directory that holds this SKILL.md.'
const skillText = name => readFileSync(join(REPO, 'core/skills', name, 'SKILL.md'), 'utf8')

function fencedLines(text) {
  const out = []
  let inside = false
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) { inside = !inside; continue }
    if (inside) out.push(line)
  }
  return out
}

// bash -c with an environment built from scratch: no HOME, no inherited SKILL_DIR.
function bash(script, extraEnv = {}) {
  const r = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH, LC_ALL: 'C', ...extraEnv }, encoding: 'utf8' })
  assert.equal(r.error, undefined)
  return r
}

await test('every CLAUDE_SKILL_DIR read in the four files is the nested default of SKILL_DIR', () => {
  for (const name of NAMES) {
    const text = skillText(name)
    const reads = text.match(/\$\{?CLAUDE_SKILL_DIR[^}]*\}?/g) ?? []
    assert.ok(reads.length > 0, `${name}: has at least one idiom command`)
    assert.ok(reads.every(read => read === '${CLAUDE_SKILL_DIR}'), `${name}: only the bare token: ${reads}`)
    assert.equal(text.split('${CLAUDE_SKILL_DIR}').length - 1, text.split(IDIOM_PREFIX).length - 1,
      `${name}: every token sits inside ${IDIOM_PREFIX}`)
    assert.doesNotMatch(text, /\$\{CLAUDE_SKILL_DIR:-/, `${name}: the reversed nesting`)
  }
})

await test('no fenced line consults the working directory, HOME or a skills path', () => {
  for (const name of NAMES) {
    for (const line of fencedLines(skillText(name)).filter(l => l.includes(IDIOM_PREFIX))) {
      assert.doesNotMatch(line, /~|\$HOME|\$\{HOME|\.agents|\.claude|skills\//, `${name}: ${line}`)
      assert.ok(/^(node|bash) "/.test(line), `${name}: the line starts with its interpreter: ${line}`)
    }
  }
})

await test('the paragraph appears exactly once per file, and verify keeps its subproject sentence', () => {
  for (const name of NAMES) {
    const text = skillText(name).replace(/\s+/g, ' ')
    assert.equal(text.split(PARAGRAPH_START).length - 1, 1, `${name}: one paragraph`)
    assert.equal(fencedLines(skillText(name)).some(line => line.includes(PARAGRAPH_START)), false, `${name}: paragraph is prose`)
  }
  const verify = skillText('verify').replace(/\s+/g, ' ')
  assert.ok(verify.includes('With neither set, the command fails. Pass a directory as the first argument to verify a subproject, e.g. `packages/api`.'))
  assert.doesNotMatch(verify, /set by Claude Code when a skill runs|Outside a skill/, 'the main-era parenthesis is gone')
})

await test('every validate.sh rule sentence pinned on these four files is still present', () => {
  const rules = readFileSync(join(REPO, 'scripts/validate.sh'), 'utf8').split('\n')
    .map(line => /^rule core\/skills\/([a-z-]+)\/SKILL\.md '([^']+)'/.exec(line)).filter(Boolean)
    .filter(m => NAMES.includes(m[1]))
  assert.ok(rules.length >= 5, `validate.sh pins at least the five sentences the contract names (found ${rules.length})`)
  for (const [, name, sentence] of rules) assert.ok(skillText(name).includes(sentence), `${name}: ${sentence}`)
})

await test('none of the four files names another skill path (CP-01b derives a dependency edge from one)', () => {
  for (const name of NAMES) {
    const others = [...skillText(name).matchAll(/skills\/([A-Za-z0-9._-]+)\//g)].map(m => m[1]).filter(id => id !== name)
    assert.deepEqual(others, [], `${name}: foreign skills/<id>/ mention`)
  }
})

await test('the documented SKILL_DIR statement is required: an env prefix does not reach the expansion', () => {
  // The contract's note: bash expands arguments before applying a prefix assignment.
  const prefix = bash(`SKILL_DIR=/old; SKILL_DIR=/new printf '%s' "\${SKILL_DIR:-unset}/x"`)
  assert.equal(prefix.stdout, '/old/x')
  const statement = bash(`SKILL_DIR=/old; SKILL_DIR=/new; printf '%s' "\${SKILL_DIR:-unset}/x"`)
  assert.equal(statement.stdout, '/new/x')
})

await test('after text substitution the idiom is valid bash and the reversed order is a syntax error', () => {
  const substituted = IDIOM_PREFIX.split('${CLAUDE_SKILL_DIR}').join('/abs/skill dir')
  const unset = bash(`printf '%s' ${substituted}x"`)
  assert.equal(unset.status, 0)
  assert.equal(unset.stdout, '/abs/skill dir/x')
  const set = bash(`printf '%s' ${substituted}x"`, { SKILL_DIR: '/from/env' })
  assert.equal(set.stdout, '/from/env/x', 'a set SKILL_DIR wins over the substituted path')
  const reversed = bash(`printf '%s' "\${/abs/skill dir:-\${SKILL_DIR}}/x"`, { SKILL_DIR: '/from/env' })
  assert.notEqual(reversed.status, 0)
  assert.match(reversed.stderr, /bad substitution/)
})

await test('with neither variable set the idiom resolves to a bare root path, never a relative one', () => {
  // Fail-closed rests on /<helper> not existing at the filesystem root; nothing is looked up relative to cwd.
  const r = bash(`printf '%s' ${IDIOM_PREFIX}verify.sh"`)
  assert.equal(r.stdout, '/verify.sh')
  const empty = bash(`printf '%s' ${IDIOM_PREFIX}verify.sh"`, { SKILL_DIR: '', CLAUDE_SKILL_DIR: '' })
  assert.equal(empty.stdout, '/verify.sh', 'an empty variable counts as unset')
})
