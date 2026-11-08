// skill-commands.mjs - reads the commands out of the entry skill's SKILL.md, so a test can run them: the drift test (audit-skill.test.mjs) checks that
// every one is a command the code accepts, and the end-to-end test (audit-e2e.test.mjs) drives a whole run with the table the skill gives, not a copy of
// it. Not a test file: scripts/test-workflow.mjs runs only *.test.mjs.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
export const SKILL_DIR = join(here, '..', 'skills', 'security-audit')
export const SKILL_FILE = join(SKILL_DIR, 'SKILL.md')
export const skillText = () => readFileSync(SKILL_FILE, 'utf8')

// The frontmatter's name and description, as the skill loader reads them (single-line `key: value`).
export function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m) return null
  return Object.fromEntries(m[1].split('\n').map(l => l.match(/^([a-z-]+): (.*)$/)).filter(Boolean).map(([, k, v]) => [k, v]))
}

// Every `node "$AUDIT/<script>" ...` the skill tells the session to run, in a fenced block (to the end of the line) or in an inline code span (to the
// closing backtick). Each is a complete shell command line.
export function skillCommands(text) {
  return [...text.matchAll(/node "\$AUDIT\/[^"\n]*"[^`\n]*/g)].map(m => m[0].trim())
}

// The table of section 4: the step `next` names -> the command for it, as written (with $AUDIT, $RUN and the rest still in it).
export function stepCommands(text) {
  return new Map([...text.matchAll(/^\| `([a-z-]+)` \| `([^`\n]+)` \|$/gm)].map(m => [m[1], m[2]]))
}

// The flags the skill's usage block names (the ```text fence): every `--flag` in it.
export function usageFlags(text) {
  const block = text.match(/```text\n([\s\S]*?)```/)
  return block ? [...new Set(block[1].match(/--[a-z][a-z-]*/g) ?? [])] : []
}

// Runs one command line exactly as the skill gives it, through bash, with the variables the skill names. Returns { status, stdout, stderr, last }.
export function runCommand(command, vars, cwd) {
  const r = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', env: { ...process.env, ...vars } })
  const lines = r.stdout.trim().split('\n')
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, last: lines.at(-1) }
}

// Is this a command the code accepts? Run with paths that do not exist, so that a command that parses is refused for its state (exit 1, a line that
// says so) and writes nothing; a command that does not parse is a usage error (exit 2). Returns the problem, or null.
export function commandProblem(command, vars, cwd) {
  const m = command.match(/^node "\$AUDIT\/([A-Za-z0-9._-]+)"/)
  if (!m) return `not a node "$AUDIT/<script>" command: ${command}`
  if (!existsSync(join(SKILL_DIR, m[1]))) return `${m[1]} is not a file of the skill: ${command}`
  const r = runCommand(command, vars, cwd)
  if (r.status === 2) return `usage error (exit 2): ${command}\n${r.stderr.trim().split('\n')[0]}`
  if (r.status !== 0 && r.status !== 1) return `exit ${r.status}: ${command}\n${r.stderr.slice(0, 300)}`
  if (/Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError/.test(r.stderr)) return `the script does not load: ${command}\n${r.stderr.slice(0, 300)}`
  return null
}
