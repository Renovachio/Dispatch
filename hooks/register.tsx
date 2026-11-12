// Dispatch mod: run state tool, policy enforcement on spawns and tool calls,
// per-agent cost tracking, and the live panel beside the chat.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Role, Run, Schedule, Size, TaskStatus } from '../types'
import { loadConfig, type Config } from '../src/config'
import { addUsage, dollars, formatTokens, tierOf, zeroUsage } from '../src/cost'
import { callArgs, decide, destinationAllowed, guardState, isInternalRead, isOwnTool } from '../src/policy'
import { checkSchedule, cronLine, describe, isDue, loadSchedules, localOffset, nextSlot, saveSchedules, type ScheduleInput } from '../src/schedule'
import {
  canonical,
  checkPlan,
  escalate,
  listRuns,
  loadRun,
  log,
  newRun,
  projectDir,
  recentRuns,
  leadDollars,
  leadUsageByTier,
  parsePorcelain,
  relativeToProject,
  runsDir,
  runUsage,
  saveRun,
  scopeViolations,
  setPlan,
  taskFromDescription,
  type TaskInput,
} from '../src/state'

const PANE = 'dispatch-run'
const TOOL = 'run'
const ROLES: readonly Role[] = ['scout', 'researcher', 'builder', 'writer', 'operator', 'reviewer', 'planner']
const SIZES: readonly Size[] = ['small', 'medium', 'large']

const runAtom = atom({ plugin: 'dispatch', key: 'run' } as const, null as Run | null, { shape: 'run-1' })

let cfgCache: Config | undefined
async function cfg($: EngineInterface): Promise<Config> {
  cfgCache ??= await loadConfig($)
  return cfgCache
}

async function current($: EngineInterface): Promise<Run | null> {
  return read($, runAtom)
}

/** Apply `fn` to the active run, keep it in session state and on disk. */
async function mutate($: EngineInterface, fn: (run: Run, now: number) => Run): Promise<Run | null> {
  const now = await $.clock.now()
  let saved: Run | null = null
  await update($, runAtom, run => {
    if (!run) return run
    saved = fn(run, now)
    return saved
  })
  if (saved) await saveRun($, saved)
  return saved
}

/** Changed files in the project's git work tree, or undefined outside git. */
async function gitChanged($: EngineInterface, project: string): Promise<string[] | undefined> {
  try {
    // Porcelain paths are relative to the repository root; the project can be a subfolder of it.
    const prefix = await $.process.run(['git', 'rev-parse', '--show-prefix'], { cwd: project, timeoutMs: 15000 })
    if (prefix.exitCode !== 0) return undefined
    const r = await $.process.run(['git', 'status', '--porcelain=v1', '-uall'], { cwd: project, timeoutMs: 15000 })
    return r.exitCode === 0 ? relativeToProject(parsePorcelain(r.stdout), prefix.stdout.trim()) : undefined
  } catch {
    return undefined
  }
}

/**
 * Ask the person directly (never the model). Resolves their pick ('' when dismissed), or null when
 * nobody can be asked (a headless or scheduled run). Callers treat both as "no" unless they queue.
 */
async function ask($: EngineInterface, question: string, options: { options: string[]; header: string }): Promise<string | null> {
  try {
    return await $.ui.ask(question, options)
  } catch {
    return null
  }
}

async function notify($: EngineInterface, text: string): Promise<void> {
  try {
    await $.ui.notify(text, { title: 'Dispatch' })
  } catch {
    // No surface to notify (headless); the next session start shows it.
  }
}

const RUNNER = 'bin/dispatch-run-due'


const isActive = (run: Run | null): run is Run => !!run && (run.status === 'active' || run.status === 'paused')

