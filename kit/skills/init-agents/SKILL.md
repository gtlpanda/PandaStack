---
name: init-agents
description: Set up a specialist-agent system for a project. For Claude Code, writes .claude/agents/ definitions, memory directories, a CLAUDE.md routing table and permission settings; for Codex, writes domain guides and an AGENTS.md routing table. Use when the user says "init agents", "set up agents", "add claude agents", "create agent system", "agent routing", "specialized agents", or when a project is complex enough to benefit from domain-specific agent knowledge bases.
version: 0.1.0
---

# Init Agents — Specialized Agent System

You are setting up a system of specialist agents for a project. Each agent is an expert in one domain and is consulted before writing code in that domain. This prevents hallucination and enforces accuracy.

## Provider output

This skill runs on Claude Code and on Codex, and the two hosts get different files.
Decide the target first, from the host you are running in. If that is unclear, ask the
user once, in one message: "Claude Code, Codex, or both?" Generate only what the target needs.

| Target | Domain knowledge | Routing table | Also written |
|--------|------------------|---------------|--------------|
| Claude Code | `.claude/agents/{domain}.md` agent definitions | `CLAUDE.md` | `.claude/agent-memory/`, `.claude/settings.local.json` |
| Codex | `docs/agents/{domain}.md` domain guides (no frontmatter) | `AGENTS.md` | nothing else |

Codex has no agent-definition format this skill generates, no Agent tool to invoke a
specialist, no per-agent memory directory and no `settings.local.json`. For Codex the
specialist is a guide the main session reads before it works in that domain.

Phases 1, 3 (the Role, Context, Knowledge Base, Requirements and Output Format sections),
4 and 7 apply to both targets. Phases 2, 5 and 6 are Claude Code output; each one ends
with what Codex does instead.

## Protocol

### Phase 1: Identify Domains

Analyze the project to identify domains that would benefit from a dedicated agent. Common domains:

| Domain | When to Create an Agent |
|--------|------------------------|
| **External APIs** (AWS, Stripe, etc.) | Project makes SDK calls where wrong parameters = production bugs |
| **Language/DSL** | Project has a custom config format, query language, or schema |
| **Infrastructure** | Project manages cloud resources, Terraform, deployment |
| **Design/UX** | Project has a frontend with design system or style guide |
| **Security/Auth** | Project has auth flows, permission systems, or handles PII |
| **Data Model** | Project has a complex domain model with business rules |
| **Testing** | Project needs specialized test infrastructure (fixtures, mocks, harnesses) |
| **Observability** | Project has logging, monitoring, alerting patterns to enforce |

Don't create agents for domains that are simple or well-understood. Only create them where mistakes are expensive and domain knowledge is deep.

Ask the user which domains they want agents for if it's not obvious.

### Phase 2: Create Directory Structure

Claude Code:

```
.claude/
├── agents/
│   ├── {domain-1}.md
│   ├── {domain-2}.md
│   └── {domain-3}.md
├── agent-memory/
│   ├── {domain-1}/
│   │   └── MEMORY.md
│   ├── {domain-2}/
│   │   └── MEMORY.md
│   └── {domain-3}/
│       └── MEMORY.md
└── settings.local.json
```

On Codex: create `docs/agents/{domain}.md` for each domain (and no `.claude/` tree). Put each
guide's memory in a `## Memory` section at its end instead of a separate directory.

### Phase 3: Generate Agent Definitions

Each Claude Code agent file follows this template. For Codex, use the same body from `# {Agent Title}` down, without the frontmatter, and write it to `docs/agents/{domain}.md`:

