# Medium and large runs

Read this only for medium or large runs. These replace steps 4–5 of the main skill; steps 5 (outward actions), 6 and 7 still apply.

## 1. Start and write the shared context
For a **large** run, first show a one-screen brief (goal, deliverables, plan outline, outward actions, budget) and get an OK.

`run {action: start, objective, title, size}`, then write `<dir>/context.md`, which every agent reads:

```
# <title>
Objective: <the user's words, verbatim>
Deliverables: <what, format, where it goes>
Constraints: <audience, tone, length, deadlines, paths that must not change>
Sources: <exact files, URLs, issue keys, channels, doc links>
Skills: <names>; Connectors: <available / missing → fallback>
Assumptions: <each, so the user can correct them>
Decisions: <appended as the run goes>
```

## 2. Plan
- **medium**: you write 2–4 tasks.
- **large**: spawn `dispatch:planner` (`description: "[plan] Plan"`). It writes `<dir>/plan.json`; submit its tasks.

| Role | Use for |
|---|---|
| `scout` (Haiku) | files, conventions, facts a later task needs |
| `researcher` | web research with citations; never internal content |
| `writer` | documents and the final synthesis; reads internal connectors (and then loses web tools) |
| `builder` | code and file changes inside owned `paths`, with tests and checks |
| `operator` | approved outward actions only |
| `reviewer` | fresh-context review: large, risky or outward runs only |

Each task: `id`, `role`, `title`, `skills`, `paths` (builders), `depends_on`. Prefer fewer, larger tasks: every agent is a cold start. Keep web research and internal-source reading in **separate** tasks. Submit with `run {action: plan, tasks}` and fix every error. Two parallel writers may not own overlapping paths: add a dependency or merge them.

## 3. Execute in waves
Spawn every task whose dependencies are done **in one message**, in the background, `subagent_type: "dispatch:<role>"`, `description: "[<id>] <title>"`. Don't pass `model`; the mod sets the tier. Write prompts from [briefs.md](briefs.md). Record each return with `run {action: task, task, status, summary, deliverables}`. Pass later waves the **paths** to deliverables, not your summary of them. Don't open deliverables unless a decision or the synthesis needs them.

## 4. Gate quality
- **Checks**: agents run the brief's checks; re-run them yourself once.
- **Scope**: a `done` that reports `scope_violations` comes back as failed. Respawn with those files named, or ask the user.
- **Review**: `dispatch:reviewer` when the run is large or risky, or its content goes outward. Give it the criteria, `context.md` and deliverable paths, never the author's reasoning. A `VERDICT: CHANGES` sends the task back once with the exact fixes.
- **Failures**: respawn once with the exact reasons when `retry.allowed` (the mod raises the tier), otherwise ask the user: retry with a note / skip / stop. Keep partial results.

## 5. Synthesize
On multi-task runs, one `writer` builds the final deliverable from the actual files, keeping each source's specifics and reconciling contradictions explicitly.
