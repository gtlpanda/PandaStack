// Role-file loader with skills inlining (spec/contracts/codex-parity-cp-03c.md).
// Locates a role file under core/agents, kit/agents or graphs/<g>/agents, parses its
// YAML-ish frontmatter fail-closed, and assembles the leaf instruction text: the role
// body, then each declared skill's SKILL.md body (frontmatter stripped) once, in
// declared order. Only real directories and regular files count, so a symlink can
// never pull in bytes from outside the installation tree. The assembled instructions
// carry installed skill paths resolved into the tree (spec/contracts/codex-parity-cp-03d.md);
// the raw bodies keep their shell-expandable tokens.
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fail, fields } from './boundary.mjs'

export const ROLE_FRONTMATTER_KEYS = Object.freeze(['name', 'description', 'model', 'effort', 'tools', 'skills', 'memory'])

const REQUIRED_KEYS = ['name', 'description', 'model']
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const SKILL_ENTRY = /^  - (.*)$/
// The hunt runner's delimiter rule (graphs/hunt/skills/bughunt/native-runner.mjs,
// agentInstructions); the loader and the runner cut at the same byte.
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/
const STRIP = /^---\n[\s\S]*?\n---\n/
// Fatal: invalid bytes are never replaced. ignoreBOM keeps a leading BOM in the
// text, as the runner's readFileSync(…, 'utf8') does, so such a file fails the
// delimiter match here instead of parsing differently from the runner.
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// ---- arguments ----------------------------------------------------------------

// Root is checked before name, and both before any file access. An options value
// that is not a plain data object cannot carry a root, so it is INVALID_ROLE_ROOT.
function rootInput(options) {
  const { installationRoot } = fields(options, 'INVALID_ROLE_ROOT')
  if (typeof installationRoot !== 'string' || !isAbsolute(installationRoot) || installationRoot.includes('\0')) fail('INVALID_ROLE_ROOT')
  return installationRoot
}

function nameInput(options) {
  const { name } = fields(options, 'INVALID_ROLE_ROOT')
  if (typeof name !== 'string' || !NAME.test(name)) fail('INVALID_ROLE_NAME')
  return name
}

// ---- filesystem -----------------------------------------------------------------

// Entries of a directory relative to the root, or [] when it is missing. Any other
// failure is IO_ERROR; the raw system error never reaches the caller.
function entries(root, rel) {
  try {
    return readdirSync(join(root, rel), { withFileTypes: true })
  } catch (e) {
    if (e?.code === 'ENOENT') return []
    fail('IO_ERROR')
  }
}
// Dirent kinds come from lstat, so a symlink is neither a directory nor a file.
const realDirs = (root, rel) => entries(root, rel).filter(d => d.isDirectory()).map(d => d.name)
const regularFiles = (root, rel) => entries(root, rel).filter(d => d.isFile()).map(d => d.name)

// 'core', 'kit' and 'graphs/<g>' for every real directory under graphs, when present.
function containers(root) {
  const top = realDirs(root, '')
  const graphs = top.includes('graphs') ? realDirs(root, 'graphs').sort().map(g => `graphs/${g}`) : []
  return [...['core', 'kit'].filter(c => top.includes(c)), ...graphs]
}

// [{ container, dir }] for each container that has a real `<kind>` directory.
const kindDirs = (root, kind) => containers(root)
  .filter(container => realDirs(root, container).includes(kind))
  .map(container => ({ container, dir: `${container}/${kind}` }))

// Every regular `.md` file in every agents directory, unvalidated and unsorted.
function roleEntries(root) {
  return kindDirs(root, 'agents').flatMap(({ container, dir }) => regularFiles(root, dir)
    .filter(file => file.endsWith('.md'))
    .map(file => ({ name: file.slice(0, -3), path: `${dir}/${file}`, root: container })))
}

// Opens without following a final symlink and requires a regular file, then decodes.
function readText(root, rel, invalidCode) {
  let bytes
  try {
    const fd = openSync(join(root, rel), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!fstatSync(fd).isFile()) fail('IO_ERROR')
      bytes = readFileSync(fd)
    } finally { closeSync(fd) }
  } catch { fail('IO_ERROR') }
  try { return DECODER.decode(bytes) } catch { fail(invalidCode) }
}

// ---- parsing ----------------------------------------------------------------------

// Returns the frontmatter object for a role whose file stem is `stem`.
function parseFrontmatter(block, stem) {
  if (block.includes('\r')) fail('INVALID_ROLE_FRONTMATTER')
  const values = new Map()
  let skillsOpen = false
  for (const line of block.split('\n')) {
    const entry = line.match(SKILL_ENTRY)
    if (entry && skillsOpen) {
      const skills = values.get('skills')
      if (!NAME.test(entry[1]) || skills.includes(entry[1])) fail('INVALID_ROLE_FRONTMATTER')
      skills.push(entry[1])
      continue
    }
    if (skillsOpen && values.get('skills').length === 0) fail('INVALID_ROLE_FRONTMATTER')
    skillsOpen = false
    const colon = line.indexOf(':')
    if (colon < 0) fail('INVALID_ROLE_FRONTMATTER')
    const key = line.slice(0, colon)
    const value = line.slice(colon + 1).trim()
    if (!ROLE_FRONTMATTER_KEYS.includes(key) || values.has(key)) fail('INVALID_ROLE_FRONTMATTER')
    if (key === 'skills') {
      if (value !== '') fail('INVALID_ROLE_FRONTMATTER')
      values.set('skills', [])
      skillsOpen = true
      continue
    }
    if (value === '') fail('INVALID_ROLE_FRONTMATTER')
    values.set(key, key === 'tools' ? toolList(value) : value)
  }
  if (skillsOpen && values.get('skills').length === 0) fail('INVALID_ROLE_FRONTMATTER')
  if (REQUIRED_KEYS.some(key => !values.has(key)) || values.get('name') !== stem) fail('INVALID_ROLE_FRONTMATTER')
  return {
    name: values.get('name'),
    description: values.get('description'),
    model: values.get('model'),
    effort: values.get('effort') ?? null,
    tools: values.get('tools') ?? [],
    skills: values.get('skills') ?? [],
    memory: values.get('memory') ?? null,
  }
}

