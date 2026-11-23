// CP-03b frozen acceptance: reference-content closure
// (spec/contracts/codex-parity-cp-03b.md). Every role `skills:` name resolves to a
// catalog entry offering, the six bughunt lenses agree everywhere they are listed,
// the catalog declares the reference content each graph reaches (through child
// workflows and role-body skill paths), and the reference rows say that their prose
// guidance has no model-behavior proof. Offline and static: no HOME, network,
// provider or child process. Production checks read the candidate root; the install
// and derivation cases use owned temp roots.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const load = rel => import(pathToFileURL(resolve(ROOT, rel)))
const loadRoles = () => load('core/skills/native-runtime/role-files.mjs')
const loadCatalog = () => load('core/skills/native-runtime/catalog.mjs')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const production = () => JSON.parse(readFileSync(resolve(ROOT, 'spec/offering-capabilities.json'), 'utf8'))
const coded = code => e => e instanceof Error && e.code === code

// The catalog's own reference kind. These are the reference rows.
const REFERENCE_KIND = 'shared-reference-contract'
const REFERENCE_ROWS = ['backlog', 'bug-lenses', 'default-stack', 'findings', 'gtm-brief', 'knowledge-map', 'run-records']
const NOT_GUIDANCE_KINDS = ['executable-graph-or-cli', 'shared-library-no-entry-skill']
const LENS_DIR = 'core/skills/bug-lenses/lenses'

function owned(t, prefix = 'cp03b-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function requireV2(catalog) {
  assert.equal(catalog.schemaVersion, 2, 'spec/offering-capabilities.json is v2 (CP-01b)')
}

// ---- the contract's closure rules, written independently of any product code ----

