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
  - Researchers can't read internal connectors unless the run allows it.
- **Cost**: budgets in weighted tokens by run size (small 150k, medium 600k, large 2M, placeholders until evals tune them). At the cap Dispatch pauses and asks. Reports show tokens and an API-price $ equivalent.
- **Panel**: `/dispatch-panel` opens a live view beside the chat with tasks, agents, model tiers, tokens, $ and budget.

## Commands

`/dispatch:dispatch <request>` · `… status` · `… resume [run]` · `… runs` · `… learn <text>` · `… playbooks`

## Files it keeps

- `<project>/.dispatch2/runs/<id>/`: run state (`run.json`), `context.md`, each task's deliverables. Git-ignored automatically, so personal and never committed. Keeping them in the project means agents write without permission prompts.
- `<project>/.dispatch2/learnings.md` and `playbooks/`: team knowledge, committed and reviewed like code.
- Config layers, later ones overriding earlier ones: `config/defaults.json` → team file (`$DISPATCH_TEAM_CONFIG` or `config/team.json`) → `<project>/.dispatch2/config.json` → `~/.dispatch2/config.json`. A layer can `lock` keys (for example `"locked": ["budgets.large", "outward.allow_actions"]`).

(`.dispatch2` is the name while the old Dispatch skill is still installed. It becomes `.dispatch` when the old one is retired.)

## Install

Teammates (private repo, needs GitHub access):

```
/plugin marketplace add <org>/dispatch
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

### Eval results (2026-11-12, 3 runs per arm, Sonnet lead)

| Case | Dispatch | Plain Claude | Cost per run, Dispatch vs plain |
|---|---|---|---|
| feature-small (inline builder) | 1.00 | 1.00 | $0.10 vs $0.12 (0.83×) |
| status-update (inline writer, no Slack connector in the sandbox) | 0.67 | 0.67 | $0.14 vs $0.10 (1.48×) |

Before inline small tasks, feature-small cost 2.6× plain Claude ($0.34 vs $0.13). The prd-from-context and research-report cases have not been run yet.
