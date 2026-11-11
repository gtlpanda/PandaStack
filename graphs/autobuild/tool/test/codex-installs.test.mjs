import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assessInstalls, checkCodexLaunch, compareVersions, findInstalls, packageVersion } from "../lib/codex-installs.mjs";
import { npmCodex } from "../test-fixtures/codex-installs.mjs";

const scratch = () => mkdtempSync(path.join(tmpdir(), "codex-installs-"));
const PATH = (...dirs) => dirs.join(path.delimiter);

test("an older Codex first on PATH is refused and the newer install is named", () => {
  const root = scratch();
  const old = npmCodex(path.join(root, "usr"), "0.154.0"), fresh = npmCodex(path.join(root, "npm-global"), "0.167.0");
  const result = checkCodexLaunch("codex", PATH(old, fresh));
  assert.equal(result.ok, false);
  assert.match(result.message, /^Codex in use: .*usr\/bin\/codex \(0\.154\.0\)\./);
  assert.match(result.message, /Warning: 1 more on PATH: .*npm-global\/bin\/codex \(0\.167\.0\)/);
  assert.match(result.message, /older than .*npm-global\/bin\/codex; put that install first on PATH, remove the old one, or set AUTOBUILD_CODEX_BIN/);
});

test("the newest Codex first on PATH passes with a warning about the others", () => {
  const root = scratch();
  const old = npmCodex(path.join(root, "usr"), "0.154.0"), fresh = npmCodex(path.join(root, "npm-global"), "0.167.0");
  const result = checkCodexLaunch("codex", PATH(fresh, old));
  assert.equal(result.ok, true);
  assert.match(result.message, /in use: .*npm-global\/bin\/codex \(0\.167\.0\)\. Warning: 1 more on PATH: .*usr\/bin\/codex \(0\.154\.0\)\.$/);
});

test("a single install passes with no warning", () => {
  const dir = npmCodex(scratch(), "0.167.0");
  const result = checkCodexLaunch("codex", dir);
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.message, /Warning/);
});

test("equal versions in two places warn but do not refuse", () => {
  const root = scratch();
  const result = checkCodexLaunch("codex", PATH(npmCodex(path.join(root, "a"), "0.167.0"), npmCodex(path.join(root, "b"), "0.167.0")));
  assert.equal(result.ok, true);
  assert.match(result.message, /Warning: 1 more on PATH/);
});

test("PATH entries reaching the same real file count as one install", () => {
  const root = scratch();
  const bin = npmCodex(path.join(root, "usr"), "0.154.0");
  symlinkSync(bin, path.join(root, "bin-alias")); // like /bin -> /usr/bin
  assert.equal(findInstalls("codex", PATH(bin, path.join(root, "bin-alias"))).length, 1);
});

test("an unknown version is never compared, so it warns instead of refusing", () => {
  const root = scratch();
  const plain = path.join(root, "plain");
  mkdirSync(plain);
  writeFileSync(path.join(plain, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  const fresh = npmCodex(path.join(root, "npm"), "0.167.0");
  for (const order of [PATH(plain, fresh), PATH(fresh, plain)]) {
    const result = checkCodexLaunch("codex", order);
    assert.equal(result.ok, true, order);
    assert.match(result.message, /version unknown/);
  }
});

test("an explicit Codex path is the only install considered", () => {
  const root = scratch();
  const old = npmCodex(path.join(root, "usr"), "0.154.0"), fresh = npmCodex(path.join(root, "npm"), "0.167.0");
  const result = checkCodexLaunch(path.join(old, "codex"), PATH(fresh));
  assert.equal(result.ok, true, "a deliberate pin is honored");
  assert.match(result.message, /usr\/bin\/codex \(0\.154\.0\)\.$/);
});

test("relative PATH entries and a relative explicit path resolve from the launch directory", () => {
  const root = scratch();
  npmCodex(path.join(root, "tools"), "0.167.0");
  assert.equal(findInstalls("codex", "tools/bin", root)[0]?.version, "0.167.0");
  assert.equal(findInstalls("./tools/bin/codex", "", root)[0]?.version, "0.167.0");
  assert.deepEqual(findInstalls("codex", "tools/bin", path.join(root, "elsewhere")), []);
});

test("missing, non-executable, directory and dangling entries are not installs", () => {
  const root = scratch();
  for (const name of ["noexec", "dir", "dangling"]) mkdirSync(path.join(root, name));
  writeFileSync(path.join(root, "noexec", "codex"), "#!/bin/sh\n", { mode: 0o644 });
  mkdirSync(path.join(root, "dir", "codex"));
  symlinkSync(path.join(root, "nowhere"), path.join(root, "dangling", "codex"));
  const dirs = ["noexec", "dir", "dangling", "absent"].map((name) => path.join(root, name));
  assert.deepEqual(findInstalls("codex", PATH(...dirs, "")), []);
  for (const empty of ["", undefined, null]) assert.deepEqual(findInstalls("codex", empty), []);
  assert.deepEqual(assessInstalls([]), { inUse: null, others: [], newer: null, message: "No Codex CLI found on PATH." });
});

test("only a valid @openai/codex package.json supplies a version", () => {
  const root = scratch();
  const real = (prefix) => path.join(prefix, "lib", "node_modules", "@openai", "codex", "bin", "codex.js");
  npmCodex(path.join(root, "ok"), "0.167.0");
  npmCodex(path.join(root, "other"), "9.9.9", { name: "not-codex" });
  npmCodex(path.join(root, "bad"), "0.167.0-beta");
  assert.equal(packageVersion(real(path.join(root, "ok"))), "0.167.0");
  assert.equal(packageVersion(real(path.join(root, "other"))), null);
  assert.equal(packageVersion(real(path.join(root, "bad"))), null);
  assert.equal(packageVersion(path.join(root, "nowhere", "codex")), null);
  const broken = path.join(root, "broken");
  mkdirSync(broken);
  writeFileSync(path.join(broken, "package.json"), "{ not json");
  assert.equal(packageVersion(path.join(broken, "codex")), null);
});

test("versions compare numerically, not as text", () => {
  assert.ok(compareVersions("0.154.0", "0.167.0") < 0);
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
  assert.ok(compareVersions("1.0.0", "0.999.999") > 0);
  assert.equal(compareVersions("0.167.0", "0.167.0"), 0);
});

test("a PATH entry through a symlink and \"..\" resolves the way the kernel does", () => {
  const root = scratch();
  npmCodex(path.join(root, "prefix"), "0.167.0");
  mkdirSync(path.join(root, "prefix", "deep"));
  symlinkSync(path.join(root, "prefix", "deep"), path.join(root, "link"));
  // Kernel: link -> prefix/deep, then ".." -> prefix, then bin/codex. Lexically: root/bin/codex (absent).
  const installs = findInstalls("codex", `${root}/link/../bin`); // not path.join: it would collapse ".." lexically
  assert.equal(installs.length, 1);
  assert.equal(installs[0].version, "0.167.0");
});

test("control characters in an install path are escaped, never printed raw", () => {
  const root = scratch();
  const hostile = npmCodex(path.join(root, "evil\u001b[2Jname"), "0.154.0");
  const fresh = npmCodex(path.join(root, "plain"), "0.167.0");
  const result = checkCodexLaunch("codex", PATH(hostile, fresh));
  assert.equal(result.ok, false, "the hostile-named install is still the one in use, so it is still compared");
  assert.doesNotMatch(result.message, /[\x00-\x1f\x7f]/);
  assert.match(result.message, /evil\\x1b\[2Jname\/bin\/codex \(0\.154\.0\)/);
});
