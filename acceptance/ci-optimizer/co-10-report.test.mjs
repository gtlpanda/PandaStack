// CO-10 frozen acceptance: the per-repository report (spec/contracts/ci-optimizer-co-10.md).
// Module cases feed buildReport/renderReport literal inputs; CLI cases run `autobuild ci report` over throwaway
// git repositories with a private AUTOBUILD_STATE_HOME. Offline: nothing here can reach a network.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { ci, git, importFile, makeRepo, PANDASTACK_WORKFLOW, recordedAttempts, runCi, sha256hex, stateHome, tempDir, writeFiles } from './support.mjs'

// ---- helpers ----

const HEADINGS = [
  '# CI performance report', '## Repository', '## CI configuration', '## Measurements',
  '## Baseline and regressions', '## Findings', '## Triggers', '## Unknowns',
]
const TABLE_HEADER = '| Workflow | Runs | Wall p50 | Wall p90 | Queue p50 | Critical path p50 | Efficiency | Runner minutes | Flake rate |'
const EXPLANATION = "Not reported by the CI provider's API; not estimated."

const headings = (md) => md.split('\n').filter((l) => /^#{1,2} /.test(l))
/** Lines of the `## title` section, up to the next `#` or `##` heading (### subsections included). */
function section(md, title) {
  const lines = md.split('\n')
  const start = lines.indexOf(title)
  assert.ok(start >= 0, `heading present: ${title}`)
  const end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l))
  return lines.slice(start + 1, end < 0 ? undefined : end)
}
/** Lines of a `### title` subsection, up to the next heading of any level. */
function subsection(md, title) {
  const lines = md.split('\n')
  const start = lines.indexOf(title)
  assert.ok(start >= 0, `subsection present: ${title}`)
  const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l))
  return lines.slice(start + 1, end < 0 ? undefined : end)
}
const bullets = (lines) => lines.filter((l) => l.startsWith('- '))
const cellsOf = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
const cellHas = (cell, value) => new RegExp(`(^|[^\\d.])${String(value).replace('.', '\\.')}([^\\d]|$)`).test(cell)

const stateFile = (home, root, name) => path.join(home, 'autobuild', 'ci', sha256hex(realpathSync(root)).slice(0, 24), name)

function pandaRepo(t, { config = {}, workflow = PANDASTACK_WORKFLOW, extra = {} } = {}) {
  return makeRepo(t, {
    '.github/workflows/test.yml': workflow,
    'package.json': { name: 'panda-fixture', version: '1.0.0', scripts: { test: 'node --test' } },
    'autobuild.json': config,
    '.gitignore': 'logs/\n',
    ...extra,
  })
}

// ---- module: buildReport ----

