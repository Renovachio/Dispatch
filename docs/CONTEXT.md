# Dispatch domain language

- **Lead**: the main Claude Code session running the `dispatch` skill (pinned to Sonnet). Triages, plans, spawns, gates and reports; never acts outward.
- **Run**: one request handled end to end. State lives in `<project>/.dispatch/runs/<id>/run.json` (git-ignored), written only by the mod.
- **Size**: trivial / small / medium / large; sets the shape (no agents / 1 / 2–4 / planner + waves + reviewer) and the budget.
- **Risky**: outward, irreversible, high-stakes code, or exec/customer-facing; adds a reviewer.
- **Task**: one unit of work for one **role** agent, with skills, owned paths, criteria and checks.
- **Role**: scout, researcher, writer, builder, operator, reviewer, planner (`dispatch:<role>`).
- **Tier**: haiku / sonnet / opus. Set per role by config; a retry moves one tier up.
- **Context file**: `context.md` in the run folder. The single shared source of objective, constraints, sources, assumptions and decisions.
- **Outward action**: any call that changes something outside this machine. Proposed by any role, approved by the person in a mod dialog, executed exactly once by the operator.
- **Weighted tokens**: the budget unit. Input + output + cache writes + 10% of cache reads, times the tier weight (haiku 0.05, sonnet 1, opus 2).
- **Learning**: one curated line in the project's `.dispatch/learnings.md`. **Playbook**: a saved, reusable plan for a recurring kind of request.
- **Schedule**: a request (often a playbook) repeated daily, on weekdays, weekly or monthly at a local time. Created only with the person's confirmation; kept in `.dispatch/schedules.json` (personal).
- **Queued action**: an outward action proposed when nobody could be asked (a scheduled or headless run). It waits in the run until the person approves or declines it in `approvals`; queued is never approved.
- **Waiting run**: a finished run with queued actions. `approvals` resumes it, asks the person, and the operator sends what was approved.
