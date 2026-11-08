// run-acceptance.mjs - the runner behind `autobuild test <ID>` (autobuild.json "runners"): imports the given acceptance test files
// the way scripts/test-workflow.mjs does, in this one process, and exits non-zero when any test fails, when a file cannot be loaded,
// or when nothing ran. A test file run alone with `node file` exits 0 even when its tests fail, because the harness's test() catches.
//   node .autobuild/run-acceptance.mjs graphs/security-audit/tests/profile-rules.test.mjs [more files]
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO, summary, test } from '../scripts/workflow-harness.mjs'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node .autobuild/run-acceptance.mjs <test file> [<test file>...]')
  process.exit(2)
}
for (const file of files) {
  // A file that throws outside test() (a bad import, a failed load) is one failure, with the reason.
  try { await import(pathToFileURL(resolve(REPO, file)).href) } catch (e) { await test(`${file} loads`, () => { throw e }) }
}
const { pass, fail } = summary()
console.log(`\nACCEPTANCE: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 && pass > 0 ? 0 : 1)
