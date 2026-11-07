---
name: init-agents
description: Set up the .claude/agents/ system with specialized agent definitions, memory directories, routing table, and permission settings. Use when the user says "init agents", "set up agents", "add claude agents", "create agent system", "agent routing", "specialized agents", or when a project is complex enough to benefit from domain-specific agent knowledge bases.
version: 0.1.0
---

# Init Agents — Specialized Agent System

You are setting up a system of specialized Claude agents for a project. Each agent is an expert in one domain and is consulted before writing code in that domain. This prevents hallucination and enforces accuracy.

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

### Phase 3: Generate Agent Definitions

Each agent file follows this template:

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

Each agent's `MEMORY.md` starts minimal:

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

Create `.claude/settings.local.json` with appropriate permissions:

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

### Phase 6: Update CLAUDE.md

If a CLAUDE.md exists, add the agent routing table:

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

### Phase 7: Verify

1. Every agent file has valid YAML frontmatter
2. Every agent has at least 2 examples in the description
3. Every agent memory directory exists with a MEMORY.md
4. The CLAUDE.md routing table matches the agents created
5. settings.local.json is valid JSON

## Rules

- **Quality over quantity.** 3 excellent agents > 8 mediocre ones. Only create agents for domains where domain knowledge is deep and mistakes are expensive.
- **Examples are critical.** The description's examples teach Claude when to invoke the agent. Bad examples = agent never gets used.
- **Memory is for decisions.** Agent memory tracks decisions and patterns, not session transcripts. Keep it structured and concise.
- **Agents don't write code.** Agents provide guidance. The main session writes code based on that guidance.
- **CLAUDE.md is the source of truth.** If an agent says one thing and CLAUDE.md says another, CLAUDE.md wins. Document this in every agent.
- **Start lean.** Create 2-3 agents for the most critical domains. Add more as the project grows and new domains emerge.
