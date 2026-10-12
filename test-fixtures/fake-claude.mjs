#!/usr/bin/env node
// A stand-in for `claude -p` used by test/loop.test.mjs. Each call takes the next step from
// $FAKE_CLAUDE_SCRIPT (a JSON array) and acts it out in the project:
//   { "limit": "<text>" }   end like a usage limit: error result with that text, exit 1
//   { "billing": true }     end like a spend limit
//   { "overloaded": true }  end like repeated 529s
//   { "build": "F-1" }      do the feature properly: file, mark-passed, progress entry, feat commit
//   { "ok": true }          a successful no-op answer (the usage probe)
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const scriptFile = process.env.FAKE_CLAUDE_SCRIPT;
const steps = JSON.parse(readFileSync(scriptFile, "utf8"));
const step = steps.shift() ?? { ok: true };
writeFileSync(scriptFile, JSON.stringify(steps));
appendFileSync(`${scriptFile}.calls`, `${JSON.stringify({ step, args: process.argv.slice(2).filter((arg) => arg.startsWith("--")) })}\n`);

const result = (fields) => console.log(JSON.stringify({ type: "result", num_turns: 1, total_cost_usd: 0.01, permission_denials: [], ...fields }));
if (step.limit) {
  result({ subtype: "error_during_execution", is_error: true, result: step.limit });
  process.exit(1);
}
if (step.billing) {
  result({ subtype: "error_during_execution", is_error: true, result: "Credit balance is too low" });
  process.exit(1);
}
if (step.overloaded) {
  result({ subtype: "error_during_execution", is_error: true, result: "API Error: Repeated 529 Overloaded errors" });
  process.exit(1);
}
if (step.tamper) {
  const doc = JSON.parse(readFileSync("features.json", "utf8"));
  doc.features[0].acceptance = ["weakened"];
  writeFileSync("features.json", JSON.stringify(doc, null, 2));
  execFileSync("git", ["commit", "-q", "-am", "chore: sneaky"]);
}
if (step.build) {
  const id = step.build;
  writeFileSync(`${id}.done`, "built\n");
  execFileSync(process.execPath, [process.env.AUTOBUILD_CLI, "mark-passed", id], { stdio: "ignore" });
  appendFileSync("PROGRESS.md", `\n## ${id} — test feature (2026-10-11)\n- What: built\n`);
  execFileSync("git", ["add", "-A"]);
  execFileSync("git", ["commit", "-q", "-m", `feat(${id}): built`]);
}
result({ subtype: "success", is_error: false, result: "done" });
