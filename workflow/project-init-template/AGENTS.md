# AGENTS.md - {PROJECT_NAME} Project Context

> This file is the entry point for AI agents working on {PROJECT_NAME}.
> Read this file at the start of every session.
> Last updated: {DATE}

## Project

**{PROJECT_NAME}** – {ONE_LINE_DESCRIPTION}
Tech stack: {TECH_STACK}
Target platforms: {PLATFORMS}

## Knowledge Base (Read These First)

| Document | Purpose |
|----------|---------|
| `docs/architecture.md` | Architecture decisions (ADRs), constraints, acceptance criteria |

## Directory Structure

```
{PASTE_YOUR_DIRECTORY_TREE_HERE}
```

## Architecture Constraints (MUST FOLLOW)

1. **File size**: {LANGUAGE_SPECIFIC_LIMIT}
2. **Naming**: {NAMING_CONVENTION}
3. **Data separation**: Business data must live in `data/` or equivalent subdirectory
4. **State management**: {STATE_MANAGEMENT_APPROACH}
5. **New ADRs**: When making significant architecture decisions, add an entry to `docs/architecture.md`

## When You Make Changes

- If you change a user journey flow, update `docs/architecture.md` Key User Journeys section
- If you add a new module/file, update the Directory Structure above
- If you change an architecture constraint, document it as a new ADR

## Output Format

Always begin response with: `> {PROJECT_NAME} Agent running...`