const TOOL_DESCRIPTION = `Dispatch run state. Only use while running the /dispatch skill. Call with {"action": ...}:
- start {objective, title, size: small|medium|large, allow_internal_to_web?} → run id, folder, budget
- plan {tasks: [{id, role, title, skills?, paths?, depends_on?, inline?}]} → tiers per task, or plan errors (inline: small runs, builder/writer, the lead does it)
- task {task, status: running|done|failed|skipped, summary?, deliverables?} → on failed: whether one retry is allowed and at which tier
- approve {task, actions: [{tool, args, summary, target?}]} → asks the person for each exact action; returns ids approved/declined. Use tool "browser" with args {} for a browser session.
- status → usage, cost, tasks, agents
- finish {status: done|failed|cancelled, summary} → final cost report
- resume {run?} → reattach a run (id, part of an id, or latest)
- list → recent runs
- learn {kind: learning|playbook, text, name?} → save to the project's Dispatch folder
- schedule {op: add, id, request, every: daily|weekdays|weekly|monthly, at: "HH:MM", day?, playbook?} → asks the person, returns a crontab line for unattended runs
- schedule {op: list|due} · schedule {op: remove|pause|resume, id}
- start {..., schedule: id} → a run for a due schedule. With nobody to ask, approve queues actions and finish leaves the run "waiting"
- approve_queued → on a resumed waiting run: asks the person for each queued action; returns ids approved/declined
Spawn role agents as subagent_type "dispatch:<role>" with description "[<task id>] <title>".`

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['start', 'plan', 'task', 'approve', 'approve_queued', 'status', 'finish', 'resume', 'list', 'learn', 'schedule'] },
    objective: { type: 'string' },
    title: { type: 'string' },
    size: { type: 'string', enum: SIZES },
    allow_internal_to_web: { type: 'boolean' },
    tasks: { type: 'array', items: { type: 'object' } },
    task: { type: 'string' },
    status: { type: 'string' },
    summary: { type: 'string' },
    deliverables: { type: 'array', items: { type: 'string' } },
    actions: { type: 'array', items: { type: 'object' } },
    run: { type: 'string' },
    kind: { type: 'string', enum: ['learning', 'playbook'] },
    text: { type: 'string' },
    name: { type: 'string' },
    op: { type: 'string', enum: ['add', 'list', 'due', 'remove', 'pause', 'resume'] },
    schedule: { type: 'string' },
    id: { type: 'string' },
    request: { type: 'string' },
    playbook: { type: 'string' },
    every: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly'] },
    at: { type: 'string' },
    day: { type: 'number' },
  },
  required: ['action'],
}

function report(run: Run, c: Config) {
  const u = runUsage(run, c)
  return {
    run: run.id,
    status: run.status,
    size: run.size,
    budget: { used: u.weighted, limit: run.budget, pct: Math.round((100 * u.weighted) / Math.max(1, run.budget)) },
    usd_equivalent: u.usd,
    tokens: u.total,
    tasks: run.order.flatMap(id => {
      const t = run.tasks[id]
      if (!t) return []
      return { id, role: t.role, tier: t.tier, status: t.status, attempts: t.attempts, deliverables: t.deliverables }
    }),
    agents: Object.values(run.agents).map(a => ({
      task: a.task,
      role: a.role,
      tier: a.tier,
      status: a.status,
      tokens: a.usage.input_tokens + a.usage.output_tokens + a.usage.cache_read_input_tokens + a.usage.cache_creation_input_tokens,
      usd: dollars(a.usage, a.tier, c),
    })),
    lead: { tier: run.leadTier, tiers: leadUsageByTier(run).map(([t]) => t), usd: Math.round(leadDollars(run, c) * 100) / 100 },
  }
}

