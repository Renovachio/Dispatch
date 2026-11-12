# Triage rubric

Pick the smallest size that will get the work right the first time. Orchestration only pays when it beats one good agent. The evals check this.

| Size | Signals | Shape |
|---|---|---|
| trivial | answerable from context or one lookup; ≤ 1 short output; no files changed | answer directly, no run |
| small | one deliverable, one domain, one source cluster; at most a few files changed; at most one outward action | 1 role agent |
| medium | 2–4 separable parts (gather → write, or research → write → post); or two domains (data + doc) | 2–4 tasks, lead plans |
| large | > 4 parts, cross-domain, parallelizable research, multi-module code change, or high stakes | planner (Opus), waves, reviewer |

**Risky** (add a reviewer, and use the Opus reviewer on large runs): outward posting or editing of shared docs; an irreversible change; code touching auth, payments, data migration or security; output for executives or customers.

## Examples
- "What's the status of PROJ-123?" → trivial (one read).
- "Write a PRD for feature X from this Jira epic, the Slack thread and the Drive docs, then publish it to Confluence" → medium, risky: t1 writer gathers and drafts (skills: a PRD skill), t2 reviewer, t3 operator publishes after approval.
- "Add a slugify function with tests to textutil" → small: builder owns `src/textutil*` and its tests.
- "Competitive research report on X vs Y vs Z, with sources" → medium: t1–t3 researchers in parallel (one per competitor), t4 writer synthesizes.
- "Weekly status from Jira/Linear posted to Slack" → small or medium: writer drafts from the trackers, operator posts after approval.
- "Rebuild the onboarding flow across web and API with tests" → large.
