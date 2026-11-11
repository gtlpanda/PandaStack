import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from '../scripts/workflow-harness.mjs'

// Static call-site checks complement the frozen finite-stdin acceptance. Never
// source the owner, execute extracted text, or exercise a capture lifecycle here.
const source = readFileSync(new URL('../core/skills/verify/capture-owner.sh', import.meta.url), 'utf8')
const root = source.slice(source.indexOf('co_root() {'), source.indexOf('co_main() {'))
const lines = root.split('\n')
function decisions() {
  const sites = lines.flatMap((line, index) =>
    line.includes('-u "$STOP_FD"') && line.includes('message') ? [{ line: line.trim(), index }] : [])
  assert.equal(sites.length, 4, 'bind all four control-read decisions')
  return sites
}

await test('control decisions clear prior message bytes immediately before every read', () => {
  for (const { index } of decisions()) {
    assert.equal(lines[index - 1].trim(), "message=''", `reset before source line ${index + 1}`)
  }
})

await test('control decisions observe NUL delimiters and failed reads with partial bytes', () => {
  for (const { line } of decisions()) {
    assert.match(line, /^if IFS= read -r -d '' -t 0\.(?:01|02|05) -u "\$STOP_FD" -n 16 message \|\| \[\[ \$message \]\]; then co_stop_local [a-z-]+; return 125; fi$/)
  }
})

await test('control decisions retain each deadline, character bound and failure reason', () => {
  const expected = [
    ['0.02', 'stop-before-grant'],
    ['0.01', 'stop-before-grant'],
    ['0.05', 'stop-request'],
    ['0.02', 'stop-during-join'],
  ]
  decisions().forEach(({ line }, index) => {
    const [timeout, reason] = expected[index]
    assert.ok(line.includes(`-t ${timeout} -u "$STOP_FD" -n 16 message`))
    assert.ok(line.includes(`co_stop_local ${reason}; return 125;`))
  })
  // Failure is already latched at these drains; they are outside P2-12 scope.
  const drains = source.split('\n').filter(line => line.includes('-u "$STOP_FD" -n 16 _'))
  assert.equal(drains.length, 2)
  for (const line of drains) assert.ok(line.includes('IFS= read -r -t 0.05 -u "$STOP_FD" -n 16 _ || :'))
})
