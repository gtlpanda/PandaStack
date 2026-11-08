// A `writable` path inside a frozen directory must stay editable through the injected permission rules too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionSettings } from "../lib/loop.mjs";

// True when an `Edit(/<pattern>)` deny rule covers the repo-relative path (exact or `dir/**`).
function denyCovers(rule, rel) {
  const match = /^Edit\(\/(.*)\)$/.exec(rule);
  if (!match) return false;
  const pattern = match[1];
  if (pattern.endsWith("/**")) return rel.startsWith(`${pattern.slice(0, -3)}/`);
  return pattern === rel;
}

test("a writable exception inside a frozen directory is not covered by the injected Edit deny rules", () => {
  const config = { hooks: "inject", frozen: ["spec"], writable: ["spec/DECISIONS.md"], subagentModel: "claude-haiku-5-5" };
  const { permissions } = sessionSettings(config);
  const covering = permissions.deny.filter((rule) => denyCovers(rule, "spec/DECISIONS.md"));
  assert.deepEqual(covering, [], `BUGHUNT-F26 writable spec/DECISIONS.md is still denied by permission rules: ${covering.join(", ")}`);
});
