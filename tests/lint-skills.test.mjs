// lint-skills.test.mjs - the SKILL.md linter (scripts/lint-skills.mjs): each rule, its look-alikes
// that must not pass, the ratchet baseline, and the repo's own skills against that baseline. The
// last test is how CI runs the linter: the workflow suite runs every tests/*.test.mjs.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { parseSkill, lintSkill, hasNumberedSteps, hasCommand, errorRecovery, TRIGGER, RECOVERY_HEADING } from '../scripts/lint-skills.mjs'

const SCRIPT = join(REPO, 'scripts', 'lint-skills.mjs')
const rules = violations => [...new Set(violations.map(v => v.rule))].sort()

// A skill that passes every rule; each test breaks one thing.
const GOOD_BODY = [
  '# Thing', '', '1. Run the check:', '', '```bash', 'node check.mjs', '```', '',
  '2. Read the result.', '', '## Error recovery', '',
  '| Failure | Fix |', '|---|---|', '| check.mjs exits 2 | pass the repo path |', '',
].join('\n')
const skill = ({ name = 'thing', description = 'Does the thing. Use when the user says "do the thing".', body = GOOD_BODY } = {}) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`
const lint = (text, kind = 'guided-offering', dir = 'thing') => lintSkill({ text, dir, kind })

console.log('== lint-skills: frontmatter')
await test('a skill that follows every rule has no violation', () => {
  assert.deepEqual(lint(skill()), [])
})
await test('FRONTMATTER: missing, unclosed, malformed, duplicate, name mismatch, no name, no description', () => {
  assert.deepEqual(rules(lint('# no frontmatter\n')), ['ERROR_RECOVERY', 'NUMBERED_STEPS', 'STEP_COMMAND', 'FRONTMATTER'].sort())
  assert.ok(lint('# no frontmatter\n').some(v => /does not open with ---/.test(v.message)))
  assert.ok(lint('---\nname: thing\ndescription: x\n').some(v => v.rule === 'FRONTMATTER' && /no closing/.test(v.message)))
  assert.ok(lint(skill().replace('name: thing', 'name thing')).some(v => v.rule === 'FRONTMATTER' && /not `key: value`/.test(v.message)))
  assert.ok(lint(skill().replace('name: thing', 'name: thing\nname: thing')).some(v => /appears twice/.test(v.message)))
  assert.ok(lint(skill({ name: 'other' })).some(v => v.rule === 'FRONTMATTER' && /not the directory name `thing`/.test(v.message)))
  assert.ok(lint(skill().replace('name: thing\n', '')).some(v => v.rule === 'FRONTMATTER' && v.message === 'no `name`'))
  const noDesc = lint(skill().replace(/description: .*\n/, ''))
  assert.ok(noDesc.some(v => v.rule === 'FRONTMATTER' && v.message === 'no `description`'))
  assert.ok(!noDesc.some(v => v.rule === 'DESCRIPTION'), 'a missing description is one FRONTMATTER violation, not also DESCRIPTION')
})
await test('FRONTMATTER: CRLF line ends, quoted values, comments and folded block values parse', () => {
  assert.deepEqual(lint(skill().replace(/\n/g, '\r\n')), [])
  const p = parseSkill('---\r\nname: "thing"\r\n# a comment\r\ndescription: >\r\n  Does it.\r\n  Use when asked.\r\n---\r\nbody\r\n')
  assert.deepEqual(p.frontmatter, { name: 'thing', description: 'Does it. Use when asked.' })
  assert.deepEqual(p.problems, [])
  assert.equal(parseSkill("---\nname: 'it''s'\n---\n").frontmatter.name, "it's")
  assert.ok(parseSkill('---\n  indented: first\n---\n').problems.some(p => /indented with no key/.test(p)))
  assert.throws(() => parseSkill(null), /not a string/)
})

console.log('== lint-skills: description and length')
await test('DESCRIPTION: empty, over 1024 characters, or with no trigger clause fails', () => {
  assert.deepEqual(rules(lint(skill({ description: '' }))), ['DESCRIPTION'])
  assert.deepEqual(rules(lint(skill({ description: '""' }))), ['DESCRIPTION'])
  const long = `Use when asked. ${'x'.repeat(1020)}`
  assert.ok(lint(skill({ description: long })).some(v => /1036 characters \(max 1024\)/.test(v.message)))
  assert.deepEqual(rules(lint(skill({ description: 'Create a git commit' }))), ['DESCRIPTION'])
})
await test('DESCRIPTION trigger: the phrasings that say when, and look-alikes that do not', () => {
  for (const ok of ['Use when the user says x', 'Use only when asked', 'use this skill when', 'Use it whenever', 'Use before a PR',
    'Invoke when stuck', 'when the user asks for a review', 'Triggers on "deploy"', 'Use if the tests fail']) assert.ok(TRIGGER.test(ok), ok)
  for (const bad of ['Useful when debugging', 'Used by /dev', 'because when it runs', 'A tool to use.', 'Reuse when possible', 'misuse when']) assert.ok(!TRIGGER.test(bad), bad)
})
await test('BODY_LENGTH: 500 body lines pass, 501 fail; trailing blank lines do not count', () => {
  const body = n => `${GOOD_BODY}${'\nx'.repeat(n - GOOD_BODY.split('\n').length)}`
  assert.equal(body(500).split('\n').length, 500)
  assert.deepEqual(lint(skill({ body: body(500) + '\n\n\n' })), [])
  assert.deepEqual(rules(lint(skill({ body: body(501) }))), ['BODY_LENGTH'])
})

console.log('== lint-skills: procedure rules')
await test('NUMBERED_STEPS: items or headings numbered 1 and 2; one item, or numbers inside code, do not count', () => {
  assert.ok(hasNumberedSteps('1. a\n2. b'))
  assert.ok(hasNumberedSteps('## Step 1: a\n\n## Step 2: b'))
  assert.ok(hasNumberedSteps('## 1. Plan\n## 2. Build'))
  assert.ok(hasNumberedSteps('1) a\n   2) b'))
  assert.ok(!hasNumberedSteps('1. only one step'))
  assert.ok(!hasNumberedSteps('```\n1. in code\n2. in code\n```'))
  assert.ok(!hasNumberedSteps('- a\n- b'))
  assert.ok(!hasNumberedSteps('In 2024. we shipped 1.5 releases'))
})
await test('STEP_COMMAND: a shell block or an inline command; prose code, data blocks and bare names do not count', () => {
  assert.ok(hasCommand('```bash\nnode x.mjs\n```'))
  assert.ok(hasCommand('```\nmake test\n```'), 'an untagged fence is read as shell')
  assert.ok(hasCommand('Run `git status --short` first.'))
  assert.ok(hasCommand('Run `./install.sh --codex`.'))
  assert.ok(!hasCommand('```json\n{"a": 1}\n```'))
  assert.ok(!hasCommand('```markdown\n## Completed:\n```'))
  assert.ok(!hasCommand('```bash\n# only a comment\n```'))
  assert.ok(!hasCommand('Edit `tasks/lessons.md` and `retro.md`.'))
  assert.ok(!hasCommand('Use `node` for this.'), 'a tool name alone is not a command')
})
await test('ERROR_RECOVERY: a failure -> fix table or list under a recovery heading', () => {
  assert.deepEqual(errorRecovery('## Troubleshooting\n\n| Symptom | Fix |\n| --- | --- |\n| 404 | check the URL |\n'), { ok: true })
  assert.deepEqual(errorRecovery('### Errors\n\n- exit 2 -> pass a path\n'), { ok: true })
  assert.deepEqual(errorRecovery('## When something fails\n\n- **Login expired**: run `codex login`\n'), { ok: true })
  assert.deepEqual(errorRecovery('## 4. Error recovery\n\n- timeout → raise --timeout-ms\n'), { ok: true })
})
await test('ERROR_RECOVERY look-alikes: prose, title headings, retry-only fixes, code, other sections', () => {
  assert.match(errorRecovery('If an error happens, fix it.\n').reason, /no error-recovery section/)
  assert.match(errorRecovery('# Error Audit — Find Silent Failures\n\n- a -> b\n').reason, /no error-recovery section/)
  assert.match(errorRecovery('## Error Handling Audit Report\n\n- a -> b\n').reason, /no error-recovery section/)
  assert.match(errorRecovery('## Errors\n\nSomething may fail; read the log.\n').reason, /maps no failure to a fix/)
  assert.match(errorRecovery('## Errors\n\n| Failure | Fix |\n|---|---|\n| 500 | Try again. |\n').reason, /only "Try again"/)
  assert.match(errorRecovery('## Errors\n\n- flaky test -> rerun\n').reason, /only "rerun"/)
  assert.match(errorRecovery('## Errors\n\n- network -> **retry**\n').reason, /only "retry"/)
  assert.match(errorRecovery('```\n## Errors\n- a -> b\n```\n').reason, /no error-recovery section/)
  assert.match(errorRecovery('## Errors\n\nSee below.\n\n## Other\n\n- a -> b\n').reason, /maps no failure to a fix/, 'pairs under the next section do not count')
  assert.match(errorRecovery('## Errors\n\n| Failure | Fix |\n| 404 | check |\n').reason, /maps no failure/, 'a table needs its --- rule row')
  assert.deepEqual(errorRecovery('## Errors\n\n- retry budget exhausted -> raise the budget\n'), { ok: true }, '"retry" in the failure is fine')
})
await test('reference contracts are exempt from the procedure rules, not from the others', () => {
  const ref = skill({ body: 'A format other skills read.\n' })
  assert.deepEqual(lint(ref, 'shared-reference-contract'), [])
  assert.deepEqual(rules(lint(ref, 'guided-offering')), ['ERROR_RECOVERY', 'NUMBERED_STEPS', 'STEP_COMMAND'])
  assert.deepEqual(rules(lint(skill({ name: 'x', description: '', body: 'A format.\n' }), 'shared-reference-contract')), ['DESCRIPTION', 'FRONTMATTER'])
  assert.ok(RECOVERY_HEADING.test('Errors and fixes') && !RECOVERY_HEADING.test('Errors in the wild'))
})

