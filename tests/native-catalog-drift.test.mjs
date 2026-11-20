// CP-01b drift-guard edges the frozen acceptance does not pin: symlinks are never
// followed, which import forms count, which derivations never become edges, one
// problem per pair, null-first ordering, unsafe container names and listing errors.
// Fixture roots only; production values later features may change are not pinned here.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { test } from '../scripts/workflow-harness.mjs'

const api = () => import('../core/skills/native-runtime/catalog.mjs')
const sha = text => createHash('sha256').update(text).digest('hex')
const problem = (code, ref, dependency = null) => ({ code, ref, dependency })

const FILES = {
  'install.sh': '#!/bin/sh\n',
  'core/skills/lib/x.mjs': 'export const a = 1\n',
  'core/skills/ref/SKILL.md': '# ref\n',
  'core/skills/guide/SKILL.md': '# guide\n',
  'graphs/g/skills/app/SKILL.md': '# app\n',
  'graphs/g/workflows/w.js': "export const meta = { name: 'w' }\n",
  'graphs/g/agents/helper.md': '---\nname: helper\ndescription: d\nmodel: sonnet\n---\nbody\n',
}

// skillText is the entry SKILL.md text, or null for a library offering.
function row(id, source, skillText, dependencies = []) {
  const library = skillText === null ? ['LIBRARY_ONLY'] : []
  return {
    id, kind: skillText === null ? 'shared-library-no-entry-skill' : 'shared-reference-contract', source,
    entrySkill: skillText !== null, installTargets: [`skills/${id}`], nativeReadiness: 'unknown', dependencies,
    evidenceOwners: [], requiredRuntimes: [], aliases: [], requirementsComplete: false,
    entrySha256: skillText === null ? null : sha(skillText),
    providers: {
      claude: { implementation: 'partial', transportId: 'claude-code', limitations: [...library, 'REQUIREMENTS_INCOMPLETE'] },
      codex: { implementation: 'unavailable', transportId: null,
        limitations: [...library, 'NATIVE_UNVERIFIED', 'NO_PROVIDER_TRANSPORT', 'REQUIREMENTS_INCOMPLETE'] },
    },
    permissionProfile: null, proofRefs: [],
  }
}

function catalog() {
  return {
    schemaVersion: 2, status: 'PROPOSED_CATALOG_NOT_RUNTIME_CERTIFICATION', inventorySha256: 'b'.repeat(64),
    offerings: [
      row('lib', 'core/skills/lib', null),
      row('ref', 'core/skills/ref', FILES['core/skills/ref/SKILL.md']),
      row('guide', 'core/skills/guide', FILES['core/skills/guide/SKILL.md']),
      row('app', 'graphs/g/skills/app', FILES['graphs/g/skills/app/SKILL.md']),
    ],
    workflows: [{ source: 'graphs/g/workflows/w.js', roles: ['helper'], nativeReadiness: 'unknown',
      sha256: sha(FILES['graphs/g/workflows/w.js']) }],
    assets: [], fixedTargets: [], installerTargets: [], aliases: [],
    transports: [{ id: 'claude-code', provider: 'claude', entry: 'install.sh' }], limits: [],
  }
}