const PROFILE = {
  root: '/work/repo',
  languages: [{ name: 'javascript', evidence: ['package.json'] }],
  buildTools: [{ name: 'npm', evidence: ['package.json'] }],
  testFrameworks: [{ name: 'node-test', command: 'node --test', parallel: 'files', evidence: ['package.json'] }],
  ci: { providers: [{ id: 'github', files: ['.github/workflows/test.yml'], status: 'parsed' }], workflows: [], pipelines: [] },
  gate: null,
  unknowns: ['NO_AUTOBUILD_CONFIG', 'CI_CACHE_HIT_RATE', 'MATRIX_EXPRESSION:a.yml#b'],
}
const WORKFLOW_METRICS = {
  workflow: 'test', runs: 36, wallSeconds: { p50: 180, p90: 225, max: 240 }, queueSeconds: { p50: 2, p90: 3 },
  setupSeconds: { p50: 1, p90: 2 }, criticalPathSeconds: { p50: 169, p90: 200 }, criticalPathJobs: ['gate shard 1', 'test'],
  parallelEfficiency: { p50: 0.37 }, runnerMinutes: { total: 312, p50: 9 }, costUsd: null, steps: [],
  reliability: { attempts: 41, success: 36, failure: 4, cancelled: 1, other: 0, rerunAttempts: 1, flakyRuns: 1, flakeRate: 0.03, flakyRunIds: [44929986613] },
}
const NULL_WORKFLOW_METRICS = {
  workflow: 'lint', runs: 0, wallSeconds: { p50: null, p90: null, max: null }, queueSeconds: { p50: null, p90: null },
  setupSeconds: { p50: null, p90: null }, criticalPathSeconds: { p50: null, p90: null }, criticalPathJobs: [],
  parallelEfficiency: { p50: null }, runnerMinutes: { total: 0, p50: null }, costUsd: null, steps: [],
  reliability: { attempts: 0, success: 0, failure: 0, cancelled: 0, other: 0, rerunAttempts: 0, flakyRuns: 0, flakeRate: null, flakyRunIds: [] },
}
const GATE_METRICS = { runs: 2, wallSeconds: { p50: 100, p90: 200 }, cacheHitRate: 0.5, steps: [{ name: 'regressions', samples: 2, seconds: { p50: 60, p90: 120 } }] }
const METRICS = { schemaVersion: 1, workflows: [WORKFLOW_METRICS, NULL_WORKFLOW_METRICS], gate: null, unknowns: ['RUNNER_UTILIZATION', 'CI_CACHE_HIT_RATE', 'NO_HISTORY'] }
const APPLY = {
  rule: 'gate-shard-weights', risk: 'low', action: 'apply', target: 'autobuild.json', job: null,
  summary: 'recalibrate shardWeight so the slowest shard drops', evidence: ['regressions: 6 -> 50'], estimatedSavingSeconds: 5,
}
const LONG = {
  rule: 'long-single-job', risk: 'high', action: 'propose', target: '.github/workflows/slow.yml', job: 'build',
  summary: 'split into 3 shards (estimate)', evidence: [], estimatedSavingSeconds: 933,
}
const NEEDS = {
  rule: 'needs-without-artifacts', risk: 'high', action: 'propose', target: '.github/workflows/slow.yml', job: 'lint',
  summary: 'lint needs build but shares no artifact', evidence: [], estimatedSavingSeconds: null,
}
const BASELINE = { schemaVersion: 1, capturedAt: '2026-11-21T10:00:00Z', head: 'abcdef0123456789abcdef0123456789abcdef01', workflows: [], gate: null, checks: [], testSteps: [], gateSteps: [] }
const REGRESSION = { workflows: [{ workflow: 'test', status: 'regressed', baselineP50: 180, recentP50: 400, deltaPercent: 122.2, overTarget: false, topSteps: [] }], regressed: true }
const TRIGGERS = { fire: true, triggers: [{ id: 'ci-config-changed', detail: 'CI, manifest or autobuild.json changed since 2026-11-20T08:00:00Z' }] }
const VALIDATION = { schemaVersion: 1, fast: { schemaVersion: 1, head: 'a'.repeat(40), dirty: false, tier: 'fast', ok: true, at: '2026-11-22T00:00:00Z', base: null, reasons: [] }, full: null }
const GENERATED_AT = '2026-11-22T12:34:56Z'

async function build(over = {}) {
  const { buildReport, renderReport } = await ci('report')
  const report = buildReport({
    profile: PROFILE, metrics: METRICS, findings: [APPLY, LONG, NEEDS], baseline: BASELINE, regression: REGRESSION,
    triggers: TRIGGERS, validation: VALIDATION, generatedAt: GENERATED_AT, ...over,
  })
  return { report, md: renderReport(report) }
}

test('CO-10 module: buildReport returns the documented JSON shape', async () => {
  const { report } = await build()
  assert.equal(report.schemaVersion, 1, 'CO-10 case 3: schemaVersion')
  assert.equal(report.generatedAt, GENERATED_AT, 'CO-10 case 3: generatedAt is passed through')
  assert.equal(report.repository.root, '/work/repo', 'CO-10 case 3: repository.root')
  for (const key of ['languages', 'testFrameworks', 'providers']) assert.ok(key in report.repository, `CO-10 case 3: repository.${key}`)
  assert.match(JSON.stringify(report.repository.languages), /javascript/, 'CO-10 case 3: repository.languages names javascript')
  assert.match(JSON.stringify(report.repository.testFrameworks), /node-test/, 'CO-10 case 3: repository.testFrameworks names node-test')
  assert.match(JSON.stringify(report.repository.providers), /github/, 'CO-10 case 3: repository.providers names github')
  assert.deepEqual(report.workflows, METRICS.workflows, 'CO-10 case 3: workflows are metrics.workflows')
  assert.equal(report.gate, null, 'CO-10 case 3: gate is metrics.gate')
  assert.deepEqual(report.findings, [APPLY, LONG, NEEDS], 'CO-10 case 3: findings are passed through')
  assert.deepEqual(report.baseline, { capturedAt: BASELINE.capturedAt, head: BASELINE.head }, 'CO-10 case 3: baseline is { capturedAt, head }')
  assert.deepEqual(report.regression, REGRESSION, 'CO-10 case 3: regression is passed through')
  assert.deepEqual(report.triggers, TRIGGERS, 'CO-10 case 3: triggers are passed through')
  assert.deepEqual(report.validation, VALIDATION, 'CO-10 case 3: validation is the validation.json document')
  assert.deepEqual(report.unknowns, ['CI_CACHE_HIT_RATE', 'MATRIX_EXPRESSION:a.yml#b', 'NO_AUTOBUILD_CONFIG', 'NO_HISTORY', 'RUNNER_UTILIZATION'],
    'CO-10 case 3: unknowns are the sorted unique union of profile and metrics unknowns')

  const gated = (await build({ metrics: { ...METRICS, gate: GATE_METRICS } })).report
  assert.deepEqual(gated.gate, GATE_METRICS, 'CO-10 case 3: gate carries metrics.gate when present')
  const bare = (await build({ baseline: null, regression: null, validation: null })).report
  assert.equal(bare.baseline, null, 'CO-10 case 4: no baseline is null')
  assert.equal(bare.regression, null, 'CO-10 case 4: no regression is null')
  assert.equal(bare.validation, null, 'CO-10 case 4: no validation is null')
})

