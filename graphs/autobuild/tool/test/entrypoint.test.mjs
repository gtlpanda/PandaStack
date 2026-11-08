// The CLI must run main() when it is the entry script, even when the kit path has a space in it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { copyKit } from "../test-fixtures/project.mjs";

/** The kit (with the PandaStack modules it imports) under a path with a space. */
const spacedKit = (base) => copyKit(path.join(base, "Jane Doe", "PandaStack"));

test("cli runs main() when the kit path contains a space", () => {
  const base = mkdtempSync(path.join(tmpdir(), "autobuild-entry-"));
  try {
    const spaced = spacedKit(base);
    const result = spawnSync(process.execPath, [path.join(spaced, "lib", "cli.mjs"), "help"], { encoding: "utf8" });
    assert.equal(result.status, 0, `BUGHUNT-F1 help should exit 0: ${result.stderr}`);
    assert.match(result.stdout, /autobuild run/, "BUGHUNT-F1 cli exited silently without running main() because the kit path has a space");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cli reports failure (not silent success) for an unknown command under a spaced path", () => {
  const base = mkdtempSync(path.join(tmpdir(), "autobuild-entry-"));
  try {
    const spaced = spacedKit(base);
    const result = spawnSync(process.execPath, [path.join(spaced, "lib", "cli.mjs"), "no-such-command"], { encoding: "utf8" });
    assert.equal(result.status, 2, "BUGHUNT-F1 an unknown command must exit 2, not silently exit 0 when the kit path has a space");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
