// audit-facts-bytes.test.mjs - the per-researcher cap in audit-facts.mjs protects a script size in UTF-8 bytes, so it must bound bytes, not UTF-16 units.
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test, summary } from '../../../scripts/workflow-harness.mjs'
import { FACT_LIMITS, RECON_IDS, checkFacts } from '../skills/security-audit/audit-facts.mjs'

const tree = join(realpathSync(mkdtempSync(join(tmpdir(), 'audit-facts-bytes-'))), 'tree')
mkdirSync(join(tree, 'src'), { recursive: true })
writeFileSync(join(tree, 'src', 'app.js'), 'export const a = 1\n')

await test('BUGHUNT-F2 the per-researcher cap bounds the UTF-8 bytes the run script holds, for multi-byte text', () => {
  // Facts reach run.js as JSON.stringify(JSON.stringify(facts)) written as UTF-8: a CJK character is 3 bytes there but 1 UTF-16 unit.
  const cjk = '漢'.repeat(FACT_LIMITS.itemChars)
  const worst = id => ({ agent: id, items: Array.from({ length: 200 }, () => ({ text: cjk, refs: ['src/app.js:1'] })), limits: [] })
  const { facts } = checkFacts(tree, RECON_IDS.map(worst))
  for (const f of facts) {
    const bytes = Buffer.byteLength(JSON.stringify(JSON.stringify({ agent: f.agent, items: f.items, limits: f.limits })), 'utf8')
    assert.ok(bytes <= FACT_LIMITS.agentBytes, `BUGHUNT-F2 researcher ${f.agent} was admitted ${f.items.length} items that take ${bytes} UTF-8 bytes in the run script, over the ${FACT_LIMITS.agentBytes}-byte cap`)
  }
})
if (summary().fail > 0) process.exitCode = 1