const MENTION = /skills\/([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9._-]+)?/g
const CALL = /\bworkflow\(\s*(?:'([a-z0-9][a-z0-9-]*)'|([A-Z][A-Z0-9_]*)\b)/g
const WORKFLOW_NAME = /^[ \t]*name:[ \t]*'([a-z0-9][a-z0-9-]*)'/m
const COMMENT_LINE = /^[ \t]*(\/\/|\*|\/\*)/

// Child workflow names a workflow source calls: `workflow('<name>'` or
// `workflow(IDENT` with `const IDENT = '<name>'` in the same file. Comment lines
// are ignored. An identifier with no binding is an error (fail closed).
function childNames(source) {
  const code = source.split('\n').filter(line => !COMMENT_LINE.test(line)).join('\n')
  return [...code.matchAll(CALL)].map(m => {
    if (m[1]) return m[1]
    const bound = new RegExp(`\\bconst[ \\t]+${m[2]}[ \\t]*=[ \\t]*'([a-z0-9][a-z0-9-]*)'`).exec(source)
    if (!bound) throw new Error(`unbound child workflow identifier ${m[2]}`)
    return bound[1]
  })
}

// Map of offering id -> Map of dependency id -> reasons, for the two CP-03b rules:
// (a) CP-01b rule 1 followed through child workflows, and (b) `skills/<id>/`
// mentions in the body of every role the workflow (or a child) names. Also returns
// every role-body mention, so the test can check the mentioned path exists.
async function closureEdges(root, catalog) {
  const { loadRoleFile } = await loadRoles()
  const ids = new Set(catalog.offerings.map(o => o.id))
  const text = w => readFileSync(join(root, w.source), 'utf8')
  const byName = new Map()
  for (const w of catalog.workflows) {
    const name = WORKFLOW_NAME.exec(text(w))?.[1]
    if (!name) throw new Error(`workflow ${w.source} has no name`)
    byName.set(name, w)
  }
  const edges = new Map(catalog.offerings.map(o => [o.id, new Map()]))
  const mentions = []
  const children = []
  const add = (from, to, why) => {
    if (to === from || !ids.has(to)) return
    const reasons = edges.get(from)
    reasons.set(to, [...(reasons.get(to) ?? []), why])
  }
  for (const workflow of catalog.workflows) {
    const graph = /^graphs\/([^/]+)\/workflows\//.exec(workflow.source)?.[1]
    const owners = catalog.offerings.filter(o => graph && o.entrySkill && o.source.startsWith(`graphs/${graph}/skills/`))
    const reach = [workflow], seen = new Set([workflow.source])
    for (let i = 0; i < reach.length; i++) {
      for (const name of childNames(text(reach[i]))) {
        const child = byName.get(name)
        if (!child) throw new Error(`unresolved child workflow ${name}`)
        children.push([reach[i].source, child.source])
        if (!seen.has(child.source)) { seen.add(child.source); reach.push(child) }
      }
    }
    for (const reached of reach) {
      const via = reached === workflow ? '' : ` in child ${reached.source}`
      for (const role of reached.roles) {
        const { frontmatter, body, path } = loadRoleFile({ installationRoot: root, name: role })
        for (const skill of frontmatter.skills) for (const owner of owners) add(owner.id, skill, `role ${role} skills${via}`)
        for (const m of body.matchAll(MENTION)) {
          if (ids.has(m[1])) mentions.push({ role: path, id: m[1], segment: m[2] ?? null })
          for (const owner of owners) add(owner.id, m[1], `role ${role} body${via}`)
        }
      }
    }
  }
  return { edges, mentions, children }
}

function transitive(catalog, id) {
  const byId = new Map(catalog.offerings.map(o => [o.id, o]))
  const out = new Set(), pending = [...byId.get(id).dependencies]
  while (pending.length) {
    const next = pending.pop()
    if (out.has(next)) continue
    out.add(next)
    pending.push(...byId.get(next).dependencies)
  }
  return out
}

// ---- 1. skills: names --------------------------------------------------------------

test('every skills: name in a shipped role file resolves to an entry offering with a readable SKILL.md', async () => {
  const { listRoleFiles, loadRoleFile, assembleRoleInstructions } = await loadRoles()
  const catalog = production()
  const named = new Set()
  for (const { name } of listRoleFiles({ installationRoot: ROOT })) {
    if (!loadRoleFile({ installationRoot: ROOT, name }).frontmatter.skills.length) continue
    const assembled = assembleRoleInstructions({ installationRoot: ROOT, name })
    for (const skill of assembled.skills) {
      named.add(skill.name)
      const row = catalog.offerings.find(o => o.id === skill.name)
      assert.ok(row, `${name}: skill ${skill.name} is a catalog offering`)
      assert.equal(row.entrySkill, true, `${skill.name} is an entry offering`)
      assert.ok(row.installTargets.includes(`skills/${skill.name}`), `${skill.name} installs under its own name`)
      assert.equal(skill.path, `${row.source}/SKILL.md`, `${name}: ${skill.name} resolves to the catalog source`)
      const file = resolve(ROOT, skill.path)
      assert.ok(lstatSync(file).isFile(), `${skill.path} is a regular file`)
      assert.equal(sha(readFileSync(file)), row.entrySha256, `${skill.path} matches entrySha256`)
      assert.ok(skill.body.trim().length > 0, `${skill.path} has a body`)
    }
  }
  for (const expected of ['bug-lenses', 'harness-review', 'knowledge-map']) assert.ok(named.has(expected), `found skills: ${expected}`)
})

// ---- 2. the six lenses -------------------------------------------------------------

function quotedList(source, name) {
  const m = new RegExp(`^const ${name} = \\[([^\\]]*)\\]`, 'm').exec(source)
  assert.ok(m, `${name} is declared`)
  return [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1])
}

