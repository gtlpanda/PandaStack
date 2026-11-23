// The ci-optimizer policy: autobuild.json's optional `ciOptimizer` key merged over the defaults
// (spec/contracts/ci-optimizer-priority.md, "Policy"). The defaults and the validation live in
// config.mjs, which config load already runs; ciPolicy validates again so a raw object passed
// here gets the same answer. The environment is never read: AUTOBUILD_GH_BIN is applied by the
// code that spawns gh.

import { CI_OPTIMIZER_DEFAULTS, validateCiOptimizer } from "../config.mjs";

/**
 * The policy for a whole autobuild.json object (or a loaded config), or null for the defaults.
 * Every call returns a fresh object, so mutating one result never changes a later one.
 */
export function ciPolicy(raw) {
  const own = raw?.ciOptimizer;
  if (own !== undefined) validateCiOptimizer(own);
  const value = own ?? {};
  return {
    ...CI_OPTIMIZER_DEFAULTS,
    ...value,
    targets: { ...CI_OPTIMIZER_DEFAULTS.targets, ...(value.targets ?? {}) },
    ratesPerMinute: { ...CI_OPTIMIZER_DEFAULTS.ratesPerMinute, ...(value.ratesPerMinute ?? {}) },
  };
}
