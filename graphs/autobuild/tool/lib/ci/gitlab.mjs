// ci-optimizer GitLab CI reader (spec/contracts/ci-optimizer-co-02.md): `.gitlab-ci.yml` as
// stages and jobs. Parsing reuses parseWorkflowYaml; a construct it refuses (anchors, aliases,
// merge keys, tags) makes the file unparsed, reported as `{ file, error }`, never a thrown error.

import { readFileSync } from "node:fs";
import path from "node:path";
import { CI_FILE_PROVIDERS } from "../ci-parity.mjs";
import { parseWorkflowYaml } from "../workflow-yaml.mjs";
import { TEST_COMMAND, wholeNumberOf } from "./patterns.mjs";

export const GITLAB_PROVIDER = "gitlab";
// The GitLab file name, taken from ci-parity's CI file map rather than restated.
const GITLAB_FILE = Object.keys(CI_FILE_PROVIDERS).find((file) => CI_FILE_PROVIDERS[file] === GITLAB_PROVIDER);
const DEFAULT_STAGES = ["build", "test", "deploy"];
const DEFAULT_JOB_STAGE = "test";
// Top-level keywords that configure the pipeline rather than name a job.
const RESERVED_KEYS = new Set(["stages", "variables", "default", "include", "workflow", "image", "services", "before_script", "after_script", "cache"]);

const plainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (list) => list.filter((item) => typeof item === "string");

function stagesOf(value) {
  return Array.isArray(value) ? strings(value) : [...DEFAULT_STAGES];
}

const isJob = ([key, value]) => plainObject(value) && !key.startsWith(".") && !RESERVED_KEYS.has(key);

// Absent: null ("after the previous stage"). A list: its string names and `{ job }` names.
function needsOf(value) {
  if (!Array.isArray(value)) return null;
  return value.map((need) => (plainObject(need) ? need.job : need)).filter((name) => typeof name === "string");
}

// A matrix entry's job count: the product of its list-valued keys, a scalar key counting 1.
function matrixEntrySize(entry) {
  return Object.values(entry).reduce((size, value) => size * (Array.isArray(value) ? value.length : 1), 1);
}

// A whole number N, or `{ matrix: [entries] }` summed over its entries; anything else is null.
function parallelOf(value) {
  const count = wholeNumberOf(value);
  if (count !== null) return count;
  const matrix = plainObject(value) ? value.matrix : undefined;
  if (!Array.isArray(matrix) || !matrix.length || !matrix.every(plainObject)) return null;
  return matrix.reduce((total, entry) => total + matrixEntrySize(entry), 0);
}

// The `image: name` string, or the `image: { name }` form's name; else null.
function imageName(value) {
  if (typeof value === "string") return value;
  return plainObject(value) && typeof value.name === "string" ? value.name : null;
}

function scriptOf(value) {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? strings(value) : [];
}

function jobModel(id, job, doc) {
  const script = scriptOf(job.script);
  const defaults = plainObject(doc.default) ? doc.default : {};
  return {
    id,
    stage: typeof job.stage === "string" ? job.stage : DEFAULT_JOB_STAGE,
    needs: needsOf(job.needs),
    parallel: parallelOf(job.parallel),
    cache: Object.hasOwn(job, "cache") || Object.hasOwn(defaults, "cache"),
    image: imageName(job.image) ?? imageName(doc.image),
    script,
    test: script.some((line) => TEST_COMMAND.test(line)),
  };
}

/** `{ file, stages, jobs }` for the repository's `.gitlab-ci.yml`, or `{ file, error }` when it cannot be read or parsed. */
export function readGitlabPipeline(root) {
  let doc;
  try {
    doc = parseWorkflowYaml(readFileSync(path.join(root, GITLAB_FILE), "utf8"));
  } catch (error) {
    return { file: GITLAB_FILE, error: `${GITLAB_FILE}: ${String(error?.message ?? error)}` };
  }
  if (!plainObject(doc)) return { file: GITLAB_FILE, error: `${GITLAB_FILE}: the top level is not a mapping` };
  const jobs = Object.entries(doc).filter(isJob).map(([id, job]) => jobModel(id, job, doc));
  return { file: GITLAB_FILE, stages: stagesOf(doc.stages), jobs };
}