test('CO-10 module: the Markdown has the eight headings in order, each once', async () => {
  const { md } = await build()
  assert.deepEqual(headings(md), HEADINGS, 'CO-10 case 1: eight headings in order, each exactly once')
  const { md: bare } = await build({ metrics: { workflows: [], gate: null, unknowns: ['CI_CACHE_HIT_RATE', 'NO_HISTORY', 'RUNNER_UTILIZATION'] }, findings: [], baseline: null, regression: null, validation: null })
  assert.deepEqual(headings(bare), HEADINGS, 'CO-10 case 4: the headings stay when everything is empty')
})

test('CO-10 module: Measurements has the table, prints null as unknown, and adds a Local gate line only with a gate', async () => {
  const { md } = await build({ metrics: { ...METRICS, gate: GATE_METRICS } })
  const lines = section(md, '## Measurements')
  assert.ok(lines.includes(TABLE_HEADER), `CO-10 case 1: the table header is exact:\n${lines.join('\n')}`)
  const rows = lines.filter((l) => l.startsWith('| ') && l !== TABLE_HEADER && !/^\|[\s:|-]+\|$/.test(l))
  const test_ = rows.map(cellsOf).find((c) => c[0] === 'test')
  const lint = rows.map(cellsOf).find((c) => c[0] === 'lint')
  assert.ok(test_ && lint, `CO-10 case 1: one row per workflow:\n${rows.join('\n')}`)
  assert.equal(test_.length, 9, 'CO-10 case 1: nine columns')
  // Units and rounding of the figures are not specified; each figure must appear in its own cell.
  assert.ok(cellHas(test_[1], 36), 'CO-10 case 1: Runs')
  assert.ok(cellHas(test_[2], 180) && cellHas(test_[3], 225), 'CO-10 case 1: Wall p50 and p90')
  assert.ok(cellHas(test_[4], 2), 'CO-10 case 1: Queue p50')
  assert.ok(cellHas(test_[5], 169), 'CO-10 case 1: Critical path p50')
  assert.ok(cellHas(test_[6], 0.37), 'CO-10 case 1: Efficiency')
  assert.ok(cellHas(test_[7], 312), 'CO-10 case 1: Runner minutes')
  assert.ok(cellHas(test_[8], 0.03), 'CO-10 case 1: Flake rate')
  for (const [i, name] of [[2, 'Wall p50'], [3, 'Wall p90'], [4, 'Queue p50'], [5, 'Critical path p50'], [6, 'Efficiency']]) {
    assert.equal(lint[i], 'unknown', `CO-10 case 1: a null ${name} prints unknown`)
  }
  assert.ok(lines.some((l) => /Local gate/.test(l)), 'CO-10 case 1: a Local gate line follows when gate is present')
  const noGate = await build()
  assert.ok(!noGate.md.includes('Local gate'), 'CO-10 case 1: no Local gate line without a gate')
})

test('CO-10 module: Measurements says "No CI history imported." when there are no workflows', async () => {
  const { md } = await build({ metrics: { workflows: [], gate: null, unknowns: ['CI_CACHE_HIT_RATE', 'NO_HISTORY', 'RUNNER_UTILIZATION'] } })
  assert.ok(section(md, '## Measurements').includes('No CI history imported.'), 'CO-10 case 4: Measurements text')
  assert.ok(!section(md, '## Measurements').includes(TABLE_HEADER), 'CO-10 case 4: no table without workflows')
})