async function handleSchedule($: EngineInterface, c: Config, e: Record<string, unknown>, now: number): Promise<unknown> {
  const op = String(e.op ?? 'list')
  const list = await loadSchedules($, c)
  const offset = localOffset(now)
  const view = (s: Schedule) => ({
    id: s.id,
    request: s.request,
    playbook: s.playbook,
    when: describe(s),
    enabled: s.enabled,
    due: isDue(s, now, offset),
    next: s.enabled ? new Date(nextSlot(s, now, offset) ?? now).toISOString() : undefined,
    last_run: s.lastRunId,
  })
  if (op === 'list') return { schedules: list.map(view) }
  if (op === 'due') return { due: list.filter(s => isDue(s, now, offset)).map(view) }

  if (op === 'add') {
    const input: ScheduleInput = {
      id: typeof e.id === 'string' ? e.id : undefined,
      request: typeof e.request === 'string' ? e.request : undefined,
      playbook: typeof e.playbook === 'string' ? e.playbook : undefined,
      every: typeof e.every === 'string' ? e.every : undefined,
      at: typeof e.at === 'string' ? e.at : undefined,
      day: typeof e.day === 'number' ? e.day : undefined,
    }
    const errors = checkSchedule(input, list)
    if (errors.length) return { errors }
    const s: Schedule = {
      id: input.id!,
      request: input.request!.trim(),
      playbook: input.playbook,
      every: input.every as Schedule['every'],
      at: input.at!,
      day: input.every === 'weekly' || input.every === 'monthly' ? input.day : undefined,
      enabled: true,
      createdAt: now,
    }
    // A schedule starts runs nobody watches, so the person creates it, never the model.
    const answer = await ask(
      $,
      `Dispatch wants to run this ${describe(s)} in ${await $.session.cwd()}:\n\n"${s.request}"${s.playbook ? `\n(playbook: ${s.playbook})` : ''}\n\nScheduled runs never act outside this machine on their own: outward actions wait for your approval.`,
      { options: ['Create schedule', 'Cancel'], header: 'Schedule' },
    )
    if (answer !== 'Create schedule') return { created: false, note: answer === null ? 'schedules can only be created in an interactive session' : 'the person declined' }
    await saveSchedules($, c, [...list, s])
    const runner = `${$.plugin.root}/${RUNNER}`
    return {
      created: true,
      schedule: view(s),
      unattended: {
        // A development checkout (--plugin-dir) is not installed, so the headless run must be told where it is.
        crontab_line: cronLine(s, runner, await $.session.cwd(), $.plugin.root.includes('/.claude/plugins/') ? undefined : $.plugin.root),
        note: 'For runs while Claude Code is closed, the person adds this line with `crontab -e`. Otherwise a due schedule is announced when a session opens here.',
      },
    }
  }

  const s = list.find(x => x.id === e.id)
  if (!s) return { error: `no schedule ${String(e.id)}` }
  if (op === 'remove') {
    await saveSchedules($, c, list.filter(x => x.id !== s.id))
    return { removed: s.id, note: 'Remove its crontab line too, if one was added.' }
  }
  if (op === 'pause' || op === 'resume') {
    // Resuming re-arms from now, so slots missed while paused do not fire.
    await saveSchedules($, c, list.map(x => (x.id === s.id ? { ...x, enabled: op === 'resume', lastRunAt: op === 'resume' ? now : x.lastRunAt } : x)))
    return { schedule: s.id, enabled: op === 'resume' }
  }
  return { error: `unknown op ${op}` }
}

/** What waits for the person in this project: due schedules and runs with queued actions. */
async function pending($: EngineInterface): Promise<{ due: string[]; waiting: string[] }> {
  const c = await cfg($)
  // Read-only: a session in a project Dispatch never ran in must leave no trace.
  if (!(await $.fs.exists(await projectDir($, c)))) return { due: [], waiting: [] }
  const now = await $.clock.now()
  const due = (await loadSchedules($, c)).filter(s => isDue(s, now, localOffset(now))).map(s => s.id)
  const waiting = (await recentRuns($, c, 20)).filter(r => r.status === 'waiting').map(r => r.title)
  return { due, waiting }
}

async function announce($: EngineInterface): Promise<void> {
  try {
    const { due, waiting } = await pending($)
    const parts = []
    if (waiting.length) parts.push(`${waiting.length} run${waiting.length > 1 ? 's' : ''} waiting for approval (/dispatch:dispatch approvals)`)
    if (due.length) parts.push(`due: ${due.join(', ')} (/dispatch:dispatch run-due)`)
    $.ui.status(parts.length ? `Dispatch: ${parts.join(' · ')}` : undefined)
    if (parts.length) await notify($, parts.join('. '))
  } catch {
    // Never block a session over a reminder.
  }
}

