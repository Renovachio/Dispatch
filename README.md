# Dispatch

Adaptive multi-agent orchestration for Claude Code. Give it any request (code, PM documents, research, actions in Slack/Jira/Drive/Notion or the browser) and it sizes the work, runs the fewest role agents with the right skills, checks quality, asks before anything leaves your machine, and shows live cost.

```
/dispatch:dispatch Write a PRD for saved filters from PROD-412, the #ops-feedback thread and the research doc, then publish it to Confluence
```

## How it works

| Size | What runs | Typical use |
|---|---|---|
| trivial | the lead answers directly, no agents | a lookup, a quick rewrite |
| small | the lead itself (inline), or 1 role agent when isolation pays | a scoped code change, one document, a status update |
| medium | 2–4 agents planned by the lead | research → write → publish |
| large | an Opus planner, parallel waves, an independent reviewer | multi-part, cross-domain or high-stakes work |

- **Roles** (`agents/`): scout (Haiku), researcher, writer, builder, operator, reviewer (Sonnet; Opus for large runs), planner (Opus). The lead runs on Sonnet. A failed task retries once, one tier up, then asks you.
- **Skills**: the plan names the exact installed skills each task loads (for example a PRD skill for the writer). Missing skills or connectors are reported, and Dispatch falls back to something else, such as a local file instead of Confluence.
- **Quality**: checks always run; a fresh-context reviewer runs on large, risky or outward work. Agents ground claims in named sources, and all agents share one `context.md`, so details aren't lost between tasks.
- **Safety, enforced in code** (`hooks/register.tsx`):
  - Only `dispatch:operator` can call tools that change things outside your machine, and only with arguments you approved exactly. Approval happens in a dialog the mod opens, never through the model. Each approval works once.
  - Shell commands that publish or push are blocked for the other roles.
  - Builders can edit only the paths their task owns.
  - Data rule: researchers can't read internal connectors. Once any agent (or the lead) has read internal content, its web tools are switched off. You can allow internal content on the web for a run, but only in a dialog the mod opens, never through the model.
  - Scope check: in git projects, when a task that owns files finishes, any file changed since the run started that no task owns (shell writes included) fails the task.
- **Cost**: budgets in weighted tokens by run size (small 150k, medium 600k, large 2M, placeholders until evals tune them). At the cap Dispatch pauses and asks. Reports show tokens and an API-price $ equivalent.
- **Panel**: `/dispatch-panel` opens a live view beside the chat with tasks, agents, model tiers, tokens, $ and budget.

## Commands

`/dispatch:dispatch <request>` · `… status` · `… resume [run]` · `… runs` · `… learn <text>` · `… playbooks` · `… schedule [what and when]` · `… run-due` · `… approvals`

## Scheduled runs

```
/dispatch:dispatch schedule the weekly status every Monday at 9
```

- You confirm every new schedule in a dialog the mod opens. The model can't create or edit schedules, and agents can't write `.dispatch/schedules.json`, even outside a run.
- Dispatch replies with a crontab line. Add it with `crontab -e` to run the schedule while Claude Code is closed. Cron starts `bin/dispatch-run-due <project>`, a headless `claude -p` run. Without the line, a due schedule is announced the next time you open a session in the project.
- A scheduled run does all the work up to the outward step, such as posting to Slack. Nobody is there to approve, so the action is **queued**: the run ends as `waiting`, and the next session you open in the project tells you so (plus a desktop notification where one can be shown). `/dispatch:dispatch approvals` shows you each queued action with its exact content. Only approved actions are sent, once, by the operator.
- If several slots were missed (laptop asleep), the schedule runs once, not once per slot. Pausing and resuming skips the slots missed while paused.
- On macOS, cron may need Full Disk Access (System Settings → Privacy & Security) to reach projects in `~/Documents`. The runner logs to `.dispatch/runs/scheduled.log`.
- Headless runs only get the tools granted in `bin/dispatch-run-due` and in the project's permission settings. Add the read tools of the connectors your playbook needs to `.claude/settings.json`.

## Files it keeps

- `<project>/.dispatch/runs/<id>/`: run state (`run.json`), `context.md`, each task's deliverables. Git-ignored automatically, so personal and never committed. Keeping them in the project means agents write without permission prompts.
- `<project>/.dispatch/schedules.json`: your schedules. Personal and git-ignored, so teammates don't run each other's schedules.
- `<project>/.dispatch/learnings.md` and `playbooks/`: team knowledge, committed and reviewed like code.
- Config layers, later ones overriding earlier ones: `config/defaults.json` → team file (`$DISPATCH_TEAM_CONFIG` or `config/team.json`) → `<project>/.dispatch/config.json` → `~/.dispatch/config.json`. A layer can `lock` keys (for example `"locked": ["budgets.large", "outward.allow_actions"]`).

Run folders left by the older Dispatch (Orchestrator) in a project's `.dispatch/` are ignored.

## Install

Teammates (private repo, needs GitHub access):

```
/plugin marketplace add Renovachio/Dispatch
/plugin install dispatch@dispatch
```

Development: `claude --plugin-dir ~/Documents/Dispatch`.

## Develop

```
claude plugin validate .     # manifest, hooks module, types contract
claude plugin test .         # unit + engine tests (hooks/*.test.tsx)
claude plugin eval . --allow-tools Edit Write "Bash(python3:*)" "Bash(python:*)" mcp__dispatch__run   # acceptance suite vs no-plugin baseline
```

Type-checking (`tsc -p .`) needs Node.js.

### Eval results (2026-11-12, Sonnet lead)

| Case (runs per arm) | Dispatch | Plain Claude | Cost per run, Dispatch vs plain |
|---|---|---|---|
| feature-small (3), inline builder | 0.67 | 0.67 | $0.12 vs $0.13 (0.92×) |
| status-update (3), inline writer, no Slack connector in the sandbox | 1.00 | 1.00 | $0.10 vs $0.11 (0.91×) |
| prd-from-context (2) | 0.50 | 0.00 | $0.12 vs $0.20 (0.60×) |
| research-report (2) | not graded (usage limit hit mid-run) | | |

History: the first version cost 2.6× plain Claude on feature-small. Inline small tasks and the slimmer skill brought it under 1×. Judge votes on single runs are noisy, so read scores across runs.
