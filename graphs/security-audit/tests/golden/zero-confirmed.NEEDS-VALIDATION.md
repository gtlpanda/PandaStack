# Needs validation: `fixture-repo`

> Leads, not findings: each has an exact unresolved blocker and no severity. Generated from findings.json.

## Unchecked owner on update

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

## Another lead

- Fingerprint: `fp-b`
- Affected boundary: Boundary of b

### Source trace

1. sink `src/app.js:1` (a): The write happens.

### Evidence

- `src/app.js:1`: No check precedes the write.

### Blocker

- The generated parser is absent.

### Resolution plans

- Bounded local: Run it locally.
- Owner-observed deployment check: Ask the owner.

