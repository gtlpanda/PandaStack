# Needs validation: `fixture-repo`

> Leads, not findings: each has an exact unresolved blocker and no severity. Generated from findings.json.

## Unresolved candidates (not findings)

- `fp-u`: `validation_budget_exhausted` (Route u (Boundary of u))

## The one lead that was verified

- Fingerprint: `fp-a`
- Affected boundary: Boundary of a

### Source trace

1. sink `src/app.js:1` (a): The write happens.

### Evidence

- `src/app.js:1`: No check precedes the write.

### Blocker

- The generated parser is absent.

### Resolution plans

- Bounded local: Generate it and submit an oversized input.
- Owner-observed deployment check: none given

