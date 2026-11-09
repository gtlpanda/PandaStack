// audit-inputs.mjs - what every stage input of the security-audit workflow is built from: the fields they share, the architecture summary and an
// upstream block by reference, and the bound put on text that came from agents reading hostile source. audit-stage.mjs (recon, hunt, critic,
// mint) and audit-verdicts.mjs (consolidate, validate, verify) both build inputs from these, and the run profile's upstream text.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { refuse } from './audit-run.mjs'
import { BlockError, resolve as resolveBlock } from './blocks.mjs'
import { rulesOf } from './audit-profile.mjs'

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v)

export function baseInput(runDir, meta, stage) {
  return { stage, part: stage, tree: join(runDir, 'tree'), maxParallel: meta.limits.max_parallel, execution: { capability: meta.execution_capability, blockers: meta.execution_blockers } }
}
export function architectureOf(runDir) {
  const file = join(runDir, 'architecture.md')
  if (!existsSync(file)) refuse('architecture.md is missing: seed writes it')
  return readFileSync(file, 'utf8')
}
export const blockText = ref => {
  try { return resolveBlock(ref).text } catch (e) { if (e instanceof BlockError) return refuse(`the ledger names a block that does not resolve: ${e.message}`); throw e }
}
// The agents that decide coverage (synthesizer, critic, minter) of a quick or deep run get upstream's profile section verbatim as parts.profile;
// a standard run's inputs have no such key, so its prompts are unchanged.
const PROFILE_SECTION = 'SKILL.md#Run profiles and scope'
export const profilePart = meta => (rulesOf(meta).profile === 'standard' ? {} : { profile: blockText(PROFILE_SECTION) })
// The same agents are also told which profile the run is, so they can tell which bullet of that section applies to them. The critic's input gets it only for quick and deep.
export const profileName = meta => (rulesOf(meta).profile === 'standard' ? {} : { profile: meta.profile })
// Upstream's Phase 5 section: what the verify stage's verifiers follow, and what a quick run's validate stage adds to its one verifier per candidate (Phase 3 and 5 merged).
export const PHASE5 = 'VALIDATION-AND-REPORTING.md#Phase 5: Verify the final records with fresh eyes'

// What the critic and the minter are sent of text that came from agents reading hostile source: a hunter may fill a unit with up to 64 KiB of evidence, so
// long text and long lists are cut here, never passed whole. The cut is visible (a unit says `truncated`, a text ends in an ellipsis).
export const CLIP = { text: 300, list: 20, keys: 20, depth: 4 }
export const clipText = v => (typeof v === 'string' && v.length > CLIP.text ? `${v.slice(0, CLIP.text)}…` : v)
export function clipValue(v, depth = 0) {
  if (typeof v === 'string') return clipText(v)
  if (Array.isArray(v)) return depth >= CLIP.depth ? null : v.slice(0, CLIP.list).map(x => clipValue(x, depth + 1))
  if (isObj(v)) return depth >= CLIP.depth ? null : Object.fromEntries(Object.entries(v).slice(0, CLIP.keys).map(([k, x]) => [clipText(k), clipValue(x, depth + 1)]))
  return v
}
// What a value costs inside a run script: run-script.mjs writes JSON.stringify(JSON.stringify(input)), so a quote costs four bytes and a control character seven.
export const encodedSize = v => JSON.stringify(JSON.stringify(v)).length
