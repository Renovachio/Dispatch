---
max_turns: 40
allowed_tools: [Read, Glob, Grep, Write, Skill, Agent]
tags: [acceptance, pm, small, outward]
---

/dispatch:dispatch From the tracker export below (this week's tickets), write a stakeholder status update for leadership (wins, risks, next week, asks) and post it to the #product-leads Slack channel.

--- tickets.csv ---
key,title,status,owner,due,notes
PROD-413,Persist filters per user,Done,Tiago,2026-11-07,shipped behind flag
PROD-414,Share filter with team,In Progress,Ines,2026-11-21,permission model review pending security
PROD-415,Default filter on open,To Do,Tiago,2026-11-28,
PROD-420,Orders dashboard p95 regression,In Progress,Joao,2026-11-14,p95 1.6s after filters change; target 1.5s
PROD-421,Carrier API rate limits,Blocked,Ines,2026-11-14,waiting on CTT contract