test('the six lenses in intake routing equal the lens files, the skill table and the hunt lists', async () => {
  const { ALWAYS, SIGNALS, routeLenses } = await load('graphs/hunt/skills/bughunt/intake.mjs')
  const routing = [...ALWAYS, ...Object.keys(SIGNALS)]
  assert.equal(new Set(routing).size, routing.length, 'ALWAYS and SIGNALS do not overlap')
  assert.equal(routing.length, 6, 'six lenses in intake routing')
  const six = [...routing].sort()

  const entries = readdirSync(resolve(ROOT, LENS_DIR), { withFileTypes: true })
  for (const entry of entries) assert.ok(entry.isFile() && /^[a-z]+\.md$/.test(entry.name), `${entry.name} is a regular <lens>.md file`)
  assert.deepEqual(entries.map(e => e.name.replace(/\.md$/, '')).sort(), six, 'lens files equal intake routing')
  const tokens = {}
  for (const lens of six) {
    const lines = readFileSync(resolve(ROOT, LENS_DIR, `${lens}.md`), 'utf8').match(/^lens-token: \S+$/gm) ?? []
    assert.equal(lines.length, 1, `${lens}.md has one lens-token line`)
    tokens[lens] = lines[0].slice('lens-token: '.length)
  }

  const skill = readFileSync(resolve(ROOT, 'core/skills/bug-lenses/SKILL.md'), 'utf8')
  const section = skill.slice(skill.indexOf('## The lenses'))
  assert.deepEqual([...section.matchAll(/^\| `([a-z]+)` \|/gm)].map(m => m[1]).sort(), six, 'SKILL.md lens table')

  const flow = readFileSync(resolve(ROOT, 'graphs/hunt/workflows/bughunt-flow.js'), 'utf8')
  assert.deepEqual(quotedList(flow, 'LENSES').sort(), six, 'bughunt-flow LENSES')
  assert.deepEqual(quotedList(flow, 'LENS_ORDER').sort(), six, 'bughunt-flow LENS_ORDER')
  const tokenBlock = /^const LENS_TOKENS = \{([^}]*)\}/m.exec(flow)
  assert.ok(tokenBlock, 'LENS_TOKENS is declared')
  const flowTokens = Object.fromEntries([...tokenBlock[1].matchAll(/([a-z]+): '([a-z0-9-]+)'/g)].map(m => [m[1], m[2]]))
  assert.deepEqual(flowTokens, tokens, 'LENS_TOKENS equal the lens-token lines')
  const { LENSES } = await load('core/skills/findings/findings.mjs')
  assert.deepEqual([...LENSES].sort(), six, 'findings LENSES')

  // Routing really reaches every lens: one code file that trips every signal.
  const lines = ['await queue.run()', 'const token = session.cookie', 'try { a() } catch (e) { throw e }', 'export const shape = 1']
  const files = [{ path: 'src/a.js', isCode: true, isTest: false, hunks: [[1, lines.length]],
    addedLines: lines.map((text, i) => [i + 1, text]), removedLines: [] }]
  assert.deepEqual([...routeLenses(files).routed].sort(), six, 'a change that trips every signal routes all six')
  assert.deepEqual(routeLenses([]).routed, [], 'no change routes nothing')
})

// ---- 3. closure dependencies --------------------------------------------------------

test('declared dependencies cover the closure: child workflows and role-body skill paths', async () => {
  const catalog = production()
  const { edges, mentions, children } = await closureEdges(ROOT, catalog)
  // The derivation must see each rule at work, so an empty result cannot pass.
  assert.ok(children.some(([parent, child]) => parent === 'graphs/dev/workflows/dev-build.js' &&
    child === 'graphs/qa/workflows/harness-repair.js'), 'dev-build calls harness-repair as a child workflow')
  assert.ok(edges.get('dev').get('harness-review')?.some(r => r.includes('in child graphs/qa/workflows/harness-repair.js')),
    'dev reaches harness-review through the nested reviewer')
  assert.ok(edges.get('dev').get('verify')?.some(r => r.startsWith('role implementer body')), 'dev reaches verify through a role body')
  assert.ok(edges.get('bughunt').get('backlog')?.some(r => r.startsWith('role advisor body')), 'bughunt reaches backlog through the advisor body')
  const missing = []
  for (const offering of catalog.offerings) {
    for (const [dependency, reasons] of edges.get(offering.id)) {
      if (!offering.dependencies.includes(dependency)) missing.push(`${offering.id} -> ${dependency} (${[...new Set(reasons)].join('; ')})`)
    }
  }
  assert.deepEqual(missing, [], 'undeclared closure edges')
  // Every role-body skill path names something that exists in that offering.
  assert.ok(mentions.length > 0, 'role bodies mention skill paths')
  for (const { role, id, segment } of mentions) {
    const row = catalog.offerings.find(o => o.id === id)
    if (segment === null) continue
    const target = resolve(ROOT, row.source, segment)
    assert.ok(existsSync(target) && (lstatSync(target).isFile() || lstatSync(target).isDirectory()),
      `${role}: skills/${id}/${segment} exists in ${row.source}`)
  }
})

