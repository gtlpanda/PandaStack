import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'
import { ROOT } from '../scripts/configure-agents.mjs'

// Codex reads AGENTS.md on its own, and the Claude builder prompt reads SPEC.md and
// AGENTS.md, so each file's "Active priority" section must select the same feature
// list that the root autobuild.json builds from. Stale sections once told builders
// that Phase 2 was paused while autobuild.json targeted Phase 2.
export function activePriority(agents) {
  const match = /^# Active priority:[^\n]*\n([\s\S]*?)(?=^# )/m.exec(agents)
  return match ? match[0] : null
}

export function selectedFeatureList(section) {
  const match = /Selected feature list:\s*([^\s(]+)/.exec(section ?? '')
  return match ? match[1] : null
}

// Both files the builder prompt reads carry the section; each must agree.
for (const doc of ['AGENTS.md', 'SPEC.md']) {
  await test(`${doc} active priority selects the feature list autobuild.json builds`, () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'autobuild.json'), 'utf8'))
    const section = activePriority(readFileSync(join(ROOT, doc), 'utf8'))
    assert.ok(section, `${doc} must have a "# Active priority:" section`)
    assert.equal(selectedFeatureList(section), config.featuresFile)
  })
}

await test('the active-priority parser rejects a missing, mismatched or unlabeled selection', () => {
  const doc = list => `# Rules\nx\n\n# Active priority: test\n\n${list}\n\n# Next\ny\n`
  assert.equal(selectedFeatureList(activePriority(doc('Selected feature list: features.json (Phase 2).'))), 'features.json')
  assert.equal(selectedFeatureList(activePriority(doc('Only entries in features-security-audit.json are selected.'))), null)
  assert.equal(selectedFeatureList(activePriority(doc('Selected feature list: features-security-audit.json'))), 'features-security-audit.json')
  assert.equal(activePriority('# Rules\nno priority section\n'), null)
  assert.equal(selectedFeatureList(null), null)
  assert.equal(selectedFeatureList(''), null)
})
