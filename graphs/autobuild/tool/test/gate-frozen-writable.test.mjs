// A path listed in `writable` is an exception inside a frozen path: the guard lets a builder edit
// it, so the frozen-files check must not report it as a frozen change.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { frozenChanges } from "../lib/gate.mjs";

test("frozenChanges does not report a writable exception inside a frozen path", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autobuild-frozen-writable-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "autobuild");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ branch: "autobuild", frozen: ["spec"], writable: ["spec/DECISIONS.md"] }));
  writeFileSync(path.join(root, "features.json"), JSON.stringify({ features: [] }));
  mkdirSync(path.join(root, "spec"));
  writeFileSync(path.join(root, "spec", "DECISIONS.md"), "# decisions\n");
  writeFileSync(path.join(root, "spec", "SPEC.md"), "# spec\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const base = git("rev-parse", "HEAD");

  // A builder session appends to the writable exception, which the guard allows.
  writeFileSync(path.join(root, "spec", "DECISIONS.md"), "# decisions\n- chose X\n");

  const config = loadConfig(root, {});
  const result = frozenChanges(config, base);
  assert.equal(result.ok, true, "git diff ran");
  assert.deepEqual(result.changed, [], `BUGHUNT-F23 writable spec/DECISIONS.md reported as a frozen change: ${result.changed.join(", ")}`);
});