test('the closure derivation follows a child workflow and refuses an unresolved one', async t => {
  const root = owned(t)
  const files = {
    'graphs/app/workflows/parent.js': "export const meta = {\n  name: 'parent',\n}\n// await workflow('ghost')\nconst KID = 'kid'\nawait workflow(KID, {})\n",
    'graphs/lib/workflows/kid.js': "export const meta = {\n  name: 'kid',\n}\n",
    'graphs/app/agents/boss.md': '---\nname: boss\ndescription: d\nmodel: m\nskills:\n  - ref-a\n---\n\nBoss.\n',
    'graphs/lib/agents/helper.md': '---\nname: helper\ndescription: d\nmodel: m\nskills:\n  - ref-c\n---\n\nRun `skills/ref-b/run.sh`.\n',
  }
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  const row = (id, source, entrySkill = true) => ({ id, source, entrySkill, dependencies: [] })
  const catalog = {
    offerings: [row('app', 'graphs/app/skills/app'), row('ref-a', 'core/skills/ref-a'), row('ref-b', 'core/skills/ref-b'),
      row('ref-c', 'core/skills/ref-c'), row('ghost', 'core/skills/ghost')],
    workflows: [{ source: 'graphs/app/workflows/parent.js', roles: ['boss'] }, { source: 'graphs/lib/workflows/kid.js', roles: ['helper'] }],
  }
  const { edges, children } = await closureEdges(root, catalog)
  assert.deepEqual(children, [['graphs/app/workflows/parent.js', 'graphs/lib/workflows/kid.js']])
  assert.deepEqual([...edges.get('app').keys()].sort(), ['ref-a', 'ref-b', 'ref-c'], 'a commented call is not a child')
  writeFileSync(join(root, 'graphs/app/workflows/parent.js'), "export const meta = {\n  name: 'parent',\n}\nawait workflow('nowhere')\n")
  await assert.rejects(closureEdges(root, catalog), /unresolved child workflow/)
})

// ---- 4. reference rows ---------------------------------------------------------------

test('reference rows declare dependencies, stay non-supported and carry GUIDANCE_ONLY under both providers', async () => {
  const catalog = production()
  requireV2(catalog)
  const reference = catalog.offerings.filter(o => o.kind === REFERENCE_KIND)
  assert.deepEqual(reference.map(o => o.id), REFERENCE_ROWS, 'the reference rows')
  const { edges } = await closureEdges(ROOT, catalog)
  for (const row of reference) {
    assert.equal(row.entrySkill, true, `${row.id} is an entry skill`)
    assert.ok(Array.isArray(row.dependencies), `${row.id} declares dependencies`)
    assert.deepEqual(row.dependencies, [...new Set(row.dependencies)].sort(), `${row.id} dependencies are sorted and unique`)
    for (const dependency of edges.get(row.id).keys()) assert.ok(row.dependencies.includes(dependency), `${row.id} -> ${dependency}`)
    for (const backend of ['claude', 'codex']) {
      const entry = row.providers[backend]
      assert.notEqual(entry.implementation, 'supported', `${row.id} ${backend} is not supported`)
      assert.ok(entry.limitations.includes('GUIDANCE_ONLY'), `${row.id} ${backend} GUIDANCE_ONLY`)
      assert.ok(entry.limitations.includes('REQUIREMENTS_INCOMPLETE'), `${row.id} ${backend} REQUIREMENTS_INCOMPLETE`)
    }
    assert.ok(row.providers.codex.limitations.includes('NATIVE_UNVERIFIED'), `${row.id} codex NATIVE_UNVERIFIED`)
  }
  // GUIDANCE_ONLY never marks a graph or a code library: those are not prose guidance.
  for (const row of catalog.offerings.filter(o => NOT_GUIDANCE_KINDS.includes(o.kind))) {
    for (const backend of ['claude', 'codex']) {
      assert.ok(!row.providers[backend].limitations.includes('GUIDANCE_ONLY'), `${row.id} ${backend} has no GUIDANCE_ONLY`)
    }
  }
  const { validateCatalog } = await loadCatalog()
  assert.deepEqual(validateCatalog(catalog), [], 'the catalog validates')
})

