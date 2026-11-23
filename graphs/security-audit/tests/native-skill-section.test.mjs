// SKILL.md's Codex runner section: present once, in the house wording, naming a command that exists and parses, and not visible to the Claude drift test.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '../../../scripts/workflow-harness.mjs'
import { skillText } from './skill-commands.mjs'
import { parseNativeArgs } from '../skills/security-audit/audit-native.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

await test('SKILL.md has one Codex runner section, in the house wording, before section 1, naming a command that exists and parses', () => {
  const text = skillText()
  const at = [...text.matchAll(/^## Codex runner$/gm)]
  assert.equal(at.length, 1)
  const body = text.slice(at[0].index, text.indexOf('\n## 1. ', at[0].index))
  assert.ok(body.length > 200 && at[0].index < text.indexOf('\n## 1. '))
  assert.match(body, /^## Codex runner\n\nIf you are running in Codex, use the Codex runner section; in Claude Code, use the sections below\./)
  assert.ok(existsSync(join(HERE, '..', 'skills', 'security-audit', 'audit-native.mjs')))
  // The commands it shows parse (the placeholders stand for real values).
  assert.doesNotThrow(() => parseNativeArgs(['run', '/repo', '--full', '--budget', '40', '--max-budget', '80', '--profile', 'quick', '--scope', 'src']))
  assert.doesNotThrow(() => parseNativeArgs(['resume', '/run', '--grant', '60']))
  assert.ok(!/node "\$AUDIT\/audit-native/.test(text), 'the Claude drift test must not be asked to run the native entry')
  assert.match(body, /no Claude dependency or fallback/i)
  assert.match(body, /recorded, not gated: a release outside the pinned list/, 'the version pin is a record: an unlisted release is not refused')
  assert.ok(!/unpinned Codex version runs only/i.test(body))
})
