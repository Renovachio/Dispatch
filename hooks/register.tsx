// Dispatch mod: run state tool, policy enforcement on spawns and tool calls,
// per-agent cost tracking, and the live panel beside the chat.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Role, Run, Size, TaskStatus } from '../types'
import { loadConfig, type Config } from '../src/config'
import { addUsage, dollars, formatTokens, tierOf, zeroUsage } from '../src/cost'
import { callArgs, decide, destinationAllowed, isOwnTool } from '../src/policy'
import {
  canonical,
  checkPlan,
  escalate,
  listRuns,
  loadRun,
  log,
  newRun,
  runsDir,
  runUsage,
  saveRun,
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

/** Ask the person directly (never the model). A dismissed or unanswerable dialog counts as a no. */
async function ask($: EngineInterface, question: string, options: { options: string[]; header: string }): Promise<string> {
  try {
    return await $.ui.ask(question, options)
  } catch {
    return ''
  }
}

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
Spawn role agents as subagent_type "dispatch:<role>" with description "[<task id>] <title>".`

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['start', 'plan', 'task', 'approve', 'status', 'finish', 'resume', 'list', 'learn'] },
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
    tasks: run.order.map(id => {
      const t = run.tasks[id]
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
    lead: { tier: run.leadTier, usd: dollars(run.lead, run.leadTier, c) },
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
    await update($, runAtom, () => run)
    await saveRun($, run)
    void $.ui.open({ id: PANE, title: 'Dispatch' })
    return { run: run.id, dir: run.dir, context_file: `${run.dir}/context.md`, budget: run.budget, size }
  }

  if (action === 'list') {
    const ids = (await listRuns($, c)).slice(0, 10)
    const dir = await runsDir($, c)
    const rows = []
    for (const id of ids) {
      const r = await loadRun($, `${dir}/${id}`)
      if (r) rows.push({ id, status: r.status, size: r.size, title: r.title, usd: runUsage(r, c).usd })
    }
    return { runs: rows }
  }

  if (action === 'resume') {
    const ids = await listRuns($, c)
    const want = String(e.run ?? 'latest')
    const id = want === 'latest' ? ids[0] : ids.find(x => x.includes(want))
    if (!id) return { error: `no run matches ${want}` }
    const run = await loadRun($, `${await runsDir($, c)}/${id}`)
    if (!run) return { error: `run ${id} could not be read` }
    const resumed = log({ ...run, status: run.status === 'paused' ? 'active' : run.status }, now, 'resume')
    await update($, runAtom, () => resumed)
    await saveRun($, resumed)
    void $.ui.open({ id: PANE, title: 'Dispatch' })
    return { ...report(resumed, c), objective: resumed.objective, context_file: `${resumed.dir}/context.md`, log: resumed.log.slice(-15) }
  }

  const run = await current($)
  if (!run) return { error: 'no active run: start one, or resume' }

  if (action === 'status') return report(run, c)

  if (action === 'plan') {
    const tasks = (Array.isArray(e.tasks) ? e.tasks : []) as TaskInput[]
    const bad = tasks.filter(t => !ROLES.includes(t.role)).map(t => `${t.id}: unknown role ${t.role}`)
    const errors = [...bad, ...checkPlan([...Object.values(run.tasks).filter(t => !tasks.some(n => n.id === t.id)), ...tasks], run.size)]
    if (errors.length) return { errors }
    const next = await mutate($, r => setPlan(r, tasks, c, now))
    return { tasks: next!.order.map(id => ({ id, role: next!.tasks[id].role, tier: next!.tasks[id].tier })) }
  }

  if (action === 'task') {
    const id = String(e.task ?? '')
    const status = String(e.status ?? '') as TaskStatus
    if (!run.tasks[id]) return { error: `unknown task ${id}` }
    if (status === 'running' && run.tasks[id].inline) {
      const other = Object.values(run.tasks).find(t => t.inline && t.status === 'running' && t.id !== id)
      if (other) return { error: `inline task ${other.id} is still running; finish it first` }
    }
    let retry: { allowed: boolean; tier?: string } | undefined
    const next = await mutate($, r => {
      const t = r.tasks[id]
      const failed = status === 'failed'
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
              status: canRetry ? 'planned' : status,
              attempts,
              tier,
              summary: typeof e.summary === 'string' ? e.summary : t.summary,
              deliverables: Array.isArray(e.deliverables) ? (e.deliverables as string[]) : t.deliverables,
            },
          },
        },
        now,
        `task ${id} ${status}${failed ? ` (attempt ${attempts})` : ''}`,
      )
    })
    return { task: id, status: next!.tasks[id].status, retry, budget: report(next!, c).budget }
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
      const approved = answer === 'Approve'
      results.push({ id: aid, tool: a.tool, approved, note: approved ? undefined : answer === 'Decline' ? undefined : answer })
      await mutate($, r =>
        log(
          { ...r, approvals: [...r.approvals, { id: aid, task: id, tool: a.tool, args, summary: a.summary ?? '', approved, used: false }] },
          now,
          `approval ${aid} ${a.tool}: ${approved ? 'approved' : 'declined'}`,
        ),
      )
    }
    return { approvals: results, note: 'Pass approved actions to dispatch:operator with their exact tool and args; any change is blocked.' }
  }

  if (action === 'finish') {
    const status = (['done', 'failed', 'cancelled'].includes(String(e.status)) ? e.status : 'done') as Run['status']
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
    await $.tool.register({ name: TOOL, description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    await $.command.register({ name: 'dispatch-panel', description: 'Open the Dispatch run panel' })
    return next(e)
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
    const run = await current($)
    if (!isActive(run)) return next(e)
    const c = await cfg($)
    const verdict = decide(run, c, { tool: e.tool, agentId: e.agentId, input: callArgs(raw) })
    if (!verdict.allow) {
      await mutate($, (r, now) => log(r, now, `denied ${e.tool} (${e.agentId ? r.agents[e.agentId]?.role ?? 'agent' : 'lead'})`))
      return { deny: verdict.reason }
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
      return { ...r, updatedAt: now, lead: addUsage(r.lead, usage), leadTier: tierOf(usage.model), leadPending: false }
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
        <Text dimColor>lead {run.leadTier} ${dollars(run.lead, run.leadTier, c).toFixed(2)}</Text>
      </Box>
    )
  })
}
