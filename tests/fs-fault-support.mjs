// fs-fault-support.mjs — deterministic filesystem fault injection for store tests.
// Not a test file (no .test.mjs suffix), so scripts/test-workflow.mjs never runs it.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

// Runs work() with fs.lstatSync wrapped: override(path, realLstat) returns stats to
// report, or undefined for the real answer. syncBuiltinESMExports() makes modules
// that imported `lstatSync` by name see the wrapper too. Restored afterwards.
export function withLstat(override, work) {
  const real = fs.lstatSync
  fs.lstatSync = (path, ...rest) => override(String(path), p => real(p, ...rest)) ?? real(path, ...rest)
  syncBuiltinESMExports()
  try { return work() } finally { fs.lstatSync = real; syncBuiltinESMExports() }
}

// A copy of a stats object with a different link count, e.g. 0 for a file seen mid-unlink.
export function withLinkCount(stats, nlink) {
  return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { nlink })
}