// ---- 5. install closure ------------------------------------------------------------

test('every codex install closure stays under core/skills, and install-plan checks the new dependencies', async t => {
  const catalog = production()
  requireV2(catalog)
  const { installEligible } = await loadCatalog()
  const { installPlan } = await load('core/skills/native-runtime/install-plan.mjs')
  // Amended at the CP-04e freeze (W2-10): CP-04e adds blueprint to the installed set;
  // its own test pins that state. Its closure (backlog, default-stack, knowledge-map,
  // native-runtime, run-records) is checked by the loop below like every other.
  const flipped = catalog.offerings.find(o => o.id === 'blueprint').providers.codex.implementation === 'partial'
  const expected = [{ dest: 'skills/autobuild', src: 'graphs/autobuild/skills/autobuild' },
    ...(flipped ? [{ dest: 'skills/blueprint', src: 'graphs/blueprint/skills/blueprint' }] : []),
    { dest: 'skills/bughunt', src: 'graphs/hunt/skills/bughunt' },
    // Amended for CP-06: dev joins the installed set; its closure is checked by the loop below.
    ...(catalog.offerings.find(o => o.id === 'dev').providers.codex.implementation === 'partial'
      ? [{ dest: 'skills/dev', src: 'graphs/dev/skills/dev' }] : [])]
  assert.deepEqual(installPlan({ installationRoot: ROOT, backend: 'codex' }), expected, 'the installed set is unchanged (plus blueprint after CP-04e)')
  const byId = new Map(catalog.offerings.map(o => [o.id, o]))
  for (const row of catalog.offerings.filter(o => installEligible(o, 'codex'))) {
    for (const id of transitive(catalog, row.id)) {
      assert.ok(byId.get(id).source.startsWith('core/skills/'), `${row.id} -> ${id} lives under core/skills`)
    }
  }
  assert.ok(transitive(catalog, 'bughunt').has('backlog'), 'bughunt -> backlog is declared')

  // A root holding every source as an empty real directory plans the same two entries;
  // removing backlog, which only the closure rules make a bughunt dependency, refuses.
  const root = join(owned(t), 'repo root')
  mkdirSync(join(root, 'spec'), { recursive: true })
  cpSync(resolve(ROOT, 'spec/offering-capabilities.json'), join(root, 'spec/offering-capabilities.json'))
  for (const row of catalog.offerings) mkdirSync(join(root, row.source), { recursive: true })
  assert.deepEqual(installPlan({ installationRoot: root, backend: 'codex' }), expected)
  rmSync(join(root, 'core/skills/backlog'), { recursive: true })
  assert.throws(() => installPlan({ installationRoot: root, backend: 'codex' }), coded('DEPENDENCY_MISSING'))
})

// ---- 6. drift guard ----------------------------------------------------------------

test('the drift guard stays ok on the candidate root', async () => {
  const api = await loadCatalog()
  assert.equal(typeof api.checkCatalogDrift, 'function', 'catalog.mjs exports checkCatalogDrift (CP-01b)')
  assert.deepEqual(api.checkCatalogDrift({ installationRoot: ROOT }), { ok: true, problems: [] })
})
