// toy-agents.mjs - the scripted agents of the toy-app audit: what each agent of the graph answers, by the label of its call, for the planted weaknesses of toy-app.mjs. A wrong
// answer for a stage is refused by the helpers, so a run could not get past it. Shared by the end-to-end test and the budget tests. Not a test file.
import { candidateOf, checkOf, hunterResult, hunterUnit, needsValidationRecord, rejectedRecord } from './ledger-fixtures.mjs'
import { RESEARCH, SYNTH, UNIT } from './stage-fixtures.mjs'
import { PLANTED, lineOf } from './toy-app.mjs'

export const NOTES = 'src/routes/notes.js', FILES = 'src/routes/files.js', CONFIG = 'src/config.js', CORS = 'src/cors.js'
// The coverage units the synthesizer proposes: source-derived refs, each in the files it names. notes and files share a subsystem, so one hunter owns both.
const unit = (name, over) => UNIT(name, over)
export const UNITS = [
  unit('notes', { canonical_refs: { surface: `${NOTES}#handleNotes`, boundary: 'src/db.js#notes', subsystem: 'src/routes', attack_class: 'ATTACK-CLASSES.md#Access control' }, surface: 'GET /notes/:id', boundary: 'the notes store', subsystem: 'routes', attack_class: 'Access control', starting_paths: [NOTES], ordinary_attack_class_block: 'ATTACK-CLASSES.md#Access control', priority_class: 1 }),
  unit('files', { canonical_refs: { surface: `${FILES}#handleFiles`, boundary: `${FILES}#ROOT`, subsystem: 'src/routes', attack_class: 'ATTACK-CLASSES.md#Resource and file handling' }, surface: 'GET /files?name=', boundary: 'the uploads directory', subsystem: 'routes', attack_class: 'Resource and file handling', starting_paths: [FILES], ordinary_attack_class_block: 'ATTACK-CLASSES.md#Resource and file handling', priority_class: 1 }),
  unit('config', { canonical_refs: { surface: `${CONFIG}#SERVICE_API_KEY`, boundary: `${CONFIG}#config`, subsystem: 'src/config', attack_class: 'ATTACK-CLASSES.md#Cryptography and secrets' }, surface: 'the service key constant', boundary: 'the config object', subsystem: 'config', attack_class: 'Cryptography and secrets', starting_paths: [CONFIG], ordinary_attack_class_block: 'ATTACK-CLASSES.md#Cryptography and secrets', priority_class: 2 }),
  unit('cors', { canonical_refs: { surface: `${CORS}#withCors`, boundary: 'src/server.js#server', subsystem: 'src/cors', attack_class: 'ATTACK-CLASSES.md#Feature abuse and data leakage' }, surface: 'the CORS headers', boundary: 'the HTTP server', subsystem: 'cors', attack_class: 'Feature abuse and data leakage', starting_paths: [CORS], ordinary_attack_class_block: 'ATTACK-CLASSES.md#Feature abuse and data leakage', priority_class: 2 }),
]
const ROUTING = { surface: 'request routing by URL prefix', boundary: 'src/server.js#server', subsystem: 'src/server', attack_class: 'Access control', starting_paths: ['src/server.js'], selected_companion_blocks: [], excluded_blocks: [], reason: 'no unit owns the dispatcher that decides which handler, and so which checks, run' }
const CALLER = { surface: 'who the caller is', boundary: 'src/auth.js#currentUser', subsystem: 'src/auth', attack_class: 'Access control', starting_paths: ['src/auth.js'], selected_companion_blocks: [], excluded_blocks: [], reason: 'the caller identity is a header nobody verifies' }
const MINTED = [
  { ...UNITS[0], canonical_refs: { surface: 'src/server.js#server', boundary: 'src/routes/notes.js#handleNotes', subsystem: 'src/server', attack_class: 'ATTACK-CLASSES.md#Access control' }, surface: 'URL prefix routing', boundary: 'the handlers', subsystem: 'server', starting_paths: ['src/server.js'], priority_class: 2 },
  { ...UNITS[0], canonical_refs: { surface: 'src/auth.js#currentUser', boundary: 'src/routes/notes.js#handleNotes', subsystem: 'src/auth', attack_class: 'ATTACK-CLASSES.md#Access control' }, surface: 'caller identity', boundary: 'the handlers', subsystem: 'auth', starting_paths: ['src/auth.js'], priority_class: 2 },
]

