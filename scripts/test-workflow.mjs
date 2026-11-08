// test-workflow.mjs — run every graph's workflow tests against scripted agents,
// then check every workflow file loads. Test files: tests/*.test.mjs and
// graphs/<name>/tests/*.test.mjs. Ends with TEST-WORKFLOW: N passed, M failed.
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO, test, load, summary, entryDirs } from './workflow-harness.mjs'

function testFiles() {
  const graphs = existsSync(join(REPO, 'graphs')) ? readdirSync(join(REPO, 'graphs')).map(g => join('graphs', g)) : []
  return ['', ...graphs]
    .map(d => join(REPO, d, 'tests'))
    .filter(d => existsSync(d))
    .flatMap(d => readdirSync(d).filter(f => f.endsWith('.test.mjs')).map(f => join(d, f)))
}

// HARNESS (autobuild build of security-audit PR 9; revert this file with .autobuild/): the acceptance test of a feature
// not built yet (passes !== true in .autobuild/features.json) is skipped here, so scripts/test.sh stays green while the
// loop builds. `autobuild test <ID>` runs those files through .autobuild/run-acceptance.mjs, never through this runner.
// With no .autobuild/features.json (the harness removed) nothing is skipped.
function unbuiltTests() {
  try {
    const doc = JSON.parse(readFileSync(join(REPO, '.autobuild', 'features.json'), 'utf8'))
    return new Set(doc.features.filter(f => f.passes !== true).map(f => join(REPO, f.test)))
  } catch { return new Set() }
}
const unbuilt = unbuiltTests()
const files = testFiles().filter(f => !unbuilt.has(f))
if (unbuilt.size) console.log(`(skipped, feature not built yet: ${[...unbuilt].map(f => f.slice(REPO.length + 1)).join(', ')})`)
await test('at least one workflow test file exists', () => {
  if (!files.length) throw new Error('no tests/*.test.mjs or graphs/*/tests/*.test.mjs found')
})
for (const f of files) {
  // A file that throws outside test() (bad import, load failure) counts as one failure.
  try { await import(pathToFileURL(f).href) }
  catch (e) { await test(`${f.slice(REPO.length + 1)} loads`, () => { throw e }) }
}

console.log('== every workflow file parses')
for (const d of entryDirs('workflows')) {
  for (const f of readdirSync(d).filter(f => f.endsWith('.js'))) {
    await test(`${join(d, f).slice(REPO.length + 1)} parses with a pure-literal meta`, () => { load(join(d, f)) })
  }
}

const { pass, fail } = summary()
console.log(`\nTEST-WORKFLOW: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