test('CO-10 module: Findings split applied and proposed, with the bullet format and the estimate suffix', async () => {
  const { md } = await build()
  const findings = section(md, '## Findings')
  const iApplied = findings.indexOf('### Auto-applicable (low risk, run `autobuild ci apply`)')
  const iProposed = findings.indexOf('### Proposed for review')
  assert.ok(iApplied >= 0 && iProposed > iApplied, 'CO-10 case 2: Applied subsection comes before Proposed')

  const applied = bullets(subsection(md, '### Auto-applicable (low risk, run `autobuild ci apply`)'))
  const proposed = bullets(subsection(md, '### Proposed for review'))
  assert.equal(applied.length, 1, 'CO-10 case 2: one applied finding')
  assert.ok(applied[0].startsWith('- **gate-shard-weights** (low) autobuild.json: '), `CO-10 case 2: applied bullet format: ${applied[0]}`)
  assert.ok(applied[0].includes('~5s saved (estimate)'), `CO-10 case 2: the saving prints as ~<s>s saved (estimate): ${applied[0]}`)
  assert.equal(proposed.length, 2, 'CO-10 case 1: two proposed findings')
  assert.ok(proposed[0].startsWith('- **long-single-job** (high) .github/workflows/slow.yml#build: '), `CO-10 case 1: proposed bullet with #job: ${proposed[0]}`)
  assert.ok(proposed[0].includes('~933s saved (estimate)'), 'CO-10 case 1: saving suffix on the proposal')
  assert.ok(proposed[1].startsWith('- **needs-without-artifacts** (high) .github/workflows/slow.yml#lint: '), `CO-10 case 1: second proposal: ${proposed[1]}`)
  assert.ok(!/saved/.test(proposed[1]), 'CO-10 case 1: a null saving prints no saving text')
  assert.ok(!applied.join('\n').includes('long-single-job') && !proposed.join('\n').includes('gate-shard-weights'), 'CO-10 case 2: each finding sits in exactly one subsection')
})

test('CO-10 module: an empty findings subsection prints "- none"', async () => {
  const onlyProposals = await build({ findings: [LONG] })
  assert.deepEqual(bullets(subsection(onlyProposals.md, '### Auto-applicable (low risk, run `autobuild ci apply`)')), ['- none'], 'CO-10 case 1: Applied is "- none" with only proposals')
  assert.equal(bullets(subsection(onlyProposals.md, '### Proposed for review')).length, 1, 'CO-10 case 1: the proposal is listed')
  const onlyApplied = await build({ findings: [APPLY] })
  assert.deepEqual(bullets(subsection(onlyApplied.md, '### Proposed for review')), ['- none'], 'CO-10 case 2: Proposed is "- none" with only an applied finding')
  const none = await build({ findings: [] })
  assert.deepEqual(bullets(subsection(none.md, '### Auto-applicable (low risk, run `autobuild ci apply`)')), ['- none'], 'CO-10 case 4: Applied "- none"')
  assert.deepEqual(bullets(subsection(none.md, '### Proposed for review')), ['- none'], 'CO-10 case 4: Proposed "- none"')
})

test('CO-10 module: Baseline and regressions, Triggers and Unknowns sections', async () => {
  const none = await build({ baseline: null, regression: null })
  assert.ok(section(none.md, '## Baseline and regressions').includes('No baseline captured.'), 'CO-10 case 4: Baseline text')
  const withBaseline = await build()
  const baselineText = section(withBaseline.md, '## Baseline and regressions').join('\n')
  assert.ok(!baselineText.includes('No baseline captured.'), 'CO-10 case 1: no "No baseline" text when a baseline exists')
  assert.ok(baselineText.includes(BASELINE.capturedAt), 'CO-10 case 1: the baseline capture time is printed')
  assert.match(baselineText, /test/, 'CO-10 case 1: the regressed workflow is named')
  assert.match(baselineText, /regress/i, 'CO-10 case 1: the regression is described')

  assert.match(section(withBaseline.md, '## Triggers').join('\n'), /ci-config-changed/, 'CO-10 case 1: Triggers lists the fired trigger ids')

  const unknowns = section(withBaseline.md, '## Unknowns')
  for (const code of withBaseline.report.unknowns) assert.ok(unknowns.some((l) => l.includes(code)), `CO-10 case 1: Unknowns lists ${code}`)
  for (const code of ['CI_CACHE_HIT_RATE', 'RUNNER_UTILIZATION']) {
    const i = unknowns.findIndex((l) => l.includes(code))
    assert.ok(i >= 0, `CO-10 case 1: ${code} listed`)
    // The contract gives the sentence but not its layout: the same line or the line right after the code.
    assert.ok(unknowns[i].includes(EXPLANATION) || (unknowns[i + 1] ?? '').includes(EXPLANATION), `CO-10 case 1: ${code} carries the explanation sentence`)
  }
})

test('CO-10 module: the report never prints environment values', async (t) => {
  const patch = { SECRET_TOKEN: 's3cr3t-value', GH_TOKEN: 'ghp_s3cr3t-value' } // allow-secret
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]))
  Object.assign(process.env, patch)
  t.after(() => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
  const { report, md } = await build()
  assert.ok(md.length > 0 && report.schemaVersion === 1, 'CO-10 case 6: report built')
  for (const value of Object.values(patch)) {
    assert.ok(!md.includes(value), 'CO-10 case 6: the Markdown has no environment value')
    assert.ok(!JSON.stringify(report).includes(value), 'CO-10 case 6: the JSON has no environment value')
  }
})

