# Scheduled runs and queued approvals

A schedule repeats a request (usually a saved playbook) on a cadence. Unattended runs do everything up to the outward step, then queue the actions for the person to approve later. Only the mod writes `.dispatch/schedules.json`; editing it directly is blocked.

## `schedule` (no arguments) or `schedule list`
`run {action: schedule, op: list}`. Show a short table: id, what it runs, when, next run, last run.

## `schedule <what and when>`
For example "schedule the weekly status every Monday at 9".
1. Work out `request` (the user's words for the work), `every` (daily / weekdays / weekly / monthly), `at` (local "HH:MM"), `day` (weekly: 0 = Sunday … 6; monthly: 1–28) and a short `id`. If a playbook in `.dispatch/playbooks/` matches, pass its name as `playbook`. Ask only for what is missing, at most one question.
2. `run {action: schedule, op: add, id, request, every, at, day?, playbook?}`. The mod asks the person to confirm. Fix any `errors` and retry once.
3. When it is created, tell the user when it next runs and give them `unattended.crontab_line` verbatim: adding it with `crontab -e` makes it run while Claude Code is closed. Without it, a due schedule is announced the next time a session opens in this project. Never edit the crontab yourself.

`schedule pause|resume|remove <id>`: `run {action: schedule, op, id}`, one line back. After a remove, remind them to delete the crontab line.

## `run-due`
Run every due schedule, one at a time. This often runs headless, with nobody watching.
1. `run {action: schedule, op: due}`. If none are due, say so in one line and stop.
2. For each one: do a normal run of its `request` (follow its playbook if it has one), passing `schedule: <id>` to `start`. Keep runs small and inline where possible.
3. At the outward step, call `approve` as usual. If the reply says the actions are **queued**, do not spawn the operator: save the exact ready-to-send content in the run folder, then `finish` with status `done`. The mod marks the run `waiting` and notifies the person.
4. End with one line per schedule: done, waiting for approval, or failed and why.

## `approvals`
1. `run {action: list}`. Runs with `waiting_for_approval` are the ones to clear. If there are none, say so.
2. For each, newest first: `run {action: resume, run: <id>}`, then `run {action: approve_queued}`. The mod shows the person each queued action with its exact content.
3. For approved actions, add the operator task if the plan lacks one and spawn `dispatch:operator` (`description: "[<task>] …"`) with the approved actions exactly as `approve_queued` returned them. Declined actions are dropped.
4. `finish` the run and report what was sent.
