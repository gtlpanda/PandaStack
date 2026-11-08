# Needs validation: `fixture-repo`

> Leads, not findings: each has an exact unresolved blocker and no severity. Generated from findings.json.

## A lead

- Fingerprint: `fp-nv`
- Affected boundary: Boundary of nv

### Source trace

1. sink `src/app.js:1` (a): The write happens.

### Evidence

- `src/app.js:1`: No check precedes the write.

### Blocker

- The generated parser is absent.

### Resolution plans

- Bounded local: Generate it and submit an oversized input.
- Owner-observed deployment check: none given