// A fixture installation root with FILES; `edit(catalog)` adjusts the catalog before it
// is written. `write` adds or replaces a root-relative file afterwards.
function fixture(cleanups, edit = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-01b-drift-'))
  cleanups.push(dir)
  const root = join(dir, 'install')
  const write = (path, text) => {
    mkdirSync(join(root, posix.dirname(path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  for (const [path, text] of Object.entries(FILES)) write(path, text)
  const value = catalog()
  edit(value)
  write('spec/offering-capabilities.json', JSON.stringify(value))
  return { root, dir, write }
}

// Runs fn with a fixture maker and removes every fixture afterwards.
async function withFixtures(fn) {
  const cleanups = []
  try { await fn(edit => fixture(cleanups, edit)) } finally {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
  }
}

await test('drift guard: a symlinked file is never a regular file, even to the right bytes', async () => {
  const { checkCatalogDrift } = await api()
  await withFixtures(async make => {
    const x = make()
    for (const [i, path] of ['core/skills/ref/SKILL.md', 'graphs/g/workflows/w.js', 'install.sh'].entries()) {
      writeFileSync(join(x.dir, `copy-${i}`), FILES[path])
      rmSync(join(x.root, path))
      symlinkSync(join(x.dir, `copy-${i}`), join(x.root, path))
    }
    assert.deepEqual(checkCatalogDrift({ installationRoot: x.root }).problems, [
      problem('ENTRY_SHA_MISMATCH', 'ref'),
      problem('TRANSPORT_ENTRY_MISSING', 'claude-code'),
      problem('WORKFLOW_SHA_MISMATCH', 'graphs/g/workflows/w.js'),
    ])
  })
})

const noMkfifo = spawnSync('mkfifo', ['--version']).error ? 'mkfifo is not available' : false
await test('drift guard: a FIFO in place of a SKILL.md is reported without blocking', { skip: noMkfifo }, async () => {
  const { checkCatalogDrift } = await api()
  await withFixtures(async make => {
    const x = make()
    rmSync(join(x.root, 'core/skills/ref/SKILL.md'))
    const made = spawnSync('mkfifo', [join(x.root, 'core/skills/ref/SKILL.md')])
    assert.equal(made.status, 0, 'mkfifo created the FIFO')
    assert.deepEqual(checkCatalogDrift({ installationRoot: x.root }).problems, [problem('ENTRY_SHA_MISMATCH', 'ref')])
  })
})

await test('drift guard: a symlinked directory is neither a present source, an unlisted one, nor walked', async () => {
  const { checkCatalogDrift } = await api()
  await withFixtures(async make => {
    const x = make()
    // An offering source replaced by a symlink to a real skill directory.
    rmSync(join(x.root, 'core/skills/ref'), { recursive: true })
    symlinkSync(join(x.root, 'core/skills/guide'), join(x.root, 'core/skills/ref'))
    // Symlinked skill directories and a symlinked container are not listed.
    mkdirSync(join(x.root, 'kit/skills'), { recursive: true })
    symlinkSync(join(x.root, 'core/skills/guide'), join(x.root, 'kit/skills/alias'))
    x.write('outside/skills/stray/SKILL.md', '# stray\n')
    symlinkSync(join(x.root, 'outside'), join(x.root, 'graphs/linked'))
    // A symlinked code directory inside a source is not walked.
    x.write('elsewhere/far.mjs', "import { a } from '../core/skills/lib/x.mjs'\n")
    symlinkSync(join(x.root, 'elsewhere'), join(x.root, 'graphs/g/skills/app/linked'))
    assert.deepEqual(checkCatalogDrift({ installationRoot: x.root }), { ok: false, problems: [problem('SOURCE_MISSING', 'ref')] })
  })
})

await test('drift guard: export-from, side-effect imports, .cjs files and library offerings derive edges', async () => {
  const { checkCatalogDrift } = await api()
  await withFixtures(async make => {
    const x = make()
    x.write('graphs/g/skills/app/deep/re.mjs', "export { a } from '../../../../../core/skills/lib/x.mjs'\n")
    x.write('graphs/g/skills/app/side.cjs', "  import '../../../../core/skills/ref/notes.mjs'\n")
    // A library offering's own code is walked too.
    x.write('core/skills/lib/y.js', "import g from '../guide/g.mjs'\n")
    assert.deepEqual(checkCatalogDrift({ installationRoot: x.root }).problems, [
      problem('DEPENDENCY_UNDECLARED', 'app', 'lib'),
      problem('DEPENDENCY_UNDECLARED', 'app', 'ref'),
      problem('DEPENDENCY_UNDECLARED', 'lib', 'guide'),
    ])
  })
})

await test('drift guard: non-edges stay non-edges', async () => {
  const { checkCatalogDrift } = await api()
  await withFixtures(async make => {
    const x = make()
    x.write('graphs/g/skills/app/a.mjs', [
      "import other from '../../../h/skills/tool/t.mjs'", // into graphs/*/skills/*
      "import bare from 'core/skills/lib/x.mjs'", // bare specifier
      "import unknown from '../../../../core/skills/unknown/x.mjs'", // not a catalog id
      "export const s = `import x from '../../../../core/skills/lib/x.mjs'`", // not at a line start
      ''].join('\n'))
    x.write('graphs/g/skills/app/notes.ts', "import x from '../../../../core/skills/lib/x.mjs'\n") // not a code file
    x.write('core/skills/ref/own.mjs', "import y from '../ref/y.mjs'\n") // its own directory
    x.write('core/skills/ref/SKILL.md', '# ref\nSee skills/ref/ and skills/missing/.\n') // itself and an unknown name
    // A role naming its own owner and a non-catalog skill gives nothing.
    x.write('graphs/g/agents/helper.md', '---\nname: helper\ndescription: d\nmodel: sonnet\nskills:\n  - app\n  - elsewhere\n---\nbody\n')
    assert.deepEqual(checkCatalogDrift({ installationRoot: x.root }).problems, [problem('ENTRY_SHA_MISMATCH', 'ref')])
  })
})

await test('drift guard: one problem per pair, against every entry offering of the graph', async () => {
  const { checkCatalogDrift } = await api()
  await withFixtures(async make => {
    const x = make(c => { c.offerings.push(row('tool', 'graphs/g/skills/tool', '# tool\n')) })
    x.write('graphs/g/skills/tool/SKILL.md', '# tool\n')
    x.write('graphs/g/agents/helper.md', '---\nname: helper\ndescription: d\nmodel: sonnet\nskills:\n  - guide\n---\nbody\n')
    x.write('graphs/g/skills/app/m.mjs', "import { a } from '../../../../core/skills/guide/a.mjs'\n")
    x.write('graphs/g/skills/app/n.mjs', "import { b } from '../../../../core/skills/guide/b.mjs'\n")
    assert.deepEqual(checkCatalogDrift({ installationRoot: x.root }).problems, [
      problem('DEPENDENCY_UNDECLARED', 'app', 'guide'),
      problem('DEPENDENCY_UNDECLARED', 'tool', 'guide'),
    ])
  })
})

await test('drift guard: unsafe names are never reported, and null refs sort first', async () => {
  const { checkCatalogDrift } = await api()
  await withFixtures(async make => {
    const x = make()
    mkdirSync(join(x.root, 'graphs/Bad_G/skills/fine'), { recursive: true })
    mkdirSync(join(x.root, 'kit/skills/extra'), { recursive: true })
    mkdirSync(join(x.root, 'core/skills/Upper'), { recursive: true })
    const result = checkCatalogDrift({ installationRoot: x.root })
    assert.deepEqual(result, { ok: false, problems: [
      problem('SOURCE_UNLISTED', null), problem('SOURCE_UNLISTED', null), problem('SOURCE_UNLISTED', 'kit/skills/extra'),
    ] })
    assert.ok(!/Bad_G|Upper/.test(JSON.stringify(result)))
  })
})

await test('drift guard: only graphs/<g>/workflows/<file> rows load their roles', async () => {
  const { checkCatalogDrift } = await api()
  await withFixtures(async make => {
    // No role file named ghost exists; a non-graph workflow never loads it.
    const x = make(c => {
      c.workflows.push({ source: 'tools/flow.js', roles: ['ghost'], nativeReadiness: 'unknown', sha256: sha('flow\n') })
    })
    x.write('tools/flow.js', 'flow\n')
    assert.deepEqual(checkCatalogDrift({ installationRoot: x.root }), { ok: true, problems: [] })
  })
})

const asRoot = process.getuid?.() === 0 ? 'root can list a 000 directory' : false
await test('drift guard: a listing failure other than missing is IO_ERROR with no echo', { skip: asRoot }, async () => {
  const { checkCatalogDrift } = await api()
  await withFixtures(async make => {
    const x = make()
    const sealed = join(x.root, 'graphs/g/skills/app/sealed')
    mkdirSync(sealed)
    chmodSync(sealed, 0o000)
    try {
      assert.throws(() => checkCatalogDrift({ installationRoot: x.root }),
        e => e.code === 'IO_ERROR' && !e.message.includes(x.root) && !e.message.includes('sealed'))
    } finally { chmodSync(sealed, 0o700) }
  })
})