async function handle($: EngineInterface, e: Record<string, unknown>): Promise<unknown> {
  const c = await cfg($)
  const action = String(e.action ?? '')
  const now = await $.clock.now()

  if (action === 'start') {
    const size = SIZES.includes(e.size as Size) ? (e.size as Size) : 'small'
    const objective = String(e.objective ?? '')
    if (!objective) return { error: 'objective is required' }
    const prev = await current($)
    if (isActive(prev)) return { error: `run ${prev.id} is still active: finish it first`, run: prev.id }
    const run = newRun({
      now,
      objective,
      title: String(e.title ?? objective).slice(0, 80),
      size,
      project: await $.session.cwd(),
      runsDir: await runsDir($, c),
      cfg: c,
      leadModel: await $.session.model(),
    })
    // Loosening the data rule is the person's call, never the model's.
    if (e.allow_internal_to_web === true && !run.allowInternalToWeb) {
      const answer = await ask(
        $,
        `Dispatch run "${run.title}" wants web-research agents to see content from internal connectors (Jira, Slack, Drive...). Allow it for this run?`,
        { options: ['Keep internal content internal', 'Allow for this run'], header: 'Data rule' },
      )
      run.allowInternalToWeb = answer === 'Allow for this run'
    }
    if (typeof e.schedule === 'string') {
      const list = await loadSchedules($, c)
      const s = list.find(x => x.id === e.schedule)
      if (!s) return { error: `no schedule ${e.schedule}` }
      run.schedule = s.id
      await saveSchedules($, c, list.map(x => (x.id === s.id ? { ...x, lastRunAt: now, lastRunId: run.id } : x)))
    }
    run.baseline = await gitChanged($, run.project)
    await update($, runAtom, () => run)
    await saveRun($, run)
    void $.ui.open({ id: PANE, title: 'Dispatch' })
    return { run: run.id, dir: run.dir, context_file: `${run.dir}/context.md`, budget: run.budget, size }
  }

  if (action === 'list') {
    const rows = (await recentRuns($, c, 10)).map(r => ({
      id: r.id,
      status: r.status,
      size: r.size,
      title: r.title,
      usd: runUsage(r, c).usd,
      waiting_for_approval: r.approvals.filter(a => a.queued).length || undefined,
    }))
    return { runs: rows }
  }

  if (action === 'resume') {
    const dir = `${await projectDir($, c)}/runs`
    const want = String(e.run ?? 'latest')
    const ids = (await listRuns($, c)).filter(x => want === 'latest' || x.includes(want))
    let run: Run | undefined
    for (const id of ids) if ((run = await loadRun($, `${dir}/${id}`))) break
    if (!run) return { error: `no readable run matches ${want}` }
    const resumed = log({ ...run, status: run.status === 'paused' || run.status === 'waiting' ? 'active' : run.status, leadPending: false }, now, 'resume')
    await update($, runAtom, () => resumed)
    await saveRun($, resumed)
    void $.ui.open({ id: PANE, title: 'Dispatch' })
    const queued = resumed.approvals.filter(a => a.queued).map(a => ({ id: a.id, task: a.task, tool: a.tool, summary: a.summary }))
    return { ...report(resumed, c), objective: resumed.objective, context_file: `${resumed.dir}/context.md`, log: resumed.log.slice(-15), queued: queued.length ? queued : undefined }
  }

  if (action === 'schedule') return handleSchedule($, c, e, now)

  const run = await current($)
  if (!run) return { error: 'no active run: start one, or resume' }

  if (action === 'status') return report(run, c)

  if (action === 'plan') {
    const tasks = (Array.isArray(e.tasks) ? e.tasks : []) as TaskInput[]
    const bad = tasks.filter(t => !ROLES.includes(t.role)).map(t => `${t.id}: unknown role ${t.role}`)
    const errors = [...bad, ...checkPlan([...Object.values(run.tasks).filter(t => !tasks.some(n => n.id === t.id)), ...tasks], run.size)]
    if (errors.length) return { errors }
    const next = await mutate($, r => setPlan(r, tasks, c, now))
    return { tasks: next!.order.map(id => ({ id, role: next!.tasks[id]?.role, tier: next!.tasks[id]?.tier })) }
  }

  if (action === 'task') {
    const id = String(e.task ?? '')
    const status = String(e.status ?? '') as TaskStatus
    const current = run.tasks[id]
    if (!current) return { error: `unknown task ${id}` }
    if (status === 'running' && current.inline) {
      const other = Object.values(run.tasks).find(t => t.inline && t.status === 'running' && t.id !== id)
      if (other) return { error: `inline task ${other.id} is still running; finish it first` }
    }
    // Scope check: a task that changes files must not have touched anything no task owns.
    let violations: string[] = []
    let effective = status
    let reason = typeof e.summary === 'string' ? e.summary : undefined
    if (status === 'done' && run.baseline && current.paths.length > 0) {
      const changed = await gitChanged($, run.project)
      violations = changed ? scopeViolations(changed, run, c.storage.project) : []
      if (violations.length) {
        effective = 'failed'
        reason = `changed files outside every task's owned paths: ${violations.slice(0, 10).join(', ')}. Revert them or ask the person.`
      }
    }
    let retry: { allowed: boolean; tier?: string } | undefined
    const next = await mutate($, r => {
      const t = r.tasks[id]
      if (!t) return r
      const failed = effective === 'failed'
      const attempts = failed ? t.attempts + 1 : t.attempts
      const canRetry = failed && attempts <= c.retries.max
      const tier = canRetry && c.retries.escalate ? escalate(t.tier ?? 'sonnet', c) : t.tier
      if (failed) retry = canRetry ? { allowed: true, tier } : { allowed: false }
      return log(
        {
          ...r,
          tasks: {
            ...r.tasks,
            [id]: {
              ...t,
              status: canRetry ? 'planned' : effective,
              attempts,
              tier,
              summary: reason ?? t.summary,
              deliverables: Array.isArray(e.deliverables) ? (e.deliverables as string[]) : t.deliverables,
            },
          },
        },
        now,
        `task ${id} ${effective}${failed ? ` (attempt ${attempts})` : ''}${violations.length ? ' scope violation' : ''}`,
      )
    })
    return {
      task: id,
      status: next!.tasks[id]?.status,
      retry,
      scope_violations: violations.length ? violations : undefined,
      reason: violations.length ? reason : undefined,
      budget: report(next!, c).budget,
    }
  }

  if (action === 'approve') {
    const id = String(e.task ?? '')
    const actions = (Array.isArray(e.actions) ? e.actions : []) as { tool: string; args?: unknown; summary?: string; target?: string }[]
    const results: { id: string; tool: string; approved: boolean; note?: string }[] = []
    for (const [i, a] of actions.entries()) {
      const aid = `${id}-a${run.approvals.length + i + 1}`
      if (!destinationAllowed(a.target, c)) {
        results.push({ id: aid, tool: a.tool, approved: false, note: `destination ${a.target} is not permitted by team config` })
        continue
      }
      const args = canonical(a.args ?? {})
      const shown = args.length > 1500 ? `${args.slice(0, 1500)}… (${args.length} chars)` : args
      const answer = await ask(
        $,
        `Dispatch wants to act outside this machine.\n\n${a.summary ?? a.tool}\n\nTool: ${a.tool}\nTarget: ${a.target ?? '—'}\nExact content:\n${shown}`,
        { options: ['Approve', 'Decline'], header: 'Approve?' },
      )
      const queued = answer === null
      const approved = answer === 'Approve'
      results.push({ id: aid, tool: a.tool, approved, note: queued ? 'queued: nobody can be asked now; the person approves it later' : undefined })
      await mutate($, r =>
        log(
          { ...r, approvals: [...r.approvals, { id: aid, task: id, tool: a.tool, args, summary: a.summary ?? '', approved, used: false, queued: queued || undefined }] },
          now,
          `approval ${aid} ${a.tool}: ${queued ? 'queued' : approved ? 'approved' : 'declined'}`,
        ),
      )
    }
    if (results.some(r => r.note?.startsWith('queued'))) {
      return {
        approvals: results,
        note: 'Nobody can approve right now. Do not spawn the operator: write the ready-to-send content to the run folder, then finish. The run waits until the person runs /dispatch:dispatch approvals.',
      }
    }
    return { approvals: results, note: 'Pass approved actions to dispatch:operator with their exact tool and args; any change is blocked.' }
  }

  if (action === 'approve_queued') {
    const pending = run.approvals.filter(a => a.queued)
    if (!pending.length) return { error: 'this run has no queued actions' }
    const results: { id: string; task: string; tool: string; approved: boolean; args?: unknown }[] = []
    for (const a of pending) {
      const shown = a.args.length > 1500 ? `${a.args.slice(0, 1500)}… (${a.args.length} chars)` : a.args
      const answer = await ask(
        $,
        `A scheduled Dispatch run ("${run.title}") queued this action while you were away.\n\n${a.summary || a.tool}\n\nTool: ${a.tool}\nExact content:\n${shown}`,
        { options: ['Approve', 'Decline'], header: 'Approve?' },
      )
      if (answer === null) return { error: 'queued actions can only be approved in an interactive session' }
      const approved = answer === 'Approve'
      results.push({ id: a.id, task: a.task, tool: a.tool, approved, args: approved ? JSON.parse(a.args) : undefined })
      await mutate($, r =>
        log({ ...r, approvals: r.approvals.map(x => (x.id === a.id ? { ...x, approved, queued: undefined } : x)) }, now, `approval ${a.id} ${a.tool}: ${approved ? 'approved' : 'declined'} (queued)`),
      )
    }
    void announce($)
    return { approvals: results, note: 'Spawn dispatch:operator with the approved actions exactly as listed here (tool and args unchanged); then finish.' }
  }

  if (action === 'finish') {
    const asked = (['done', 'failed', 'cancelled'].includes(String(e.status)) ? e.status : 'done') as Run['status']
    const waiting = asked === 'done' && run.approvals.some(a => a.queued)
    const status: Run['status'] = waiting ? 'waiting' : asked
    if (waiting) void notify($, `"${run.title}" is ready and waiting for your approval: /dispatch:dispatch approvals`)
    const next = await mutate($, r => log({ ...r, status, leadPending: true, summary: typeof e.summary === 'string' ? e.summary : r.summary }, now, `finish ${status}`))
    return { ...report(next!, c), note: "The lead's current turn is added to the cost when it ends; `status` shows the final figure." }
  }

  if (action === 'learn') {
    const text = String(e.text ?? '').trim()
    if (!text) return { error: 'text is required' }
    const base = `${run.project}/${c.storage.project}`
    if (e.kind === 'playbook') {
      const name = String(e.name ?? run.title).toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const path = `${base}/playbooks/${name}.md`
      await $.fs.write(path, text.endsWith('\n') ? text : `${text}\n`)
      return { saved: path }
    }
    const path = `${base}/learnings.md`
    const prev = (await $.fs.exists(path)) ? await $.fs.read(path) : '# Dispatch learnings\n\nCurated, short. Newest first. Remove what stops being true.\n'
    const [head, ...rest] = prev.split('\n\n')
    const entry = `- ${new Date(now).toISOString().slice(0, 10)} (${run.id}): ${text}`
    await $.fs.write(path, [head, entry, ...rest].join('\n\n').replace(/\n{3,}/g, '\n\n'))
    return { saved: path }
  }

  return { error: `unknown action ${action}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({ name: TOOL, description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    await $.command.register({ name: 'dispatch-panel', description: 'Open the Dispatch run panel' })
    void announce($)
    return started
  })

  on('command.run', { command: 'dispatch-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Dispatch' })
    return { text: 'Dispatch panel opened.' }
  })

  // The run tool, and every other call checked against policy while a run is active.
  on('tool.call', async ($, e, next) => {
    const raw = e as unknown as Record<string, unknown>
    if (isOwnTool(e.tool)) {
      const args = callArgs(raw)
      // Only the lead steers a run; a role agent may read its status, nothing else.
      if (e.agentId && args.action !== 'status') {
        return { result: JSON.stringify({ error: 'Only the Dispatch lead may change a run. Report back in your result instead.' }) }
      }
      try {
        return { result: JSON.stringify(await handle($, args), null, 1) }
      } catch (err) {
        return { result: JSON.stringify({ error: String(err) }) }
      }
    }
    const guard = guardState(e.tool, callArgs(raw))
    if (!guard.allow) return { deny: guard.reason }
    const run = await current($)
    if (!isActive(run)) return next(e)
    const c = await cfg($)
    const verdict = decide(run, c, { tool: e.tool, agentId: e.agentId, input: callArgs(raw) })
    if (!verdict.allow) {
      await mutate($, (r, now) => log(r, now, `denied ${e.tool} (${e.agentId ? r.agents[e.agentId]?.role ?? 'agent' : 'lead'})`))
      return { deny: verdict.reason }
    }
    if (isInternalRead(e.tool, c)) {
      const id = e.agentId
      const already = id ? run.agents[id]?.tainted : run.leadTainted
      if (!already) {
        await mutate($, r =>
          id && r.agents[id]
            ? { ...r, agents: { ...r.agents, [id]: { ...r.agents[id], tainted: true } } }
            : id ? r : { ...r, leadTainted: true },
        )
      }
    }
    if (verdict.useApproval) {
      const used = verdict.useApproval
      await mutate($, (r, now) => log({ ...r, approvals: r.approvals.map(a => (a.id === used ? { ...a, used: true } : a)) }, now, `executed ${used}`))
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Dispatch: its policy check failed; the call was blocked.' }))

  // Model tier per role, retry escalation, and the budget gate on every spawn during a run.
  on('agent.spawn', async ($, e, next) => {
    const run = await current($)
    if (!isActive(run)) return next(e)
    const c = await cfg($)
    const role = e.subagentType.startsWith('dispatch:') ? e.subagentType.slice('dispatch:'.length) : 'other'
    const task = taskFromDescription(e.description)
    const t = task ? run.tasks[task] : undefined

    const used = runUsage(run, c).weighted
    if (used >= run.budget) {
      const answer = await ask(
        $,
        `Dispatch run "${run.title}" has used ${formatTokens(used)} of its ${formatTokens(run.budget)} budget (≈$${runUsage(run, c).usd}). Continue?`,
        { options: ['Continue (+50%)', 'Stop here'], header: 'Budget' },
      )
      if (answer !== 'Continue (+50%)') {
        await mutate($, (r, now) => log({ ...r, status: 'paused' }, now, 'budget reached: paused'))
        return { deny: 'Dispatch: the run budget is used up and the person chose to stop. Report the partial results and finish the run.' }
      }
      await mutate($, (r, now) => log({ ...r, budget: Math.round(r.budget * 1.5) }, now, 'budget extended 50%'))
    }

    const tier = t?.tier ?? (ROLES.includes(role as Role) ? c.tiers[role] : undefined)
    const ran = await next(tier ? { ...e, model: tier } : e)
    if ('deny' in ran && ran.deny) return ran
    const agentId = ran.agentId
    if (agentId) {
      await mutate($, (r, now) =>
        log(
          {
            ...r,
            agents: {
              ...r.agents,
              [agentId]: {
                id: agentId,
                task,
                role,
                tier: tierOf(ran.model),
                model: ran.model,
                description: e.description,
                status: 'running',
                usage: zeroUsage(),
                startedAt: now,
              },
            },
            tasks: task && r.tasks[task] ? { ...r.tasks, [task]: { ...r.tasks[task], status: 'running' } } : r.tasks,
          },
          now,
          `spawn ${role}${task ? ` [${task}]` : ''} on ${ran.model}`,
        ),
      )
    }
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  // Token usage per agent (and for the lead) from each finished turn.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const run = await current($)
    // The lead's turn often ends after it finished the run, so its last turn still counts.
    const leadOwed = !!run && !e.agentId && run.leadPending === true
    if (!run || !e.usage || (!isActive(run) && !leadOwed)) return result
    const usage = e.usage
    const agentId = e.agentId
    await mutate($, (r, now) => {
      if (agentId) {
        const a = r.agents[agentId]
        if (!a) return r
        return { ...r, updatedAt: now, agents: { ...r.agents, [agentId]: { ...a, usage: addUsage(a.usage, usage), status: 'done', endedAt: now } } }
      }
      const tier = tierOf(usage.model)
      const counted = r.lead.input_tokens + r.lead.output_tokens + r.lead.cache_read_input_tokens + r.lead.cache_creation_input_tokens > 0
      const byTier = r.leadByTier ?? (counted ? { [r.leadTier]: r.lead } : {})
      return {
        ...r,
        updatedAt: now,
        lead: addUsage(r.lead, usage),
        leadTier: tier,
        leadByTier: { ...byTier, [tier]: addUsage(byTier[tier] ?? zeroUsage(), usage) },
        leadPending: false,
      }
    })
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const run = await current($)
    if (!run) return <Text dimColor>No Dispatch run yet. Start one with /dispatch:dispatch.</Text>
    const c = await cfg($)
    const u = runUsage(run, c)
    const pct = Math.round((100 * u.weighted) / Math.max(1, run.budget))
    const agents = Object.values(run.agents).sort((a, b) => a.startedAt - b.startedAt)
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 8)
    return (
      <Box flexDirection="column">
        <Text bold>{run.title}</Text>
        <Text dimColor>
          {run.size} · {run.status} · {formatTokens(u.weighted)}/{formatTokens(run.budget)} ({pct}%) · ≈${u.usd.toFixed(2)}
        </Text>
        <Text> </Text>
        {run.order.length > 0 && <Text bold>Tasks</Text>}
        {run.order.slice(0, room).map(id => {
          const t = run.tasks[id]
          if (!t) return null
          const mark = t.status === 'done' ? '✓' : t.status === 'running' ? '●' : t.status === 'failed' ? '✗' : t.status === 'skipped' ? '–' : '○'
          return (
            <Text dimColor={t.status === 'done' || t.status === 'skipped'}>
              {mark} {id} {t.role}/{t.tier} {t.title.slice(0, 40)}
            </Text>
          )
        })}
        <Text> </Text>
        <Text bold>Agents</Text>
        {agents.length === 0 && <Text dimColor>none yet</Text>}
        {agents.slice(-room).map(a => {
          const tokens = a.usage.input_tokens + a.usage.output_tokens + a.usage.cache_read_input_tokens + a.usage.cache_creation_input_tokens
          return (
            <Text dimColor={a.status !== 'running'}>
              {a.status === 'running' ? '●' : '✓'} {a.task ? `[${a.task}] ` : ''}
              {a.role} {a.tier} {formatTokens(tokens)} ${dollars(a.usage, a.tier, c).toFixed(2)}
            </Text>
          )
        })}
        <Text dimColor>lead {leadUsageByTier(run).map(([t]) => t).join('+')} ${leadDollars(run, c).toFixed(2)}</Text>
        {run.approvals.some(a => a.queued) && <Text color="yellow">{run.approvals.filter(a => a.queued).length} action(s) waiting for approval: /dispatch:dispatch approvals</Text>}
      </Box>
    )
  })
}
