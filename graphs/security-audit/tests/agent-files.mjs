// agent-files.mjs - reads the security-audit agent files for the tests that pin them. Not a test file: scripts/test-workflow.mjs runs only
// *.test.mjs. scripts/workflow-harness.mjs agentField reads only a first token, which is wrong for `tools: Read, Grep, Glob`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from '../../../scripts/workflow-harness.mjs'

export const AGENT_DIR = join(REPO, 'graphs', 'security-audit', 'agents')

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

export const agentFile = name => parseAgent(readFileSync(join(AGENT_DIR, `${name}.md`), 'utf8'))
