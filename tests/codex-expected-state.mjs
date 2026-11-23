// The expected Codex catalog state, read from tests/fixtures/codex-expected-state.json.
//
// Snapshot tests (cp-01b, cp-01c, cp-01d, cp-03b, cp-04e, install-codex, install-plan,
// host-wiring-proof-ref, ...) used to hold per-offering hardcoded lists. They now derive
// "which rows are codex partial, with which transport and limitations, which install
// lines, which ready set" from this one module, so flipping another row is an edit to the
// fixture and nothing else. The fixture is explicit truth, not a copy taken at test time:
// a test compares the catalog to it exactly. Only values the fixture does not state (a
// row's `source` path, its claude limitations) are read from the catalog.
import { readFileSync } from 'node:fs'

export const STATE = JSON.parse(readFileSync(new URL('./fixtures/codex-expected-state.json', import.meta.url), 'utf8'))

const byDest = (a, b) => (a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0)

export const GRAPH_ROWS = STATE.graphRows
export const SKILL_IDS = STATE.skill.ids
export const SKILL_TRANSPORT = STATE.skill.transport
export const KEEP_NATIVE_UNVERIFIED = STATE.skill.keepNativeUnverified
// Rows that were already codex partial before the codex-parity waves (autobuild, bughunt).
export const PRE_WAVE_IDS = GRAPH_ROWS.filter(r => r.preWave).map(r => r.id)
// Every offering whose codex row is `partial`, sorted. The install set and the ready set.
export const PARTIAL_IDS = [...GRAPH_ROWS.map(r => r.id), ...SKILL_IDS].sort()
export const NON_PRE_WAVE_PARTIAL_IDS = PARTIAL_IDS.filter(id => !PRE_WAVE_IDS.includes(id))

const catalogRow = (catalog, id) => catalog.offerings.find(o => o.id === id)

/** The exact codex provider row the fixture says `id` must have in `catalog`. */
export function expectedCodexRow(catalog, id) {
  const graph = GRAPH_ROWS.find(r => r.id === id)
  if (graph) return { implementation: 'partial', transportId: graph.transportId, limitations: [...graph.limitations] }
  if (SKILL_IDS.includes(id)) {
    // A skill row carries the claude row's limitations, plus NATIVE_UNVERIFIED for the few
    // whose helpers the offline proof (tests/codex-skill-install.test.mjs) does not run.
    const claude = catalogRow(catalog, id).providers.claude.limitations
    return { implementation: 'partial', transportId: SKILL_TRANSPORT.id,
      limitations: [...claude, ...(KEEP_NATIVE_UNVERIFIED.includes(id) ? ['NATIVE_UNVERIFIED'] : [])].sort() }
  }
  return null
}

/** Expected proofRefs of `id`: the fixture's list for a graph row, [] for every other row. */
export const expectedProofRefs = id => GRAPH_ROWS.find(r => r.id === id)?.proofRefs ?? []

/** The expected `{ dest, src }` install plan for the codex backend, sorted by dest. */
export function expectedPlan(catalog, { ids = PARTIAL_IDS } = {}) {
  return ids.map(id => ({ dest: `skills/${id}`, src: catalogRow(catalog, id).source })).sort(byDest)
}

export const planLines = plan => plan.map(e => `${e.dest}\t${e.src}\n`).join('')

/** A codex row that is not installable: the state every flipped row had before its wave. */
export const UNAVAILABLE_CODEX = {
  implementation: 'unavailable', transportId: null,
  limitations: ['NATIVE_UNVERIFIED', 'NO_PROVIDER_TRANSPORT', 'REQUIREMENTS_INCOMPLETE'],
}

/**
 * A copy of `catalog` with every row that the waves flipped (all but the pre-wave
 * autobuild and bughunt) back to unavailable. A library row (no entry skill) keeps
 * LIBRARY_ONLY so the catalog still validates. Fixture roots built on this catalog install
 * the pre-wave two-entry plan, which is what the frozen install tests pin.
 */
export function resetToPreWave(catalog) {
  const copy = structuredClone(catalog)
  for (const id of NON_PRE_WAVE_PARTIAL_IDS) {
    const offering = catalogRow(copy, id)
    offering.providers.codex = { ...UNAVAILABLE_CODEX, limitations: [...UNAVAILABLE_CODEX.limitations] }
    if (!offering.entrySkill) offering.providers.codex.limitations.unshift('LIBRARY_ONLY')
  }
  return copy
}
