// profile-e2e-support.mjs - the scripted agents of the profile end-to-end tests: the toy audit's answers (toy-agents.mjs) with the recon and mint answers shaped for the profile
// (quick: every unit under upstream's one subsystem reference; deep: one more unit, split off by a lifecycle mode). Everything else a scripted agent says is toy-agents.mjs's, so the
// same planted weaknesses are found and the same claim is rejected. Not a test file.
import { UNITS, answer as toyAnswer } from './toy-agents.mjs'
import { SYNTH } from './stage-fixtures.mjs'
import { QUICK_REF } from './profile-support.mjs'

const ARCH = 'A notes API: one HTTP server dispatches by URL prefix to a notes handler and a file handler, with a CORS wrapper and a config module.'
const coarse = u => ({ ...u, canonical_refs: { ...u.canonical_refs, subsystem: QUICK_REF }, subsystem: 'All in-scope subsystems' })
export const QUICK_UNITS = UNITS.map(coarse)
// The two gaps the toy critic and the toy hunter find (toy-agents.mjs ROUTING, CALLER), minted under the quick reference.
const gapUnit = (surface, boundary, label, path) => coarse({ ...UNITS[0], canonical_refs: { surface, boundary, subsystem: 'x', attack_class: 'ATTACK-CLASSES.md#Access control' }, surface: label, boundary: 'the handlers', starting_paths: [path], priority_class: 2 })
export const QUICK_MINTED = [gapUnit('src/server.js#server', 'src/routes/notes.js#handleNotes', 'URL prefix routing', 'src/server.js'), gapUnit('src/auth.js#currentUser', 'src/routes/notes.js#handleNotes', 'caller identity', 'src/auth.js')]

export function quickAnswer(label, ctx) {
  if (label === 'synth-recon') return SYNTH({ architecture_md: ARCH, units: QUICK_UNITS })
  if (/^synth-mintf?\d+$/.test(label)) return { units: ctx.input.proposals.map((p, i) => QUICK_MINTED[i]) }
  return toyAnswer(label, ctx)
}

// Deep's recon: the toy's four units and one more, the notes handler's delete path, which the notes unit does not cover (a lifecycle mode of the same subsystem and boundary).
export const DEEP_UNITS = [...UNITS, { ...UNITS[0], canonical_refs: { ...UNITS[0].canonical_refs, lifecycle: 'delete' }, lifecycle: 'delete', surface: 'DELETE /notes/:id' }]
export function deepAnswer(label, ctx) {
  if (label === 'synth-recon') return SYNTH({ architecture_md: ARCH, units: DEEP_UNITS })
  return toyAnswer(label, ctx)
}
