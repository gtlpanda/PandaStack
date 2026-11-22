// workflow-file-runner.mjs — runs ONE workflow test file in its own process for
// scripts/workflow-pool.mjs. Usage: node scripts/workflow-file-runner.mjs <absolute test file>
//
// The totals are written to fd 3 (a pipe the pool opens) when the process exits, not
// after the import returns: a few test files start async tests without awaiting them,
// and those finish before exit. Writing to fd 3 keeps the counts apart from anything a
// test prints on stdout. Exit code 0 means the file loaded and every test settled;
// the pool reads the counts, not the exit code, to decide pass or fail.
import { writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { REPO, test, summary } from './workflow-harness.mjs'

const file = process.argv[2]
process.on('exit', () => {
  try { writeSync(3, JSON.stringify(summary())) } catch { /* no fd 3: run by hand; nothing to report to */ }
})
if (typeof file !== 'string' || !file) {
  console.log('usage: node scripts/workflow-file-runner.mjs <absolute test file>')
  process.exitCode = 2
} else {
  // A file that throws outside test() counts as one failure, named as the serial runner names it.
  try { await import(pathToFileURL(file).href) }
  catch (e) { await test(`${file.startsWith(REPO + '/') ? file.slice(REPO.length + 1) : file} loads`, () => { throw e }) }
}
