---
type: llm
weight: 1
focus:
  source: file
  path: prd.md
---

Success: the PRD is grounded in the three inputs: it uses their specific names and numbers (PROD-412/413/414/415, 37 tickets in 60 days, 7/8 and 5/8 interview figures, the 1.5 s p95 constraint, the ~1 sprint vs ~2 more sprints estimate) and at least one user quote. It covers problem, goals and non-goals (no full views builder this quarter), users, requirements, success metrics, open questions and risks. It explicitly reconciles the tension between saving (Rui, PROD-413) and sharing (Marta, PROD-414) and the worry about others editing a shared view (owner-only edit, as Competitor X does). Fail if it is generic or misses most of these specifics.