const FP = Object.keys(PLANTED)
const trace = fp => [
  { kind: 'entrypoint', file: PLANTED[fp].file, line: 1, scope: 'module', description: 'The module the request reaches.' },
  { kind: 'sink', file: PLANTED[fp].file, line: PLANTED[fp].line, scope: 'handler', description: PLANTED[fp].title },
]
const evidenceOf = fp => [{ file: PLANTED[fp].file, line: PLANTED[fp].line, description: 'The line the weakness is on.' }]
const candidate = fp => candidateOf(fp, { title: PLANTED[fp].title, description: `${PLANTED[fp].title}.`, claimed_root_cause: `${fp} is as the source shows.`, trace: trace(fp), evidence: evidenceOf(fp), blockers: ['No sandbox exists to run the service.'], validation_plan: { local: 'Run the handler against a local fixture as a second user.' } })
const record = fp => ({ ...needsValidationRecord(fp, PLANTED[fp].file), title: PLANTED[fp].title, description: `${PLANTED[fp].title}.`, claimed_root_cause: `${fp} is as the source shows.`, trace: trace(fp), evidence: evidenceOf(fp) })
const FOUND = { [`${NOTES}`]: 'notes-byid-no-owner-check', [`${FILES}`]: 'files-name-unchecked-path-join', [`${CONFIG}`]: 'config-service-key-literal', [`${CORS}`]: 'cors-origin-reflected-with-credentials' }
export const REJECTED = 'config-service-key-literal'   // the verifier finds the string is a placeholder: a rejected record

// What each scripted agent returns, by the label of its call. A wrong answer for a stage is refused by the helpers, so the run could not get past it.
export function answer(label, { stage, input }) {
  if (stage === 'recon' && input.part === 'facts') return RESEARCH(label.replace('recon-', ''), { items: [{ text: `fact ${label}`, refs: [`${NOTES}:${lineOf(NOTES, 'handleNotes')}`, `${CORS}:${lineOf(CORS, 'withCors')}`] }] })
  if (label === 'synth-recon') return SYNTH({ architecture_md: 'A notes API: one HTTP server dispatches by URL prefix to a notes handler and a file handler, with a CORS wrapper and a config module.', units: UNITS })
  if (/^h\d+-\d+$/.test(label)) {
    const hunter = input.hunters.find(h => h.agent_id === label)
    const results = hunter.units.map(u => {
      const path = u.starting_paths
      const fp = FOUND[path[0]]
      const gap = path[0] === FILES ? [CALLER] : []
      return { u, fp, gap, check: checkOf(label, path) }
    })
    const found = results.filter(r => r.fp)
    return hunterResult(results.map(({ u, fp, check }) => hunterUnit(u.coverage_id, label, { reviewed_paths: u.starting_paths, checks: [check], ...(fp && { disposition: 'candidate', candidate_fingerprints: [fp] }) })), {
      candidates: found.map(r => candidate(r.fp)), uncovered: results.flatMap(r => r.gap), hardening: found.some(r => r.fp === FOUND[NOTES]) ? ['no rate limit on /notes'] : [],
    })
  }
  if (/^c1$/.test(label)) return { missing_units: [ROUTING], reassign_ids: [], resolved_prior_leads: [], stop: false }
  if (/^c\d+$|^cf\d+$/.test(label)) return { missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: true }
  if (/^synth-mintf?\d+$/.test(label)) return { units: input.proposals.map((p, i) => MINTED[i]).slice(0, input.proposals.length) }
  if (label === 'synth-cons') return { groups: input.candidates.map(c => ({ keep: c.fingerprint, merge: [], reason: '' })) }
  if (/^v\d+/.test(label)) {
    const c = input.candidates.find(x => x.agent_id === label)
    return c.fingerprint === REJECTED ? { decision: 'rejected', record: { ...rejectedRecord(c.fingerprint, PLANTED[c.fingerprint].file), trace: trace(c.fingerprint), evidence: evidenceOf(c.fingerprint), reason: 'The string is a placeholder: DUMMY and EXAMPLE are in it, and nothing reads it for a real service.' } } : { decision: 'needs_validation', record: record(c.fingerprint) }
  }
  if (/^r\d+/.test(label)) { const item = input.items.find(x => x.agent_id === label); return { decision: 'verified', fingerprint: item.fingerprint } }
  throw new Error(`no scripted answer for ${label} (${stage})`)
}

