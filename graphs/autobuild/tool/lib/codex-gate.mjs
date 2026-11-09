// Codex cannot use Claude's Stop/PreToolUse hooks. The host validates and commits.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { statePath } from "./config.mjs";
import { readFeatures, readProgress, readBlockers, writeFeatures } from "./features.mjs";
import { frozenChanges, gitControlDigest, gitControlChanges, runGate } from "./gate.mjs";
import { git } from "./proc.mjs";
import { readCodexResult } from "./codex.mjs";
import { classifyOutcome } from "./limits.mjs";
import { defaultBase } from "../../../build/skills/build-app/driver/finish.mjs";

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

/** Native Codex branch audit; never claims to have produced the Claude Workflow hunt ledger. */
export async function runCodexHunt(config, { log, runId, run, stopped }) {
  const base = config.bughuntBase || defaultBase(config.root);
  const resolved = git(config, ["rev-parse", "--verify", `${base}^{commit}`]);
  if (!resolved.ok) { log(`Codex branch audit: base ${base} is unavailable; set bughuntBase`); return 12; }
  const before = head(config);
  const recordFile = statePath(config, "codex-audit.json");
  if (git(config, ["status", "--porcelain"]).output.trim()) { log("Codex branch audit needs a clean tree"); return 12; }
  if (existsSync(recordFile)) {
    try {
      const previous = JSON.parse(readFileSync(recordFile, "utf8"));
      if (previous.head === before && previous.base === resolved.output.trim()) {
        const control = gitControlDigest(config);
        const featuresBefore = readFileSync(path.join(config.root, config.featuresFile), "utf8");
        const gate = runGate(config, { baseSha: before, failFast: true });
        if (!protectedUnchanged(config, before, featuresBefore, control)) return 4;
        if (!gate.ok || git(config, ["status", "--porcelain"]).output.trim()) { gateFeedback(config, gate, log); return 12; }
        log("Codex branch audit: cached review, full gate rechecked: PASS");
        return 0;
      }
    } catch { /* retry */ }
  }

  const schemaFile = statePath(config, "codex-audit-schema.json");
  const outputFile = statePath(config, "codex-audit-result.json");
  writeFileSync(schemaFile, JSON.stringify({ type: "object", properties: {
    verdict: { type: "string", enum: ["pass", "needs_human"] },
    summary: { type: "string" }, unresolved: { type: "array", items: { type: "string" } },
  }, required: ["verdict", "summary", "unresolved"], additionalProperties: false }));
  rmSync(outputFile, { force: true });
  const control = gitControlDigest(config);
  const featuresBefore = readFileSync(path.join(config.root, config.featuresFile), "utf8");
  const logFile = path.join(config.root, config.logsDir, `${runId}-codex-audit.jsonl`);
  log(`Codex branch audit: ${base}...HEAD; review, reproduce and fix defects, then independent full gate`);
  const code = await run({ role: "audit", logFile, schemaFile, outputFile,
    prompt: `Audit the entire branch diff ${resolved.output.trim()}...HEAD against the spec/contracts. Look for concrete bugs, races, authorization gaps, error handling and regressions. Reproduce and fix verified defects. Do not change frozen tests or feature flags. You may add regression tests outside frozen paths. Run the full gate. Do not commit. Return pass only when the audit is complete and no unresolved defects remain; otherwise needs_human. Include file:line and evidence in summary/unresolved. This is a native Codex audit, not the Claude Workflow bughunt graph.`,
  });
  if (stopped()) return 130;
  const frozen = frozenChanges(config, before);
  if (head(config) !== before || gitControlChanges(config, control).length || !frozen.ok || frozen.changed.length || readFileSync(path.join(config.root, config.featuresFile), "utf8") !== featuresBefore) {
    log("Codex branch audit changed protected files or HEAD; work kept for inspection"); return 4;
  }
  const result = readCodexResult(logFile);
  if (!succeeded(code, result)) {
    const verdict = classifyOutcome({ result });
    log(`Codex branch audit did not complete (exit ${code}, ${verdict.message || result?.subtype || "no result"})`);
    return ({ usage_limit: 8, billing: 9, auth: 10 })[verdict.kind] ?? 12;
  }
  let audit;
  try { audit = JSON.parse(readFileSync(outputFile, "utf8")); } catch { log("Codex branch audit returned no valid report"); return 12; }
  if (audit.verdict !== "pass" || !Array.isArray(audit.unresolved) || audit.unresolved.length || typeof audit.summary !== "string") {
    log(`Codex branch audit needs attention: ${JSON.stringify(audit)}`); return 12;
  }
  const gate = runGate(config, { baseSha: before, failFast: true });
  if (!protectedUnchanged(config, before, featuresBefore, control)) {
    log("Codex audit gate changed protected files or HEAD; work kept for inspection"); return 4;
  }
  if (!gate.ok) { gateFeedback(config, gate, log); return 12; }
  appendFileSync(path.join(config.root, config.progressFile), `\nCODEX-AUDIT ${new Date().toISOString().slice(0, 10)}: ${audit.summary.replaceAll("\n", " ")}\n`);
  if (!commit(config, "chore(autobuild): Codex branch audit and verified fixes")) { log("Codex branch audit commit failed"); return 12; }
  writeFileSync(recordFile, JSON.stringify({ head: head(config), base: resolved.output.trim(), summary: audit.summary }));
  log("Codex branch audit and full gate: PASS (no Claude Workflow ledger; PR review gate is unchanged)");
  return 0;
}
