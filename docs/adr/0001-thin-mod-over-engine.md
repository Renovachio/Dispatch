# 1. Prompt-driven lead + thin enforcing mod, not a deterministic engine

Status: accepted (2026-11-12)

## Context
The previous Dispatch (a 244 KB Python engine) decided every step in code and ran define → plan → judge on every request. Its runs were expensive (one definer step used about 49k tokens), hard to change, and ended suspended or cancelled. The user ranked cost, output quality and complexity as the main pains.

## Decision
- Orchestration logic lives in `skills/dispatch/SKILL.md`, which the lead model follows, with adaptive triage so small requests pay for one agent or none.
- The invariants that must hold however the model behaves are enforced by a small TypeScript mod (`hooks/register.tsx`, `src/`):
  - outward actions are operator-only and must match an approval exactly; each approval works once;
  - approvals are asked by the mod itself (`$.ui.ask`), never recorded by the model;
  - owned paths, shell publishing blocks and the data rule;
  - model tier per role and retry escalation (an `agent.spawn` rewrite);
  - budgets: counted from `turn.complete` usage per agent, with a pause-and-ask gate at spawn.
- Agents run as native in-session subagents, so they inherit skills, connectors and permissions.

## Consequences
- Far less code. Behaviour changes are mostly prompt edits, measured by `claude plugin eval` against a no-plugin baseline.
- Step ordering is not enforced in code; the evals and the mod's invariants catch the failures that matter.
- An organisation policy that disables plugin mods also disables enforcement. The skill still works, but nothing is guarded. The README says so.
