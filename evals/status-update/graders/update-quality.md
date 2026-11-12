---
type: llm
weight: 1
focus: trace
---

Success: somewhere in this transcript (the final report, a proposed Slack message, or a draft file an agent wrote) there is a concise status update for leadership with wins, risks, next week and asks. It is grounded in the tracker export: PROD-413 shipped behind a flag (win); PROD-420 p95 at 1.6 s against a 1.5 s target (risk, owner Joao); PROD-421 blocked on the CTT contract (risk or ask, owner Ines); PROD-414 waiting on security's permission-model review (owner Ines); PROD-415 next. Each risk names an owner. Reasonable inferences are fine: the reporting week, days left until a due date, who an ask is directed to, or a suggested decision. Fail only if the update invents tickets or owners, misstates a ticket's status, due date or notes, or omits most of these.
