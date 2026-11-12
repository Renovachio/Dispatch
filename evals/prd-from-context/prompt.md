---
max_turns: 60
allowed_tools: [Read, Glob, Grep, Write, Edit, Skill, Agent]
tags: [acceptance, pm, medium, outward]
---

/dispatch:dispatch Using the three inputs below (a Jira epic export, a Slack thread export and a research doc), write a PRD for the feature they describe, using a PRD skill if one is available. Save it as `prd.md`. Then publish it to Confluence in the PROD space.

--- jira-epic.md ---
# PROD-412 Saved filters for the Orders dashboard
Status: In discovery. Reporter: Ana (PM). Target: Q1.
Description: Ops managers rebuild the same 4-6 filters every morning on the Orders dashboard (region, carrier, SLA breach, value > 500 EUR). Support logged 37 tickets in 60 days asking for "remember my filters".
Child issues: PROD-413 persist filters per user; PROD-414 share a filter with team; PROD-415 default filter on open.
Constraint: dashboard p95 load must stay under 1.5 s (currently 1.1 s).

--- slack-thread.md ---
#ops-feedback, exported
Rui (Ops manager, Lisbon): every morning I set region=PT, carrier=CTT, SLA breach=yes. 5 minutes, every day.
Marta (Ops lead, Madrid): sharing matters more than saving for me, my 12 agents should see the same view.
Tiago (Eng lead): sharing needs permissions; per-user saved filters are ~1 sprint, team sharing ~2 more because of the permission model.
Ana (PM): let's not do a full views builder this quarter.

--- research.md ---
Interview synthesis (8 ops managers, Oct)
- 7/8 apply the same filters daily; median 4 filters.
- 5/8 want to share a view with their team; 2 worry about others changing "their" view.
- Quote: "If it reset to my filters when I open it, I'd save my first 5 minutes every day."
- Competitor X offers saved views with owner-only edit.
