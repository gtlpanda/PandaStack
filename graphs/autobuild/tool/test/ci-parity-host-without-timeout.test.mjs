import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PARITY_TESTS = path.join(HERE, "ci-parity.test.mjs");

// Stock macOS has no GNU timeout. The tests that only resolve CI steps call
// resolveCiParity(config) with no pathValue, so they must not depend on the host PATH.
test("resolve-only ci-parity tests pass on a host whose PATH has no timeout", () => {
  const emptyBin = mkdtempSync(path.join(tmpdir(), "no-timeout-bin-"));
  const env = { ...process.env, PATH: emptyBin };
  delete env.NODE_TEST_CONTEXT; // a nested node --test must report to its own process, not to this runner
  const r = spawnSync(process.execPath, [
    "--test", "--test-reporter=tap",
    "--test-name-pattern=^cherry-crm's CI steps resolve exactly",
    "--test-name-pattern=^any CI: declared commands must appear verbatim",
    PARITY_TESTS,
  ], { env, encoding: "utf8", timeout: 120_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /# tests 2\b/, `BUGHUNT-F2 expected both resolve-only tests to run:\n${out}`);
  assert.equal(r.status, 0, `BUGHUNT-F2 resolve-only ci-parity tests fail when timeout is not on PATH (resolveCiParity adds a missing-timeout error to unrelated resolves):\n${out}`);
});
