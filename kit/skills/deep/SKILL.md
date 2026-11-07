---
name: deep
description: Decompose complex problems into independent components, validate each with background subagents, and synthesize the final answer. Use when the user says "deep work", "decompose this", "think deeply", "parallel analysis", "validate with subagents", "synthesize", or when the task is complex enough to benefit from parallel decomposition and independent validation. Also trigger when the user explicitly appends instructions like "decompose the problem" or "validate each answer with subagents".
version: 0.1.0
---

# Deep Work — Decompose, Validate, Synthesize

You are operating in Deep Work mode. This is a rigorous problem-solving protocol that maximizes quality by decomposing problems, validating independently, and synthesizing with full confidence.

## Protocol

### Phase 1: Decompose

Before writing any code or giving any answer, decompose the problem:

1. **Identify the core question** — What is the user actually asking? Strip away ambiguity.
2. **Break into independent components** — Each component should be:
   - Self-contained (can be analyzed without the others)
   - Non-overlapping (no duplicated work across components)
   - Collectively exhaustive (all components together cover the full problem)
3. **State dependencies** — If component B depends on component A's output, note it. Dependent components run sequentially; independent ones run in parallel.
4. **Output the decomposition** — Show the user the component breakdown before proceeding. Format:

```
## Decomposition

1. **[Component Name]** — [What this component investigates/builds]
2. **[Component Name]** — [What this component investigates/builds]
3. **[Component Name]** — [What this component investigates/builds]
   └─ depends on: #1
```

### Phase 2: Validate with Subagents

For each independent component:

1. **Launch a background subagent** using the Agent tool with `run_in_background: true`
2. **Give each subagent a focused, self-contained prompt** that includes:
   - The specific question or task for that component
   - Enough context to work independently
   - Clear success criteria (what a good answer looks like)
   - Whether the agent should research only or also write code
3. **Maximize parallelism** — Launch all independent subagents in a single message
4. **Sequential where needed** — For dependent components, wait for the dependency to complete before launching

### Phase 3: Synthesize

Once all subagents return:

1. **Collect findings** — Review each subagent's output
2. **Resolve conflicts** — If subagents disagree, investigate the disagreement rather than averaging
3. **Identify gaps** — Did any component miss something? Are there cross-component concerns?
4. **Synthesize the final answer** — Combine all validated components into a coherent, complete response
5. **State confidence** — For each component, note your confidence level (high/medium/low) and why

Format the synthesis clearly:

```
## Synthesis

### [Component 1 Name] ✓
[Key findings, validated]

### [Component 2 Name] ✓
[Key findings, validated]

### Cross-Cutting Concerns
[Anything that emerged from looking at components together]

### Final Answer
[The complete, synthesized response]
```

## Rules

- **Never skip decomposition.** Even if the answer seems obvious, decompose first. You'll often discover non-obvious dimensions.
- **Never skip validation.** Every component gets a subagent. The main context window stays clean for synthesis.
- **Prefer parallel over sequential.** The more you can parallelize, the faster and more independent the validation.
- **Show your work.** The user should see the decomposition, know subagents are running, and see the synthesis. Transparency builds trust.
- **Challenge subagent outputs.** If a subagent's answer seems shallow or wrong, re-investigate rather than accepting it.
- **Keep the main thread clean.** Do research and heavy lifting in subagents. The main thread is for decomposition, orchestration, and synthesis.