// ---- CLI ----

test('CO-10 case 1: the full report over the PandaStack workflow and the recorded history', async (t) => {
  const home = stateHome(t)
  const repo = pandaRepo(t, { config: { ciOptimizer: { baselineRuns: 50 } } })
  const env = { AUTOBUILD_STATE_HOME: home }
  const imported = runCi(repo, ['history', '--import', importFile(t, recordedAttempts())], env)
  const r = runCi(repo, ['report'], env)

  assert.equal(imported.code, 0, `CO-10 case 1: history import (${imported.stderr})`)
  assert.equal(r.code, 0, `CO-10 case 1: report exits 0 (${r.stderr})`)
  const md = r.stdout
  assert.deepEqual(headings(md), HEADINGS, 'CO-10 case 1: eight headings in order')
  const measurements = section(md, '## Measurements')
  assert.ok(measurements.includes(TABLE_HEADER), 'CO-10 case 1: the measurements table header')
  const row = measurements.filter((l) => l.startsWith('| ')).map(cellsOf).find((c) => c[0] === 'test')
  assert.ok(row, `CO-10 case 1: a Measurements row for test:\n${measurements.join('\n')}`)
  assert.equal(row.length, 9, 'CO-10 case 1: nine columns')
  assert.ok(row.every((c) => c.length > 0), 'CO-10 case 1: no empty cell')
  const proposed = bullets(subsection(md, '### Proposed for review'))
  assert.ok(proposed.some((l) => l.startsWith('- **flaky-reruns** (high) .github/workflows/test.yml')), `CO-10 case 1: flaky-reruns is proposed:\n${proposed.join('\n')}`)
  assert.deepEqual(bullets(subsection(md, '### Auto-applicable (low risk, run `autobuild ci apply`)')), ['- none'], 'CO-10 case 1: nothing is applied automatically')
  const unknowns = section(md, '## Unknowns')
  const i = unknowns.findIndex((l) => l.includes('CI_CACHE_HIT_RATE'))
  assert.ok(i >= 0, 'CO-10 case 1: CI_CACHE_HIT_RATE is listed')
  assert.ok(unknowns[i].includes(EXPLANATION) || (unknowns[i + 1] ?? '').includes(EXPLANATION), 'CO-10 case 1: with the explanation sentence')
})

const TWO_SHARDS = PANDASTACK_WORKFLOW.replace('shard: [1, 2, 3]', 'shard: [1, 2]')
const GATE = [
  { name: 'A', command: 'true', shardWeight: 6 },
  { name: 'B', command: 'true', shardWeight: 1 },
  { name: 'C', command: 'true', shardable: true },
  { name: 'D', command: 'true' },
]
const GATE_RECORD = {
  at: '2026-11-22T10:00:00.000Z', type: 'gate', caller: 'check', feature: null, phase: 'full', scope: 'full', ok: true, wallSeconds: 95,
  steps: [{ name: 'A', ok: true, seconds: 10 }, { name: 'B', ok: true, seconds: 50 }, { name: 'C', ok: true, seconds: 30 }, { name: 'D', ok: true, seconds: 5 }],
  skipped: [], notRun: [],
}

test('CO-10 case 2: a gate plan that improves is listed as applied automatically, with its estimated saving, and the report applies nothing', async (t) => {
  const home = stateHome(t)
  const repo = pandaRepo(t, {
    workflow: TWO_SHARDS,
    config: { gate: GATE },
    extra: { 'logs/gate-timings.jsonl': `${JSON.stringify(GATE_RECORD)}\n` },
  })
  const configBefore = readFileSync(path.join(repo, 'autobuild.json'))
  const env = { AUTOBUILD_STATE_HOME: home }
  const md = runCi(repo, ['report'], env)
  const analyzed = runCi(repo, ['analyze', '--json'], env)
  const json = runCi(repo, ['report', '--json'], env)

  assert.equal(md.code, 0, `CO-10 case 2: report exits 0 (${md.stderr})`)
  const applied = bullets(subsection(md.stdout, '### Auto-applicable (low risk, run `autobuild ci apply`)'))
  assert.equal(applied.length, 1, `CO-10 case 2: one applied finding:\n${applied.join('\n')}`)
  assert.ok(applied[0].startsWith('- **gate-shard-weights** (low) autobuild.json'), `CO-10 case 2: gate-shard-weights is applied: ${applied[0]}`)
  // Worked example of CO-05 case 1: the slowest shard goes from 85 s to 80 s.
  assert.ok(applied[0].includes('~5s saved (estimate)'), `CO-10 case 2: ~<s>s saved (estimate), 85 s to 80 s: ${applied[0]}`)
  assert.ok(!bullets(subsection(md.stdout, '### Proposed for review')).some((l) => l.includes('gate-shard-weights')), 'CO-10 case 2: not repeated under Proposed')
  const finding = analyzed.json().findings.find((f) => f.rule === 'gate-shard-weights')
  assert.ok(finding && finding.action === 'apply' && finding.estimatedSavingSeconds === 5, 'CO-10 case 2: ci analyze agrees (action apply, saving 5)')
  assert.deepEqual(json.json().findings, analyzed.json().findings, 'CO-10 case 2: the JSON report carries the same findings')
  assert.deepEqual(readFileSync(path.join(repo, 'autobuild.json')), configBefore, 'CO-10 case 2: report never writes autobuild.json')
  assert.equal(git(repo, 'status', '--porcelain'), '', 'CO-10 case 2: the repository is untouched')
})

