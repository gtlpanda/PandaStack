#!/usr/bin/env node
// The Codex install targets, read from the offering catalog (CP-01c). An offering is
// planned when installEligible says so; the sources of every offering its planned
// entries depend on, transitively, must be real directories. Reads the catalog and
// lstats dependency sources only: no SKILL.md read, no drift check, no write.
//   node install-plan.mjs --installation-root <absolute path> --backend codex
// prints one "<dest>\t<src>" line per entry; install.sh --codex runs it once.
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fields, exact, fail, ownErrorCode } from './boundary.mjs'
import { safeText } from './catalog-data.mjs'
import { loadOfferingCatalog, installEligible } from './catalog.mjs'

const INPUT = 'INVALID_INSTALL_PLAN_INPUT'
// Every code installPlan can throw. The CLI exits 1 for INPUT and 2 for the rest.
const CODES = [INPUT, 'DEPENDENCY_MISSING', 'NOT_FOUND', 'INVALID_CATALOG', 'IO_ERROR', 'INVALID_CATALOG_INPUT']
const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR'

function planInput(input) {
  const value = fields(input, INPUT)
  exact(value, ['installationRoot', 'backend'], INPUT)
  const root = value.installationRoot
  if (!safeText(root) || Buffer.byteLength(root) > 4096 || !isAbsolute(root)) fail(INPUT)
  if (value.backend !== 'codex') fail(INPUT)
  return { installationRoot: root, backend: value.backend }
}

// Ids reachable through `dependencies` from the planned offerings (not the planned
// offerings themselves, unless one depends on another). The validator already
// rejects cycles and dangling ids; an unknown id is still refused, never skipped.
function dependencyClosure(planned, byId) {
  const seen = new Set()
  const pending = planned.flatMap(offering => offering.dependencies)
  while (pending.length) {
    const id = pending.pop()
    if (seen.has(id)) continue
    const offering = byId.get(id)
    if (!offering) fail('DEPENDENCY_MISSING')
    seen.add(id)
    pending.push(...offering.dependencies)
  }
  return [...seen].sort()
}

// A static check that each dependency source is a directory, not a symlink, file or
// missing path. It is not protection against concurrent replacement.
function requireRealDirectory(canonicalRoot, source) {
  let stat
  try { stat = lstatSync(join(canonicalRoot, source)) } catch (e) {
    fail(missing(e) ? 'DEPENDENCY_MISSING' : 'IO_ERROR')
  }
  if (!stat.isDirectory()) fail('DEPENDENCY_MISSING')
}

function canonicalRootOf(root) {
  try { return realpathSync(root) } catch (e) { fail(missing(e) ? 'NOT_FOUND' : 'IO_ERROR') }
}

const byDest = (a, b) => (a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0)

export function installPlan(input) {
  const { installationRoot, backend } = planInput(input)
  const catalog = loadOfferingCatalog({ installationRoot })
  const planned = catalog.offerings.filter(offering => installEligible(offering, backend))
  const byId = new Map(catalog.offerings.map(offering => [offering.id, offering]))
  const canonicalRoot = canonicalRootOf(installationRoot)
  for (const id of dependencyClosure(planned, byId)) requireRealDirectory(canonicalRoot, byId.get(id).source)
  return planned
    .flatMap(offering => offering.installTargets.map(dest => ({ dest, src: offering.source })))
    .sort(byDest)
}

// ---------------------------------------------------------------- CLI

const FLAGS = new Map([['--installation-root', 'installationRoot'], ['--backend', 'backend']])

// Exactly the two flags, each once, each followed by its value. The values are
// checked by installPlan.
function parseArgs(argv) {
  if (argv.length !== FLAGS.size * 2) fail(INPUT)
  const input = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = FLAGS.get(argv[i])
    if (!key || Object.hasOwn(input, key)) fail(INPUT)
    input[key] = argv[i + 1]
  }
  return input
}

export function installPlanMain(argv, out = process.stdout, err = process.stderr) {
  let entries
  try {
    entries = installPlan(parseArgs(argv))
  } catch (e) {
    const known = ownErrorCode(e)
    const code = CODES.includes(known) ? known : 'IO_ERROR'
    err.write(`install-plan: ${code}\n`)
    return code === INPUT ? 1 : 2
  }
  out.write(entries.map(({ dest, src }) => `${dest}\t${src}\n`).join(''))
  return 0
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

// process.exitCode, not process.exit(): stdout to a pipe may still be flushing.
if (isEntryPoint()) process.exitCode = installPlanMain(process.argv.slice(2))