```markdown
---
name: {agent-name}
description: "Use this agent when {specific trigger conditions}. This includes {list of scenarios}.

Examples:

- user: \"{example user request}\"
  assistant: \"{how assistant should respond}\"
  <uses Agent tool with {agent-name}>

- user: \"{another example}\"
  assistant: \"{response}\"
  <uses Agent tool with {agent-name}>"
---

# {Agent Title}

## Role

You are a {seniority}-level {domain} specialist for the {project-name} project. You provide authoritative guidance on {domain scope}.

## Context

{2-3 paragraphs about the project's use of this domain. What technologies are involved, what patterns are established, what mistakes are common.}

## Knowledge Base

### {Section 1 — e.g., "Supported API Calls"}
{Reference material the agent needs to do its job accurately}

### {Section 2 — e.g., "Common Patterns"}
{Established patterns in the codebase for this domain}

### {Section 3 — e.g., "Anti-Patterns"}
{Things to avoid, common mistakes, known gotchas}

## Requirements

When consulted, you MUST:

1. **Cite sources** — Reference specific files, functions, or documentation for every recommendation
2. **Be specific** — Provide exact code, exact API calls, exact config. Never say "consider using..." without specifying what
3. **Flag uncertainty** — If you're not sure about something, say so. Better to admit uncertainty than give wrong guidance
4. **Check constraints** — Verify recommendations against project constraints (security, performance, compatibility)

## Output Format

When answering questions, structure your response as:

1. **Answer** — Direct answer to the question
2. **Implementation** — Specific code or config to use
3. **Constraints** — What to watch out for
4. **References** — Files or docs to consult
```

### Phase 4: Generate Agent Memory

On Claude Code each agent's `MEMORY.md` starts minimal (on Codex this is the `## Memory` section of the guide):

```markdown
# {Agent Name} — Memory

## Decisions Made
{Track key decisions so they're consistent across sessions}

## Patterns Established
{Track patterns that have been validated and should be reused}

## Known Issues
{Track gotchas, bugs, or limitations discovered during development}
```

### Phase 5: Generate Settings

On Codex: skip this phase.

On Claude Code, create `.claude/settings.local.json` with appropriate permissions:

```json
{
  "permissions": {
    "allow": [
      "Bash(git add:*)",
      "Bash(git commit:*)"
    ]
  }
}
```

Customize based on project needs:
- **IaC projects**: Add `"Bash(terraform plan:*)"`
- **Go projects**: Add `"Bash(go test:*)"`, `"Bash(golangci-lint:*)"`
- **Node projects**: Add `"Bash(pnpm:*)"` or `"Bash(npm:*)"`

### Phase 6: Update CLAUDE.md (Claude Code) or AGENTS.md (Codex)

If the target's instructions file (`CLAUDE.md` for Claude Code, `AGENTS.md` for Codex) exists, add the agent routing table; if it does not, create `AGENTS.md` for Codex only (for Claude Code, suggest `init-claude`):

```markdown
## Agent Routing

| Domain | Agent | When to Consult |
|--------|-------|-----------------|
| {domain} | `{agent-name}` | {trigger conditions} |

### How to Consult Agents

Before implementing in an agent's domain:
1. State what you're building and why
2. Ask the agent for the correct approach
3. Implement based on the agent's response
4. If the agent's guidance conflicts with CLAUDE.md, CLAUDE.md wins
```

On Codex, write the table with a guide path in place of the agent name
(`docs/agents/{domain}.md`), and change step 2 to "Read the guide for the domain" and
step 4 to "If the guide conflicts with AGENTS.md, AGENTS.md wins".

### Phase 7: Verify

1. Every agent file has valid YAML frontmatter
2. Every agent has at least 2 examples in the description
3. Every agent memory directory exists with a MEMORY.md
4. The routing table (CLAUDE.md or AGENTS.md) matches the agents or guides created
5. On Claude Code, settings.local.json is valid JSON

## Rules

- **Quality over quantity.** 3 excellent agents > 8 mediocre ones. Only create agents for domains where domain knowledge is deep and mistakes are expensive.
- **Examples are critical.** The description's examples teach Claude when to invoke the agent. Bad examples = agent never gets used.
- **Memory is for decisions.** Agent memory tracks decisions and patterns, not session transcripts. Keep it structured and concise.
- **Agents don't write code.** Agents provide guidance. The main session writes code based on that guidance.
- **The instructions file is the source of truth.** If an agent or guide says one thing and CLAUDE.md (Claude Code) or AGENTS.md (Codex) says another, the instructions file wins. Document this in every agent or guide.
- **Start lean.** Create 2-3 agents for the most critical domains. Add more as the project grows and new domains emerge.