test('CO-10 case 3: --json has schemaVersion 1, the same findings as ci analyze, and sorted unique unknowns', async (t) => {
  const home = stateHome(t)
  const repo = pandaRepo(t, { config: { ciOptimizer: { baselineRuns: 50 } } })
  const env = { AUTOBUILD_STATE_HOME: home }
  const imported = runCi(repo, ['history', '--import', importFile(t, recordedAttempts())], env)
  const analyzed = runCi(repo, ['analyze', '--json'], env)
  const report = runCi(repo, ['report', '--json'], env)

  assert.equal(imported.code, 0, `CO-10 case 3: import (${imported.stderr})`)
  assert.equal(report.code, 0, `CO-10 case 3: report --json exits 0 (${report.stderr})`)
  const doc = report.json()
  assert.equal(doc.schemaVersion, 1, 'CO-10 case 3: schemaVersion')
  assert.ok(Number.isFinite(Date.parse(doc.generatedAt)), 'CO-10 case 3: generatedAt is a timestamp')
  assert.equal(doc.repository.root, realpathSync(repo), 'CO-10 case 3: repository.root is the repository')
  assert.deepEqual(doc.findings, analyzed.json().findings, 'CO-10 case 3: findings deep-equal ci analyze --json')
  assert.ok(doc.findings.some((f) => f.rule === 'flaky-reruns'), 'CO-10 case 3: and they include flaky-reruns')
  assert.ok(doc.workflows.some((w) => w.workflow === 'test'), 'CO-10 case 3: workflows carry the test workflow')
  assert.deepEqual(doc.unknowns, [...new Set(doc.unknowns)].sort(), 'CO-10 case 3: unknowns are sorted and unique')
  for (const code of ['CI_CACHE_HIT_RATE', 'RUNNER_UTILIZATION']) assert.ok(doc.unknowns.includes(code), `CO-10 case 3: unknowns include ${code}`)
  assert.equal(doc.baseline, null, 'CO-10 case 3: no baseline yet')
  assert.equal(doc.regression, null, 'CO-10 case 3: no regression without a baseline')
  assert.equal(doc.validation, null, 'CO-10 case 3: no validation.json yet')
  assert.ok('triggers' in doc, 'CO-10 case 3: triggers are evaluated')
  assert.equal(report.stdout.trim().split('\n').length >= 1, true, 'CO-10 case 3: stdout carries the JSON document (parsed above)')
})

test('CO-10 case 3: a stored baseline and validation.json appear in the report', async (t) => {
  const home = stateHome(t)
  const repo = pandaRepo(t, { config: { ciOptimizer: { baselineRuns: 50 } } })
  const env = { AUTOBUILD_STATE_HOME: home }
  const imported = runCi(repo, ['history', '--import', importFile(t, recordedAttempts())], env)
  const captured = runCi(repo, ['baseline', '--capture'], env)
  const validationFile = stateFile(home, repo, 'validation.json')
  mkdirSync(path.dirname(validationFile), { recursive: true })
  writeFileSync(validationFile, JSON.stringify(VALIDATION))
  const json = runCi(repo, ['report', '--json'], env)
  const md = runCi(repo, ['report'], env)

  assert.equal(imported.code, 0, `CO-10 case 3: import (${imported.stderr})`)
  assert.equal(captured.code, 0, `CO-10 case 3: capture (${captured.stderr})`)
  assert.equal(json.code, 0, `CO-10 case 3: report (${json.stderr})`)
  const stored = JSON.parse(readFileSync(stateFile(home, repo, 'baseline.json'), 'utf8'))
  const doc = json.json()
  assert.deepEqual(doc.baseline, { capturedAt: stored.capturedAt, head: stored.head }, 'CO-10 case 3: baseline is { capturedAt, head }')
  assert.ok(doc.regression && typeof doc.regression.regressed === 'boolean', 'CO-10 case 3: regression comes from the stored baseline')
  assert.deepEqual(doc.validation, VALIDATION, 'CO-10 case 3: validation is the validation.json document')
  const baselineText = section(md.stdout, '## Baseline and regressions').join('\n')
  assert.ok(!baselineText.includes('No baseline captured.'), 'CO-10 case 3: Markdown no longer says "No baseline captured."')
  assert.ok(baselineText.includes(stored.capturedAt), 'CO-10 case 3: Markdown prints the capture time')
})

