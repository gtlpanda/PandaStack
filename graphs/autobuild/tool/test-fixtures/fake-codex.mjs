#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const file = process.env.FAKE_CLAUDE_SCRIPT;
const steps = JSON.parse(readFileSync(file, "utf8"));
const step = steps.shift() ?? { ok: true };
writeFileSync(file, JSON.stringify(steps));
const args = process.argv.slice(2);
const input = readFileSync(0, "utf8");
appendFileSync(`${file}.calls`, `${JSON.stringify({ step, args, input })}\n`);
if (args[0] !== "exec" || !args.includes("--json") || !args.includes("--sandbox")) process.exit(99);
if (step.hang) { setInterval(() => {}, 1000); await new Promise(() => {}); }
if (step.error) {
  console.log(JSON.stringify({ type: "turn.failed", error: { message: step.error } }));
  process.exit(1);
}
if (step.build) {
  writeFileSync(`${step.build}.done`, "built\n");
  appendFileSync("PROGRESS.md", `\n## ${step.build} — built\n`);
}
if (step.review) appendFileSync("PROGRESS.md", "\nREVIEW: no defects\n");
if (step.tamper) writeFileSync("tests/F-1.test", "weakened\n");
if (step.flags) {
  const doc = JSON.parse(readFileSync("features.json", "utf8"));
  doc.features.forEach(f => f.passes = true);
  writeFileSync("features.json", JSON.stringify(doc));
}
if (step.gateFail) writeFileSync("bad-code", "broken\n");
if (step.fixGate) execFileSync("rm", ["bad-code"]);
if (step.audit) writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify(step.audit));
if (step.noResult) process.exit(0);
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
