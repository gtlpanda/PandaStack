# CO-02: GitLab CI reader

Priority: spec/contracts/ci-optimizer-priority.md. Depends on CO-01.
Test: acceptance/ci-optimizer/co-02-gitlab.test.mjs.

## Module

`lib/ci/gitlab.mjs` exports `readGitlabPipeline(root)`. It returns either:
- `{ file: ".gitlab-ci.yml", stages, jobs }`, or
- `{ file, error }` when the file does not parse.

`discoverRepo` puts the result in `ci.pipelines`. The `gitlab` provider's status becomes
`parsed` when the file parses, and `unparsed` (with the parser's message) when it does not.
Parsing uses `parseWorkflowYaml`. A construct that parser refuses, such as anchors or aliases,
makes the file `unparsed`. It never makes discovery fail.

## Model

- **`stages`:** the top-level `stages` list, or `["build", "test", "deploy"]` when it is
  absent.
- **Jobs:** every top-level key that maps to an object is a job, except:
  - keys starting with `.`;
  - the reserved keys `stages`, `variables`, `default`, `include`, `workflow`, `image`,
    `services`, `before_script`, `after_script`, `cache`.
- **Order:** jobs keep file order.

Each job is:

```
{ id, stage, needs: [names] | null, parallel: integer | null, cache: boolean,
  image: string | null, script: [lines], test: boolean }
```

- **`stage`:** the job's `stage`, else `"test"`.
- **`needs`:**
  - a list of strings, or of `{ job: name }` objects, becomes those names;
  - an absent key becomes `null`, which means "after the previous stage";
  - `[]` stays `[]`.
- **`parallel`:**
  - a whole number `N` becomes the integer `N` (`parseWorkflowYaml` returns scalars as
    strings, so `"3"` becomes `3`; the same applies to CO-01's `timeoutMinutes`);
  - `parallel: { matrix: [ {...}, ... ] }` becomes the sum, over the matrix entries, of the
    product of each entry's list-valued key lengths, with scalar keys counting 1;
  - anything else becomes `null`.
- **`cache`:** `true` when the job or the top-level `default` has a `cache` key.
- **`image`:** the job's `image` string, else the top-level `image`, else `null`.
- **`script`:** the job's `script` lines; a single string becomes one line.
- **`test`:** `true` when any `script` line matches CO-01's test pattern.

## Acceptance (frozen)

Fixture `acceptance/ci-optimizer/fixtures/repos/python-gitlab/` is a Python/pytest project.
Its `pytest-xdist` dependency is declared, and its `.gitlab-ci.yml` has:
- stages `lint`, `test`, `deploy`;
- a hidden `.base` job;
- `lint` (`ruff check .`);
- `unit` (`pytest -q`, `parallel: 3`, cache);
- `integration` (`needs: [unit]`, a `parallel: matrix` of `PY: ["3.11","3.12"]` ×
  `DB: ["pg"]`);
- a `deploy` job.

1. Discovery reports languages `["python"]`, provider `gitlab` with status `parsed`, the jobs
   `lint`, `unit`, `integration`, `deploy` in that order, and leaves out `.base`.
2. `unit` has `parallel: 3`, `cache: true` and `test: true`. `integration` has
   `needs: ["unit"]` and `parallel: 2`. `lint` has `needs: null` and `test: false`.
3. A `.gitlab-ci.yml` that uses an anchor (`&defaults`) gives status `unparsed` with an
   error, and every other part of the profile is still produced.
4. Editing `.gitlab-ci.yml` changes `inputsDigest`.