test('CO-10 case 4: with no history and no baseline the report still renders, exit 0', async (t) => {
  const home = stateHome(t)
  const repo = makeRepo(t, { '.github/workflows/test.yml': PANDASTACK_WORKFLOW })
  const env = { AUTOBUILD_STATE_HOME: home }
  const md = runCi(repo, ['report'], env)
  const json = runCi(repo, ['report', '--json'], env)

  assert.equal(md.code, 0, `CO-10 case 4: exit 0 (${md.stderr})`)
  assert.deepEqual(headings(md.stdout), HEADINGS, 'CO-10 case 4: all eight headings')
  assert.ok(section(md.stdout, '## Measurements').includes('No CI history imported.'), 'CO-10 case 4: Measurements text')
  assert.ok(section(md.stdout, '## Baseline and regressions').includes('No baseline captured.'), 'CO-10 case 4: Baseline text')
  assert.ok(section(md.stdout, '## Unknowns').join('\n').includes('NO_AUTOBUILD_CONFIG'), 'CO-10 case 4: the profile-only unknown is listed (no autobuild.json)')
  assert.equal(json.code, 0, `CO-10 case 4: --json exit 0 (${json.stderr})`)
  const doc = json.json()
  assert.deepEqual(doc.workflows, [], 'CO-10 case 4: no workflows')
  assert.equal(doc.baseline, null, 'CO-10 case 4: baseline null')
  assert.equal(doc.regression, null, 'CO-10 case 4: regression null')
  assert.equal(doc.gate, null, 'CO-10 case 4: gate null')
  assert.ok(Array.isArray(doc.findings), 'CO-10 case 4: findings is an array')
  assert.ok(doc.unknowns.includes('CI_CACHE_HIT_RATE'), 'CO-10 case 4: unknowns')
})

test('CO-10 case 4: outside a git repository the report exits 2', async (t) => {
  const home = stateHome(t)
  const dir = tempDir(t, 'ci-opt-nogit-')
  const r = runCi(dir, ['report'], { AUTOBUILD_STATE_HOME: home, GIT_CEILING_DIRECTORIES: path.dirname(dir) })
  assert.equal(r.code, 2, 'CO-10 case 4: exit 2 outside a git repository')
  assert.match(r.stderr, /autobuild ci: not in a git repository/, 'CO-10 case 4: the common-rule message')
})

test('CO-10 case 5: --out writes the chosen format to a file outside .git, mode 0644', async (t) => {
  const home = stateHome(t)
  const repo = pandaRepo(t)
  const outside = path.join(tempDir(t, 'ci-opt-out-'), 'report.md')
  const outsideJson = path.join(path.dirname(outside), 'report.json')
  const env = { AUTOBUILD_STATE_HOME: home }
  const absolute = runCi(repo, ['report', '--out', outside], env)
  const relative = runCi(repo, ['report', '--out', 'report.md'], env)
  const asJson = runCi(repo, ['report', '--json', '--out', outsideJson], env)

  assert.equal(absolute.code, 0, `CO-10 case 5: --out exits 0 (${absolute.stderr})`)
  assert.equal(absolute.stdout.trim(), `report: wrote ${outside}`, 'CO-10 case 5: the confirmation line')
  assert.deepEqual(headings(readFileSync(outside, 'utf8')), HEADINGS, 'CO-10 case 5: the file holds the Markdown report')
  assert.equal(statSync(outside).mode & 0o777, 0o644, 'CO-10 case 5: mode 0644')
  assert.equal(relative.code, 0, `CO-10 case 5: a relative path inside the repository (outside .git) is allowed (${relative.stderr})`)
  assert.ok(relative.stdout.includes('report: wrote report.md'), 'CO-10 case 5: the line names the file as given')
  assert.deepEqual(headings(readFileSync(path.join(repo, 'report.md'), 'utf8')), HEADINGS, 'CO-10 case 5: relative file content')
  // With --json the contract's "exactly one JSON document on stdout" and "prints report: wrote" collide; only the file is pinned.
  assert.equal(asJson.code, 0, `CO-10 case 5: --json --out exits 0 (${asJson.stderr})`)
  assert.equal(JSON.parse(readFileSync(outsideJson, 'utf8')).schemaVersion, 1, 'CO-10 case 5: --json --out writes the JSON report')
})