console.log('== lint-skills: the CLI and its ratchet baseline')
// A repo with a catalog of three offerings: good (clean), bad (no trigger), and nofile (no SKILL.md).
function fixture({ baseline } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lint-skills-'))
  const put = (rel, body) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body) }
  put('spec/offering-capabilities.json', JSON.stringify({ offerings: [
    { id: 'good', kind: 'guided-offering', source: 'kit/skills/good' },
    { id: 'bad', kind: 'guided-offering', source: 'kit/skills/bad' },
    { id: 'nofile', kind: 'shared-library-no-entry-skill', source: 'core/skills/nofile' },
  ] }))
  put('kit/skills/good/SKILL.md', skill({ name: 'good' }))
  put('kit/skills/bad/SKILL.md', skill({ name: 'bad', description: 'Does bad things.' }))
  if (baseline !== undefined) put('scripts/skill-lint-baseline.json', typeof baseline === 'string' ? baseline : JSON.stringify({ version: 1, violations: baseline }))
  return root
}
const run = (root, ...args) => spawnSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
const baselineOf = root => JSON.parse(readFileSync(join(root, 'scripts/skill-lint-baseline.json'), 'utf8')).violations
const lastLine = s => s.trim().split('\n').at(-1)

await test('a violation the baseline does not list is NEW and fails (exit 1); listed, it passes (exit 0)', () => {
  const root = fixture({ baseline: {} })
  try {
    let r = run(root)
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stdout, /^NEW {3}bad DESCRIPTION: the description does not say when/m)
    assert.equal(lastLine(r.stdout), 'LINT-SKILLS: 2 skills, 1 violation(s): 0 baselined, 1 new, 0 stale -> FAIL')
    writeFileSync(join(root, 'scripts/skill-lint-baseline.json'), JSON.stringify({ version: 1, violations: { bad: ['DESCRIPTION'] } }))
    r = run(root)
    assert.equal(r.status, 0, r.stdout)
    assert.equal(lastLine(r.stdout), 'LINT-SKILLS: 2 skills, 1 violation(s): 1 baselined, 0 new, 0 stale -> PASS')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
await test('no baseline file means an empty one', () => {
  const root = fixture()
  try { assert.equal(run(root).status, 1) } finally { rmSync(root, { recursive: true, force: true }) }
})
await test('a fixed violation still listed is STALE and fails until --update-baseline removes it', () => {
  const root = fixture({ baseline: { bad: ['DESCRIPTION'], good: ['BODY_LENGTH', 'STEP_COMMAND'], gone: ['FRONTMATTER'] } })
  try {
    let r = run(root)
    assert.equal(r.status, 1, r.stdout)
    for (const s of ['good BODY_LENGTH', 'good STEP_COMMAND', 'gone FRONTMATTER']) assert.match(r.stdout, new RegExp(`^STALE ${s}: fixed`, 'm'))
    assert.match(lastLine(r.stdout), /1 baselined, 0 new, 3 stale -> FAIL$/)
    r = run(root, '--update-baseline')
    assert.equal(r.status, 0, r.stdout)
    assert.match(r.stdout, /removed 3 fixed violation\(s\)/)
    assert.deepEqual(baselineOf(root), { bad: ['DESCRIPTION'] })
    assert.equal(run(root).status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
await test('--update-baseline never adds a violation: the new one still fails and is not written', () => {
  const root = fixture({ baseline: { good: ['STEP_COMMAND'] } })
  try {
    const r = run(root, '--update-baseline')
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stdout, /never adds a violation/)
    assert.match(r.stdout, /^NEW {3}bad DESCRIPTION/m)
    assert.deepEqual(baselineOf(root), {}, 'the stale entry went; the new one was not added')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
await test('--update-baseline with nothing stale leaves the file byte for byte', () => {
  const text = JSON.stringify({ version: 1, violations: { bad: ['DESCRIPTION'] } }, null, 4)
  const root = fixture({ baseline: text })
  try {
    assert.equal(run(root, '--update-baseline').status, 0)
    assert.equal(readFileSync(join(root, 'scripts/skill-lint-baseline.json'), 'utf8'), text)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
await test('bad input exits 2: usage, malformed or unknown-rule baseline, missing or malformed catalog', () => {
  const root = fixture({ baseline: '{not json' })
  try {
    assert.equal(run(root, '--bogus').status, 2)
    let r = run(root)
    assert.equal(r.status, 2, r.stdout)
    assert.match(r.stdout, /LINT-SKILLS: ERROR cannot read the baseline/)
    writeFileSync(join(root, 'scripts/skill-lint-baseline.json'), JSON.stringify({ version: 1, violations: { bad: ['NOT_A_RULE'] } }))
    assert.match(run(root).stdout, /must list known rule ids/)
    writeFileSync(join(root, 'scripts/skill-lint-baseline.json'), JSON.stringify({ version: 1, violations: [] }))
    assert.match(run(root).stdout, /no violations object/)
    writeFileSync(join(root, 'spec/offering-capabilities.json'), '{"offerings": [{"id": "x"}]}')
    assert.match(run(root).stdout, /lacks a string id, source or kind/)
    rmSync(join(root, 'spec'), { recursive: true })
    r = run(root)
    assert.equal(r.status, 2)
    assert.match(r.stdout, /cannot read the catalog/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
await test("an offering without a SKILL.md is not linted, and a vendored SKILL.md outside the catalog is not read", () => {
  const root = fixture({ baseline: { bad: ['DESCRIPTION'] } })
  try {
    mkdirSync(join(root, 'graphs/x/vendor/other/skills/y'), { recursive: true })
    writeFileSync(join(root, 'graphs/x/vendor/other/skills/y/SKILL.md'), 'no frontmatter at all\n')
    const r = run(root)
    assert.equal(r.status, 0, r.stdout)
    assert.match(lastLine(r.stdout), /^LINT-SKILLS: 2 skills/)
    assert.ok(!existsSync(join(root, 'core/skills/nofile')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

console.log('== lint-skills: this repo')
await test("every skill PandaStack ships matches scripts/skill-lint-baseline.json: no new violation, none stale", () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(lastLine(r.stdout), /^LINT-SKILLS: \d+ skills, \d+ violation\(s\): \d+ baselined, 0 new, 0 stale -> PASS$/)
})
