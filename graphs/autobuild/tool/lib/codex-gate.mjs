// Codex cannot use Claude's Stop/PreToolUse hooks. The host validates and commits.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { statePath } from "./config.mjs";
import { readFeatures, readProgress, readBlockers, writeFeatures } from "./features.mjs";
import { frozenChanges, gitControlDigest, gitControlChanges, runGate } from "./gate.mjs";
import { git } from "./proc.mjs";

const succeeded = (code, result) => code === 0 && result?.subtype === "success" && !result.is_error;
const head = (config) => git(config, ["rev-parse", "HEAD"]).output.trim();
function commit(config, message, paths = ["."]) {
  const added = git(config, ["add", "--", ...paths]);
  return added.ok && git(config, ["commit", "-q", "-m", message]).ok;
}
function changedFiles(config, base) {
  const diff = git(config, ["diff", "--name-only", base]);
  const added = git(config, ["ls-files", "--others", "--exclude-standard"]);
  if (!diff.ok || !added.ok) throw new Error("Cannot inspect Codex changes");
  return [...new Set(`${diff.output}\n${added.output}`.split("\n").filter(Boolean))];
}
function protectedUnchanged(config, base, featuresBefore, control) {
  const frozen = frozenChanges(config, base);
  return head(config) === base && frozen.ok && frozen.changed.length === 0
    && gitControlChanges(config, control).length === 0
    && readFileSync(path.join(config.root, config.featuresFile), "utf8") === featuresBefore;
}
function gateFeedback(config, summary, log) {
  const feedback = summary.steps.filter((step) => !step.ok).map((step) => `${step.name}: ${step.tail}`).join("\n");
  writeFileSync(statePath(config, "codex-feedback.txt"), feedback);
  log(`Codex host gate: FAIL\n${feedback}`);
}

export function finishCodexBuilder(config, { feature, base, docBefore, exitCode, result, log }) {
  // The model must never mark another feature passing or commit around the host gate.
  const now = readFeatures(config);
  if (head(config) !== base || JSON.stringify(now) !== JSON.stringify(docBefore)) {
    log("Codex changed HEAD or features.json; stopping before accepting its work");
    return 4;
  }
  if (!succeeded(exitCode, result)) return;
  if (readBlockers(readProgress(config)).has(feature.id)) return; // outer loop records the blocker
  const featuresBefore = readFileSync(path.join(config.root, config.featuresFile), "utf8");
  const control = gitControlDigest(config);
  const summary = runGate(config, { featureId: feature.id, baseSha: base, failFast: true });
  if (!protectedUnchanged(config, base, featuresBefore, control)) {
    log("Codex gate commands changed protected files or HEAD; work kept for inspection"); return 4;
  }
  if (!summary.ok) { gateFeedback(config, summary, log); return; }
  if (!readProgress(config).split("\n").some((line) => line.startsWith(`## ${feature.id} `))) {
    gateFeedback(config, { steps: [{ name: "progress", ok: false, tail: `Append a ## ${feature.id} — … entry to ${config.progressFile}.` }] }, log);
    return;
  }
  now.features.find((item) => item.id === feature.id).passes = true;
  writeFeatures(config, now);
  if (!commit(config, `feat(${feature.id}): ${feature.title}`)) {
    writeFeatures(config, docBefore);
    log("Codex host commit failed; passes flag restored, work kept");
    return;
  }
  rmSync(statePath(config, "codex-feedback.txt"), { force: true });
  log(`Codex host gate: PASS; committed ${feature.id}`);
}

export function finishCodexReview(config, { base, exitCode, result, log }) {
  const changes = changedFiles(config, base);
  if (head(config) !== base || changes.some((file) => file !== config.progressFile)) {
    throw new Error("Codex review changed files beyond the progress file or changed HEAD; work kept for inspection");
  }
  if (!succeeded(exitCode, result) || !changes.includes(config.progressFile)) return;
  const featuresBefore = readFileSync(path.join(config.root, config.featuresFile), "utf8");
  const control = gitControlDigest(config);
  const gate = runGate(config, { baseSha: base, failFast: true });
  if (!protectedUnchanged(config, base, featuresBefore, control) || changedFiles(config, base).some((file) => file !== config.progressFile)) {
    throw new Error("Codex review gate changed protected files or implementation files; work kept for inspection");
  }
  if (!gate.ok) { gateFeedback(config, gate, log); return; }
  if (!commit(config, "chore(review): Codex drift and defect review", [config.progressFile])) log("Codex review commit failed");
}
