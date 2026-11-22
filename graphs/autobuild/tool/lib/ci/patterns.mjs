// Command and scalar rules shared by the ci-optimizer's CI readers (GitHub workflows in
// discover.mjs, GitLab pipelines in gitlab.mjs), kept in one place so they never drift apart.

/** A shell line that runs tests (CO-01's test step kind; CO-02's job `test` flag). */
export const TEST_COMMAND = /\b(npm|pnpm|yarn|bun)( run)? test\b|\bnode --test\b|\b(vitest|jest|mocha|pytest|tox|rspec)\b|\bgo test\b|\bcargo test\b|\bmvn\b.*\b(test|verify)\b|\bgradlew?\b.*\btest\b|(^|[\s\/])test[\w.-]*\.sh\b|\bcli\.mjs check\b|\bautobuild check\b/;

/** A shell line that installs dependencies (CO-01's install step kind). */
export const INSTALL_COMMAND = /\b(npm ci|npm install|pnpm install|yarn install|bun install|pip install|poetry install|bundle install|go mod download)\b/;

/**
 * The integer a YAML scalar spells as a whole number, else null. parseWorkflowYaml returns
 * every scalar as a string, so `3` arrives as "3"; "2.5", "-1", "abc" and non-strings are null.
 */
export const wholeNumberOf = (value) => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null);
