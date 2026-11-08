# Findings detail: `fixture-repo`

> Each confirmed medium, high or critical finding, with its source path and its bounded reproduction. Generated from findings.json.

## High finding

- Fingerprint: `fp-hi`; severity high; confidence high

### Source path

1. sink `src/app.js:1` (a): The write happens.

### Evidence

- `src/app.js:1`: No check precedes the write.

### Reproduction

Dummy principal: A remote user with an account.

Input:

```text
Another user's object id.
```

Instructions:

```text
1. Submit the id.
```

Observed result:

```text
The other user's object changes.
```

Security invariant: Only the owner changes the object.

### Conditions

None.

### Source-level remediation

Check ownership first.

Suggested code changes. These are the audit's suggestions: they were not applied and not reviewed.

- `src/app.js`

````text
if (note.owner !== user.id) throw new Error("forbidden")
```
return note
````

Regression case: the reproduction above, written as a test that fails before the fix.

## Medium finding

- Fingerprint: `fp-mid`; severity medium; confidence high

### Source path

1. sink `src/app.js:1` (a): The write happens.

### Evidence

- `src/app.js:1`: No check precedes the write.

### Reproduction

Dummy principal: A remote user with an account.

Input:

```text
Another user's object id.
```

Instructions:

```text
1. Submit the id.
```

Observed result:

```text
The other user's object changes.
```

Security invariant: Only the owner changes the object.

### Conditions

None.

### Source-level remediation

Check ownership first.

Regression case: the reproduction above, written as a test that fails before the fix.

