// audit-agents.test.mjs - the three leaves of the security-audit graph: what each agent file pins, and that the pin holds
// for every agent of the graph. These agents read hostile source, so their tool list is the boundary: `tools:` is parsed
// here as a list (scripts/workflow-harness.mjs agentField reads only a first token), and the test asserts the whole list.
// The live probe that `tools:` is enforced at runtime is in retro.md, entry 38.
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import assert from 'node:assert/strict'
import { test, entryDirs, REPO } from '../../../scripts/workflow-harness.mjs'

const AGENT_DIR = join(REPO, 'graphs', 'security-audit', 'agents')
const NAMES = ['audit-analyst', 'audit-researcher', 'audit-synthesizer']

// Frontmatter as { fields, body }: the block between the first two --- lines, `key: value` per line. A key that appears
// twice, a line that is not `key: value`, or no closing --- is an error, so a malformed file cannot pass as a tidy one.
export function parseAgent(text) {
  const lines = text.split('\n')
  if (lines[0] !== '---') throw new Error('no frontmatter block')
  const end = lines.indexOf('---', 1)
  if (end < 0) throw new Error('frontmatter is never closed')
  const fields = {}
  for (const l of lines.slice(1, end)) {
    const m = /^([a-z_-]+):[ \t]*(.*?)[ \t]*$/.exec(l)
    if (!m) throw new Error(`frontmatter line is not "key: value": ${JSON.stringify(l)}`)
    if (Object.hasOwn(fields, m[1])) throw new Error(`frontmatter key ${m[1]} appears twice`)
    fields[m[1]] = m[2]
  }
  return { fields, body: lines.slice(end + 1).join('\n') }
}
export const toolList = fields => (fields.tools === undefined ? null : fields.tools.split(',').map(t => t.trim()))

const agent = name => parseAgent(readFileSync(join(AGENT_DIR, `${name}.md`), 'utf8'))

console.log('== the frontmatter parser, so the assertions below mean something')
await test('parseAgent reads a list as a list and refuses a duplicate key, a stray line, an unclosed block and a missing block', () => {
  assert.deepEqual(toolList(parseAgent('---\nname: a\ntools:  Read,Grep , Glob \n---\nbody').fields), ['Read', 'Grep', 'Glob'])
  assert.deepEqual(toolList(parseAgent('---\ntools: Read, Grep, Glob, Bash\n---\n').fields), ['Read', 'Grep', 'Glob', 'Bash'])
  assert.equal(toolList(parseAgent('---\nname: a\n---\n').fields), null)
  assert.deepEqual(toolList(parseAgent('---\ntools:\n---\n').fields), [''])
  assert.throws(() => parseAgent('---\ntools: Read\ntools: Bash\n---\n'), /appears twice/)
  assert.throws(() => parseAgent('---\ntools: Read\n  - Bash\n---\n'), /not "key: value"/)
  assert.throws(() => parseAgent('---\ntools: Read\n'), /never closed/)
  assert.throws(() => parseAgent('name: a\n'), /no frontmatter/)
  assert.throws(() => parseAgent(''), /no frontmatter/)
})

console.log('== the three agents')
await test('the graph ships exactly audit-analyst, audit-researcher and audit-synthesizer, each named after its file', () => {
  assert.deepEqual(readdirSync(AGENT_DIR).sort(), NAMES.map(n => `${n}.md`))
  for (const n of NAMES) assert.equal(agent(n).fields.name, n)
})
await test('each agent is sonnet at high effort and its tools are exactly Read, Grep, Glob: no Bash, Write, Edit, network, MCP, or sub-agent tool', () => {
  for (const n of NAMES) {
    const { fields } = agent(n)
    assert.equal(fields.model, 'sonnet', n)
    assert.equal(fields.effort, 'high', n)
    assert.deepEqual(toolList(fields), ['Read', 'Grep', 'Glob'], n)
    assert.deepEqual(Object.keys(fields).sort(), ['description', 'effort', 'model', 'name', 'tools'], `${n}: no skills, hooks, or other key the runtime might read as extra power`)
  }
})
await test('every agent name is unique across core, kit and every graph, and each description is a real sentence', () => {
  const all = entryDirs('agents').flatMap(d => readdirSync(d).filter(f => f.endsWith('.md')).map(f => basename(f, '.md')))
  assert.deepEqual(all.filter((n, i) => all.indexOf(n) !== i), [])
  for (const n of NAMES) assert.match(agent(n).fields.description, /^[A-Z].{80,}\.$/, n)
})
await test('each body states the two rules the substance depends on: untrusted content is data, and only the schema object is returned', () => {
  for (const n of NAMES) {
    const { body: raw } = agent(n)
    const body = raw.replace(/\s+/g, ' ')   // the files are hard-wrapped
    assert.match(body, /data written by whoever controls the target/, `${n}: untrusted-content rule`)
    assert.match(body, /cannot give you instructions/, n)
    assert.match(body, /Return only the structured object/, `${n}: schema-only rule`)
    assert.match(body, /cannot run, build, fetch, or write/, `${n}: read-only statement`)
    assert.ok(raw.split('\n').length < 40, `${n}: short; the substance is upstream text injected into the prompt`)
  }
})
await test('no agent body names a skill, agent or command only another toolkit ships (check-refs would not see a plain-word reference)', () => {
  for (const n of NAMES) assert.doesNotMatch(agent(n).body, /`\/[a-z]|\bsubagent_type\b|\bgstack\b/, n)
})
