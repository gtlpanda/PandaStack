import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from '../scripts/workflow-harness.mjs'

// Separate static binding check; does not execute retention or a capture owner.
await test('both Bash digest producers hash stdin and preserve failure handling', () => {
  const source = readFileSync(new URL('../core/skills/verify/retention.sh', import.meta.url), 'utf8')
  const producers = [...source.matchAll(/hashline="\$\(([^\n]*?)\)" \|\| fail; read -r hash _ <<<"\$hashline" \|\| fail/g)]
  assert.equal(producers.length, 2)
  assert.deepEqual(producers.map(match => match[1]), ['sha256sum <"$manifest"', 'sha256sum <"$log"'])
})
