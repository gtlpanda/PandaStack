// features.json: the ordered build list. PROGRESS.md: the log, including BLOCKER lines.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function featuresPath(config) {
  return path.join(config.root, config.featuresFile);
}

export function readFeatures(config) {
  const doc = JSON.parse(readFileSync(featuresPath(config), "utf8"));
  if (!Array.isArray(doc.features)) throw new Error(`${config.featuresFile}: missing features[]`);
  return doc;
}

export function writeFeatures(config, doc) {
  writeFileSync(featuresPath(config), `${JSON.stringify(doc, null, 2)}\n`);
}

export function featureById(doc, id) {
  const feature = doc.features.find((candidate) => candidate.id === id);
  if (!feature) throw new Error(`Unknown feature id: ${id}`);
  return feature;
}

export function readProgress(config) {
  const file = path.join(config.root, config.progressFile);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** IDs with a `BLOCKER <ID>:` line in the progress log. */
export function readBlockers(progressText) {
  const ids = new Set();
  for (const match of progressText.matchAll(/^BLOCKER ([A-Za-z0-9_.-]+):/gm)) ids.add(match[1]);
  return ids;
}

export function blockedClosure(doc, blockers) {
  const blocked = new Set(blockers);
  let grew = true;
  while (grew) {
    grew = false;
    for (const feature of doc.features) {
      if (!blocked.has(feature.id) && (feature.dependencies ?? []).some((dep) => blocked.has(dep))) {
        blocked.add(feature.id);
        grew = true;
      }
    }
  }
  return blocked;
}

/** The first feature with passes:false whose dependencies all pass and that is not blocked. */
export function nextFeature(doc, blockers) {
  const passing = new Set(doc.features.filter((feature) => feature.passes).map((feature) => feature.id));
  const blocked = blockedClosure(doc, blockers);
  return doc.features.find((feature) => !feature.passes && !blocked.has(feature.id) && (feature.dependencies ?? []).every((dep) => passing.has(dep))) ?? null;
}

export function countPassing(doc) {
  return doc.features.filter((feature) => feature.passes).length;
}