function toolList(value) {
  const tools = value.split(',').map(tool => tool.trim())
  if (tools.some(tool => tool === '')) fail('INVALID_ROLE_FRONTMATTER')
  return tools
}

// ---- skills ---------------------------------------------------------------------

// The one skill directory (relative to the root) that is a real directory `name`
// holding a regular SKILL.md, under any skills root. A directory without SKILL.md
// is not a skill.
function locateSkill(root, name) {
  const hits = kindDirs(root, 'skills')
    .filter(({ dir }) => realDirs(root, dir).includes(name) && regularFiles(root, `${dir}/${name}`).includes('SKILL.md'))
    .map(({ dir }) => `${dir}/${name}`)
  if (hits.length === 0) fail('UNKNOWN_SKILL')
  if (hits.length > 1) fail('DUPLICATE_SKILL')
  return hits[0]
}

function resolveSkill(root, name) {
  const path = `${locateSkill(root, name)}/SKILL.md`
  const text = readText(root, path, 'INVALID_SKILL_FILE')
  if (!STRIP.test(text)) fail('INVALID_SKILL_FILE')
  return { name, path, body: text.replace(STRIP, '').replace(/^\n+/, '') }
}

// ---- skill-path tokens (spec/contracts/codex-parity-cp-03d.md) --------------------

// The exact token a role file writes for an installed skill file. Its shell default
// is today's Claude path, so the raw file behaves the same under Claude Code.
const SKILL_PATH_TOKEN = /\$\{PANDASTACK_SKILL_PATH:-\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}\/skills\/([a-z0-9][a-z0-9-]{0,63})\/([A-Za-z0-9._-]+)\}/g
// Characters special inside double quotes, plus the line break: the rewritten path
// lands inside `bash "..."`.
const UNSAFE_SPLICE_ROOT = /["$`\\\n]/

// Absolute path of `file`, a regular file directly in skill `id`'s directory. Judged
// by the directory listing (lstat kinds); the file's bytes are never read. A missing
// name, a symlink, a directory, `.` and `..` are all absent.
function skillFilePath(root, id, file) {
  const dir = locateSkill(root, id)
  if (!regularFiles(root, dir).includes(file)) fail('UNKNOWN_SKILL')
  return join(root, dir, file)
}

// Replaces every exact token with its file in the installation tree, in text order.
// Text with no token is returned unchanged and the root is not checked.
function rewriteSkillPaths(root, text) {
  if (!text.match(new RegExp(SKILL_PATH_TOKEN.source))) return text
  if (UNSAFE_SPLICE_ROOT.test(root)) fail('INVALID_ROLE_ROOT')
  return text.replace(SKILL_PATH_TOKEN, (_, id, file) => skillFilePath(root, id, file))
}

// ---- exports --------------------------------------------------------------------

export function listRoleFiles(options) {
  const root = rootInput(options)
  const rows = roleEntries(root)
  if (rows.some(row => !NAME.test(row.name))) fail('INVALID_ROLE_NAME')
  if (new Set(rows.map(row => row.name)).size !== rows.length) fail('DUPLICATE_ROLE')
  return rows.sort((a, b) => (a.path < b.path ? -1 : 1))
}

export function loadRoleFile(options) {
  const root = rootInput(options)
  const name = nameInput(options)
  const hits = roleEntries(root).filter(row => row.name === name)
  if (hits.length === 0) fail('ROLE_NOT_FOUND')
  if (hits.length > 1) fail('DUPLICATE_ROLE')
  const { path, root: container } = hits[0]
  const text = readText(root, path, 'INVALID_ROLE_FILE')
  const match = text.match(FRONTMATTER)
  if (!match) fail('INVALID_ROLE_FRONTMATTER')
  const frontmatter = parseFrontmatter(match[1], name)
  return { name, path, root: container, frontmatter, body: text.replace(STRIP, '') }
}

export function assembleRoleInstructions(options) {
  const role = loadRoleFile(options)
  const root = rootInput(options)
  const skills = role.frontmatter.skills.map(skill => resolveSkill(root, skill))
  const text = skills.length === 0 ? role.body : [role.body, ...skills.map(s => s.body)].join('\n')
  // `body` and `skills[].body` stay raw; only `instructions` carries resolved paths.
  return { ...role, skills, instructions: rewriteSkillPaths(root, text) }
}
