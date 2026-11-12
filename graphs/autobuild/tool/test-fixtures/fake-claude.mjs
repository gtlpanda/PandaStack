#!/usr/bin/env node
// A stand-in for `claude -p` used by test/loop.test.mjs. Each call takes the next step from
// $FAKE_CLAUDE_SCRIPT (a JSON array) and acts it out in the project:
//   { "limit": "<text>" }   end like a usage limit: error result with that text, exit 1
//   { "billing": true }     end like a spend limit
//   { "overloaded": true }  end like repeated 529s
//   { "build": "F-1" }      do the feature properly: file, mark-passed, progress entry, feat commit
//   { "build": "F-1", "stopHook": true }  then run the injected Stop hook as Claude Code does: the
//                           command and timeout from --settings; a hook past its timeout is killed
//                           and the session ends anyway
//   { "build": "F-1", "files": {path: text} }  also write those files before committing
//   { "ok": true }          a successful no-op answer (the usage probe, or a review that commits nothing)
//   { "review": true }      a review that appends a finding to PROGRESS.md and commits it as chore(review)
//   { "hang": true }        write its pid to <script>.pid, then run until killed
//   { "plant": "<path>" }   write an executable file at that path (relative to the project), commit nothing
//   { "hunt": ... }         the bug hunt session, acted out by /build-app's fake (its format, its
//                           <script>.hunt.calls record): fix commits, then a real findings ledger
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const scriptFile = process.env.FAKE_CLAUDE_SCRIPT;
const steps = JSON.parse(readFileSync(scriptFile, "utf8"));
const step = steps.shift() ?? { ok: true };
writeFileSync(scriptFile, JSON.stringify(steps));
appendFileSync(`${scriptFile}.calls`, `${JSON.stringify({ step, args: process.argv.slice(2).filter((arg) => arg.startsWith("--")) })}\n`);

if (step.plant) {
  writeFileSync(step.plant, "#!/bin/sh\ntouch planted-ran\n");
  chmodSync(step.plant, 0o755);
}
if (step.hunt) {
  const huntScript = `${scriptFile}.hunt`;
  writeFileSync(huntScript, JSON.stringify([step]));
  writeFileSync(`${huntScript}.n`, "0");
  const fake = path.resolve(import.meta.dirname, "..", "..", "..", "build", "tests", "fixtures", "fake-claude.mjs");
  execFileSync(process.execPath, [fake, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, FAKE_CLAUDE_SCRIPT: huntScript } });
  process.exit(0);
}
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
if (step.hang) {
  writeFileSync(`${scriptFile}.pid`, String(process.pid));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (step.build) {
  const id = step.build;
  writeFileSync(`${id}.done`, "built\n");
  for (const [name, content] of Object.entries(step.files ?? {})) writeFileSync(name, content);
  execFileSync(process.execPath, [process.env.AUTOBUILD_CLI, "mark-passed", id], { stdio: "ignore" });
  appendFileSync("PROGRESS.md", `\n## ${id} — test feature (2026-10-11)\n- What: built\n`);
  execFileSync("git", ["add", "-A"]);
  execFileSync("git", ["commit", "-q", "-m", `feat(${id}): built`]);
}
if (step.stopHook) {
  const argv = process.argv.slice(2);
  const settings = JSON.parse(readFileSync(argv[argv.indexOf("--settings") + 1], "utf8"));
  const hook = settings.hooks.Stop[0].hooks[0];
  const ran = spawnSync("bash", ["-c", hook.command], { input: "{}", encoding: "utf8", timeout: hook.timeout * 1000, killSignal: "SIGKILL", env: { ...process.env, CLAUDE_PROJECT_DIR: process.cwd() } });
  appendFileSync(`${scriptFile}.hook`, `${JSON.stringify({ timedOut: ran.error?.code === "ETIMEDOUT", status: ran.status, stdout: ran.stdout })}\n`);
}
if (step.review) {
  appendFileSync("PROGRESS.md", "\nREVIEW 2026-10-12: no drift found\n");
  execFileSync("git", ["commit", "-q", "-am", "chore(review): drift review"]);
}
result({ subtype: "success", is_error: false, result: "done" });