test('CO-10 case 5: --out refuses .git, symbolic links and directories with OUT_UNSAFE and writes nothing', async (t) => {
  const home = stateHome(t)
  const repo = pandaRepo(t, { extra: { 'sub/keep.txt': 'x\n' } })
  const scratch = tempDir(t, 'ci-opt-unsafe-')
  const target = path.join(scratch, 'target.txt')
  writeFileSync(target, 'precious\n')
  symlinkSync(target, path.join(repo, 'link.md'))
  const dangling = path.join(scratch, 'never-created.txt')
  symlinkSync(dangling, path.join(repo, 'dangling.md'))
  mkdirSync(path.join(repo, 'outdir'))
  const env = { AUTOBUILD_STATE_HOME: home }
  const ok = runCi(repo, ['report', '--out', path.join(scratch, 'fine.md')], env)
  assert.equal(ok.code, 0, `CO-10 case 5: a safe --out works (${ok.stderr})`)

  const refused = [
    ['.git/report.md', path.join(repo, '.git', 'report.md')],
    ['sub/../.git/report.md', path.join(repo, '.git', 'report.md')],
    [path.join(repo, '.git', 'hooks', 'report.md'), path.join(repo, '.git', 'hooks', 'report.md')],
    ['link.md', null],
    ['dangling.md', dangling],
    ['outdir', null],
  ]
  for (const [arg, wouldCreate] of refused) {
    const r = runCi(repo, ['report', '--out', arg], env)
    assert.equal(r.code, 2, `CO-10 case 5: --out ${arg} exits 2 (stderr: ${r.stderr})`)
    assert.match(r.stderr, /autobuild ci: OUT_UNSAFE:/, `CO-10 case 5: --out ${arg} names OUT_UNSAFE`)
    if (wouldCreate) assert.ok(!existsSync(wouldCreate), `CO-10 case 5: --out ${arg} wrote nothing`)
  }
  assert.equal(readFileSync(target, 'utf8'), 'precious\n', 'CO-10 case 5: nothing was written through the symbolic link')
  assert.ok(!existsSync(path.join(repo, '.git', 'report.md')), 'CO-10 case 5: .git holds no report')
  assert.equal(git(repo, 'status', '--porcelain').split('\n').filter((l) => /report|outdir/.test(l)).length, 0, 'CO-10 case 5: the repository gained no report file')

  const asJson = runCi(repo, ['report', '--json', '--out', '.git/report.json'], env)
  assert.equal(asJson.code, 2, 'CO-10 case 5: --json keeps exit 2')
  assert.equal(asJson.json().error, 'OUT_UNSAFE', 'CO-10 case 5: --json prints {"error":"OUT_UNSAFE",...} on stdout')
})

test('CO-10 case 6: an environment secret never reaches the Markdown, the JSON or an --out file', async (t) => {
  const home = stateHome(t)
  const repo = pandaRepo(t, { config: { ciOptimizer: { baselineRuns: 50 } } })
  const out = path.join(tempDir(t, 'ci-opt-secret-'), 'report.md')
  const env = { AUTOBUILD_STATE_HOME: home, SECRET_TOKEN: 's3cr3t-value', GH_TOKEN: 'ghp_s3cr3t-value' } // allow-secret
  const imported = runCi(repo, ['history', '--import', importFile(t, recordedAttempts())], env)
  const md = runCi(repo, ['report'], env)
  const json = runCi(repo, ['report', '--json'], env)
  const written = runCi(repo, ['report', '--out', out], env)

  assert.equal(imported.code, 0, `CO-10 case 6: import (${imported.stderr})`)
  assert.equal(md.code, 0, `CO-10 case 6: report (${md.stderr})`)
  assert.deepEqual(headings(md.stdout), HEADINGS, 'CO-10 case 6: the report rendered')
  assert.equal(written.code, 0, `CO-10 case 6: --out (${written.stderr})`)
  for (const [label, text] of [['Markdown', md.stdout], ['JSON', json.stdout], ['--out file', readFileSync(out, 'utf8')], ['stderr', md.stderr + json.stderr + written.stderr]]) {
    for (const secret of ['s3cr3t-value', env.AUTOBUILD_STATE_HOME]) {
      assert.ok(!text.includes(secret), `CO-10 case 6: the ${label} does not contain an environment value (${secret.slice(0, 6)}...)`)
    }
  }
})
