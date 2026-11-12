import type { AgentSpawnInput, On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mergeLayers, type Config } from '../src/config'
import { dollars, tierOf, weightedTokens } from '../src/cost'
import { decide, guardState } from '../src/policy'
import { checkSchedule, cronLine, isDue, nextSlot, previousSlot, type Schedule } from '../src/schedule'
import { canonical, checkPlan, escalate, newRun, ownsPath, parsePorcelain, scopeViolations, setPlan, taskFromDescription } from '../src/state'

// A config close to config/defaults.json, inline so the pure tests need no IO.
const CFG = {
  locked: [],
  storage: { home: '~/.dispatch', project: '.dispatch' },
  tiers: { scout: 'haiku', researcher: 'sonnet', builder: 'sonnet', writer: 'sonnet', operator: 'sonnet', reviewer: 'sonnet', reviewer_risky: 'opus', planner: 'opus' },
  escalation: ['haiku', 'sonnet', 'opus'],
  budgets: { small: 150000, medium: 600000, large: 2000000 },
  weights: { haiku: 0.05, sonnet: 1, opus: 2 },
  prices: {
    haiku: { model: 'claude-haiku-5-5', input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
    sonnet: { model: 'claude-sonnet-5-5', input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
    opus: { model: 'claude-opus-5-5', input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  },
  outward: {
    read_patterns: ['^get', '^search', '^read', '^list', '^fetch', '^read_page', '^get_page_text', '^tabs_context'],
    allow_actions: [],
    destinations: { allow: [] },
    bash_block: ['\\bgit\\s+push\\b', '\\bcurl\\b[^|]*\\s-(X|-request)\\s*(POST|PUT|PATCH|DELETE)'],
  },
  data: { allow_internal_to_web: false },
  retries: { max: 1, escalate: true },
} as Config

// The engine's spawn input, with the fields a test doesn't care about filled in.
const spawnInput = (a: { prompt: string; subagentType: string; description: string }) =>
  ({ tool_use_id: 'tu', parentModel: 'claude-sonnet-5-5', background: true, fork: false, ...a }) as AgentSpawnInput

// es2023 lib has no timers; the test runtime does.
declare function setTimeout(cb: (...args: unknown[]) => void, ms: number): unknown

function sampleRun() {
  let run = newRun({ now: 0, objective: 'o', title: 'Test run', size: 'medium', project: '/p', runsDir: '/h/runs', cfg: CFG, leadModel: 'claude-sonnet-5-5' })
  run = setPlan(run, [
    { id: 't1', role: 'writer', title: 'Draft' },
    { id: 't2', role: 'builder', title: 'Build', paths: ['src/feature'] },
    { id: 't3', role: 'operator', title: 'Post' },
    { id: 't4', role: 'researcher', title: 'Research' },
  ], CFG, 0)
  const agent = (id: string, task: string, role: string) => ({ id, task, role, tier: 'sonnet' as const, model: 'sonnet', description: `[${task}]`, status: 'running' as const, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, startedAt: 0 })
  run.agents = { w: agent('w', 't1', 'writer'), b: agent('b', 't2', 'builder'), o: agent('o', 't3', 'operator'), r: agent('r', 't4', 'researcher') }
  return run
}

test('config layers merge, and a locked key cannot be overridden', async () => {
  const merged = mergeLayers([
    { budgets: { small: 1, large: 3 } },
    { locked: ['budgets.large'], budgets: { small: 2 } },
    { budgets: { small: 5, large: 99 } },
  ]) as { budgets: { small: number; large: number } }
  expect(merged.budgets.small).toBe(5)
  expect(merged.budgets.large).toBe(3)
})

test('cost: tiers, dollars and weighted tokens', async () => {
  expect(tierOf('claude-haiku-5-5')).toBe('haiku')
  expect(tierOf('opus')).toBe('opus')
  expect(tierOf(undefined)).toBe('sonnet')
  const u = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  expect(dollars(u, 'sonnet', CFG)).toBe(3)
  expect(dollars(u, 'opus', CFG)).toBe(6)
  expect(weightedTokens(u, 'haiku', CFG)).toBe(55000)
  expect(escalate('haiku', CFG)).toBe('sonnet')
  expect(escalate('opus', CFG)).toBe('opus')
})

test('plan checks: unknown deps, unowned builders, parallel overlapping writers', async () => {
  expect(checkPlan([{ id: 'a', role: 'writer', title: 'x', depends_on: ['zz'] }])).toEqual(['a depends on unknown zz'])
  expect(checkPlan([{ id: 'b', role: 'builder', title: 'x' }])).toEqual(['b: builder tasks must own paths'])
  const overlap = checkPlan([
    { id: 'a', role: 'builder', title: 'x', paths: ['src'] },
    { id: 'b', role: 'builder', title: 'y', paths: ['src/util.ts'] },
  ])
  expect(overlap.length).toBe(1)
  const ordered = checkPlan([
    { id: 'a', role: 'builder', title: 'x', paths: ['src'] },
    { id: 'b', role: 'builder', title: 'y', paths: ['src/util.ts'], depends_on: ['a'] },
  ])
  expect(ordered.length).toBe(0)
})

test('owned paths and task ids from descriptions', async () => {
  expect(ownsPath('/p/src/feature/a.ts', ['src/feature'], '/p')).toBe(true)
  expect(ownsPath('/p/src/other.ts', ['src/feature/**'], '/p')).toBe(false)
  expect(ownsPath('/private/tmp/w/textutil.py', ['/tmp/w/textutil.py'], '/tmp/w')).toBe(true)
  expect(ownsPath('/p/src/a.ts', ['/p/src'], '/p')).toBe(true)
  expect(ownsPath('/p/srcx/a.ts', ['/p/src'], '/p')).toBe(false)
  expect(taskFromDescription('[t2] Build it')).toBe('t2')
  expect(taskFromDescription('Build it')).toBe(undefined)
})

test('policy: only the operator acts outward, and only exactly as approved', async () => {
  const run = sampleRun()
  const args = { channel: 'C1', text: 'Weekly update' }
  const call = (agentId: string | undefined, input = args) => decide(run, CFG, { tool: 'mcp__slack__send_message', agentId, input })

  expect(call('w').allow).toBe(false)
  expect(call(undefined).allow).toBe(false)
  expect(call('o').allow).toBe(false)

  run.approvals = [{ id: 't3-a1', task: 't3', tool: 'mcp__slack__send_message', args: canonical(args), summary: '', approved: true, used: false }]
  const ok = call('o')
  expect(ok.allow).toBe(true)
  expect(ok.allow && ok.useApproval).toBe('t3-a1')
  expect(call('o', { channel: 'C1', text: 'Weekly update!' }).allow).toBe(false)

  expect(decide(run, CFG, { tool: 'mcp__slack__read_channel', agentId: 'w', input: {} }).allow).toBe(true)
})

test('policy: data rule, shell and file scope', async () => {
  const run = sampleRun()
  expect(decide(run, CFG, { tool: 'mcp__atlassian__get_issue', agentId: 'r', input: {} }).allow).toBe(false)
  expect(decide(run, CFG, { tool: 'Bash', agentId: 'b', input: { command: 'git push origin main' } }).allow).toBe(false)
  expect(decide(run, CFG, { tool: 'Bash', agentId: 'b', input: { command: 'npm test' } }).allow).toBe(true)
  expect(decide(run, CFG, { tool: 'Edit', agentId: 'b', input: { file_path: '/p/src/feature/x.ts' } }).allow).toBe(true)
  expect(decide(run, CFG, { tool: 'Edit', agentId: 'b', input: { file_path: '/p/README.md' } }).allow).toBe(false)
  expect(decide(run, CFG, { tool: 'Write', agentId: 'w', input: { file_path: `${run.dir}/t1/prd.md` } }).allow).toBe(true)
  expect(decide(run, CFG, { tool: 'mcp__claude-in-chrome__computer', agentId: 'w', input: {} }).allow).toBe(false)
  expect(decide(run, CFG, { tool: 'mcp__claude-in-chrome__get_page_text', agentId: 'w', input: {} }).allow).toBe(true)
})

// ---------- through the engine ----------

function stubEngine(on: On, files: Map<string, string>, listed: string[] = [], git: string[] = [], clock = { now: Date.UTC(2026, 10, 12, 10, 0, 0) }) {
  on('process.run', () => ({ value: { exitCode: 0, stdout: git.join('\n'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.register', () => ({ value: { tool: 'mcp__dispatch__run' } }))
  on('command.register', () => ({ value: { command: 'dispatch-panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_, e) => ({ value: (e as { name: string }).name === 'HOME' ? '/h' : undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('command.list', () => ({ value: [] }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'client' } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/p' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  const isDefaults = (p: string) => p.endsWith('/config/defaults.json')
  on('fs.exists', (_, e) => ({ value: files.has((e as { path: string }).path) || isDefaults((e as { path: string }).path) }))
  on('fs.read', (_, e) => {
    const p = (e as { path: string }).path
    if (isDefaults(p)) return { value: JSON.stringify(CFG) }
    if (!files.has(p)) throw new Error(`missing ${p}`)
    return { value: files.get(p)! }
  })
  on('fs.write', (_, e) => {
    const { path, text } = e as { path: string; text: string }
    files.set(path, text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: listed.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

const parse = (r: unknown) => JSON.parse(String((r as { result: unknown }).result)) as Record<string, unknown>

test('a run: start, plan, tiered spawn, denied outward call, approved call', async ($, on) => {
  const files = new Map<string, string>()
  const answers = ['Approve']
  stubEngine(on, files)
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'inherit', agentId: e.subagentType === 'dispatch:writer' ? 'a-writer' : 'a-op' }))
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { result: 'ok' }
    const qs = (e as unknown as { questions: { question: string }[] }).questions
    const answer = answers.shift() ?? 'Decline'
    return { result: { questions: qs, answers: Object.fromEntries(qs.map(q => [q.question, answer])) } }
  })

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  const started = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'start', objective: 'Post the weekly update', title: 'Weekly update', size: 'small' }))
  expect(started.budget).toBe(150000)

  const planned = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'plan', tasks: [
    { id: 't1', role: 'writer', title: 'Draft update' },
    { id: 't2', role: 'operator', title: 'Post update', depends_on: ['t1'] },
  ] }))
  expect((planned.tasks as unknown[]).length).toBe(2)

  const spawned = await $.agent.spawn(spawnInput({ prompt: 'draft', subagentType: 'dispatch:writer', description: '[t1] Draft update' }))
  expect(spawned.model).toBe('sonnet')

  const denied = await $.tool.call({ tool: 'mcp__slack__send_message', channel: 'C1', text: 'hi', agentId: 'a-writer' })
  expect(String((denied as { deny?: string }).deny ?? '')).toMatch(/Only dispatch:operator/)

  await $.agent.spawn(spawnInput({ prompt: 'post', subagentType: 'dispatch:operator', description: '[t2] Post update' }))
  const approval = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'approve', task: 't2', actions: [
    { tool: 'mcp__slack__send_message', args: { channel: 'C1', text: 'hi' }, summary: 'Post to #team' },
  ] }))
  expect((approval.approvals as { approved: boolean }[])[0]!.approved).toBe(true)

  const posted = await $.tool.call({ tool: 'mcp__slack__send_message', channel: 'C1', text: 'hi', agentId: 'a-op' })
  expect((posted as { result?: unknown }).result).toBe('ok')

  const again = await $.tool.call({ tool: 'mcp__slack__send_message', channel: 'C1', text: 'hi', agentId: 'a-op' })
  expect(String((again as { deny?: string }).deny ?? '')).toMatch(/not approved/)

  const status = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'finish', status: 'done', summary: 'posted' }))
  expect(status.status).toBe('done')
  expect([...files.keys()].some(k => k.startsWith('/p/.dispatch/runs/') && k.endsWith('/run.json'))).toBe(true)
})

test('policy: protected state files, path traversal, operator shell needs approval', async () => {
  const run = sampleRun()
  expect(decide(run, CFG, { tool: 'Write', agentId: 'w', input: { file_path: `${run.dir}/run.json` } }).allow).toBe(false)
  expect(decide(run, CFG, { tool: 'Write', agentId: 'b', input: { file_path: '/p/.dispatch/config.json' } }).allow).toBe(false)
  expect(decide(run, CFG, { tool: 'Edit', agentId: 'b', input: { file_path: '/p/src/feature/../../secrets.ts' } }).allow).toBe(false)
  expect(decide(run, CFG, { tool: 'Write', agentId: 'w', input: { file_path: `${run.dir}/../x.md` } }).allow).toBe(false)
  expect(decide(run, CFG, { tool: 'Bash', agentId: 'b', input: { command: `cat ${run.dir}/run.json` } }).allow).toBe(false)
  expect(decide(run, CFG, { tool: 'Bash', agentId: 'o', input: { command: 'git push origin main' } }).allow).toBe(false)
  run.approvals = [{ id: 't3-a1', task: 't3', tool: 'Bash', args: canonical({ command: 'git push origin main' }), summary: '', approved: true, used: false }]
  expect(decide(run, CFG, { tool: 'Bash', agentId: 'o', input: { command: 'git push origin main', description: 'push' } }).allow).toBe(true)
})

test('engine: role agents cannot steer the run; usage and budget are tracked per agent', async ($, on) => {
  const files = new Map<string, string>()
  const answers = ['Stop here']
  stubEngine(on, files)
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'inherit', agentId: `a${e.description.slice(1, 3)}` }))
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { result: 'ok' }
    const qs = (e as unknown as { questions: { question: string }[] }).questions
    return { result: { questions: qs, answers: Object.fromEntries(qs.map(q => [q.question, answers.shift() ?? 'Decline'])) } }
  })
  on('turn.complete', () => ({ text: 'done' }))

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'start', objective: 'x', title: 'Budget run', size: 'small' }))
  parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'plan', tasks: [{ id: 't1', role: 'scout', title: 'Look' }, { id: 't2', role: 'writer', title: 'Write' }] }))

  const scout = await $.agent.spawn(spawnInput({ prompt: 'look', subagentType: 'dispatch:scout', description: '[t1] Look' }))
  expect(scout.model).toBe('haiku')

  const hijack = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'finish', status: 'done', agentId: 'at1' }))
  expect(String(hijack.error)).toMatch(/Only the Dispatch lead/)

  // The scout's turn uses 4M weighted-at-haiku tokens → 200k weighted, over the 150k small budget.
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'x', agentId: 'at1', usage: { model: 'claude-haiku-5-5', input_tokens: 4_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)
  const status = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'status' }))
  expect((status.budget as { used: number }).used).toBe(200000)
  expect(status.usd_equivalent).toBe(0.4)

  const blocked = await $.agent.spawn(spawnInput({ prompt: 'write', subagentType: 'dispatch:writer', description: '[t2] Write' }))
  expect(String((blocked as { deny?: string }).deny ?? '')).toMatch(/budget/)
})

test('engine: resume reattaches the latest run from disk', async ($, on) => {
  const files = new Map<string, string>()
  const listed: string[] = []
  stubEngine(on, files, listed)
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const started = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'start', objective: 'x', title: 'Resume me', size: 'medium' }))
  const id = String(started.run)
  listed.push(id)
  const resumed = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'resume', run: 'latest' }))
  expect(resumed.run).toBe(id)
  expect(resumed.objective).toBe('x')
})

test('inline tasks: small runs only, builder or writer only; the lead edits owned paths only while running', async () => {
  expect(checkPlan([{ id: 'a', role: 'builder', title: 'x', paths: ['src'], inline: true }], 'medium').length).toBe(1)
  expect(checkPlan([{ id: 'a', role: 'operator', title: 'x', inline: true }], 'small').length).toBe(1)
  expect(checkPlan([{ id: 'a', role: 'builder', title: 'x', paths: ['src'], inline: true }], 'small').length).toBe(0)

  let run = newRun({ now: 0, objective: 'o', title: 'Inline', size: 'small', project: '/p', runsDir: '/p/.dispatch/runs', cfg: CFG, leadModel: 'sonnet' })
  run = setPlan(run, [{ id: 't1', role: 'builder', title: 'Build', paths: ['textutil.py'], inline: true }], CFG, 0)
  const edit = () => decide(run, CFG, { tool: 'Write', input: { file_path: '/p/textutil.py' } }).allow
  expect(edit()).toBe(false)
  run.tasks.t1!.status = 'running'
  expect(edit()).toBe(true)
  expect(decide(run, CFG, { tool: 'Write', input: { file_path: '/p/other.py' } }).allow).toBe(false)
  expect(decide(run, CFG, { tool: 'Bash', input: { command: 'git push' } }).allow).toBe(false)
  run.tasks.t1!.status = 'done'
  expect(edit()).toBe(false)
})

test('scope check: porcelain parsing and files no task owns', async () => {
  expect(parsePorcelain(' M src/a.ts\n?? "new file.md"\nR  old.ts -> src/b.ts\n')).toEqual(['src/a.ts', 'new file.md', 'src/b.ts'])
  const run = sampleRun()
  run.baseline = ['notes.txt']
  expect(scopeViolations(['src/feature/x.ts', 'notes.txt', '.dispatch/runs/r/run.json', 'README.md'], run, '.dispatch')).toEqual(['README.md'])
})

test('data rule: an agent that read internal content loses web tools', async () => {
  const run = sampleRun()
  expect(decide(run, CFG, { tool: 'WebFetch', agentId: 'w', input: { url: 'https://x' } }).allow).toBe(true)
  run.agents.w!.tainted = true
  expect(decide(run, CFG, { tool: 'WebFetch', agentId: 'w', input: { url: 'https://x' } }).allow).toBe(false)
  run.leadTainted = true
  expect(decide(run, CFG, { tool: 'WebSearch', input: { query: 'q' } }).allow).toBe(false)
  run.allowInternalToWeb = true
  expect(decide(run, CFG, { tool: 'WebSearch', input: { query: 'q' } }).allow).toBe(true)
})

test('engine: a task that changed a file nobody owns fails the scope check; reading internal content taints', async ($, on) => {
  const files = new Map<string, string>()
  const git: string[] = []
  stubEngine(on, files, [], git)
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'inherit', agentId: 'a1' }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'start', objective: 'x', title: 'Scope', size: 'small' }))
  parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'plan', tasks: [{ id: 't1', role: 'builder', title: 'b', paths: ['src'] }] }))
  await $.agent.spawn(spawnInput({ prompt: 'b', subagentType: 'dispatch:builder', description: '[t1] b' }))

  await $.tool.call({ tool: 'mcp__jira__get_issue', key: 'P-1', agentId: 'a1' })
  const web = await $.tool.call({ tool: 'WebFetch', url: 'https://evil.example', prompt: 'x', agentId: 'a1' })
  expect(String((web as { deny?: string }).deny ?? '')).toMatch(/data rule/)

  git.push(' M src/ok.ts', ' M package.json')
  const done = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'task', task: 't1', status: 'done' }))
  expect(done.scope_violations).toEqual(['package.json'])
  expect((done.retry as { allowed: boolean }).allowed).toBe(true)
})

// ---------- schedules ----------

const H = 3_600_000
const sched = (over: Partial<Schedule>): Schedule => ({ id: 's', request: 'weekly status', every: 'weekly', at: '09:00', day: 1, enabled: true, createdAt: Date.UTC(2026, 10, 12, 10), ...over })

test('schedules: due times in local time, missed slots run once, cron lines', async () => {
  const s = sched({}) // Mondays 09:00 at UTC+1; 2026-11-12 is a Thursday
  const mon = Date.UTC(2026, 10, 16, 8) // Monday 09:00 local
  expect(isDue(s, mon - 60_000, 60)).toBe(false)
  expect(isDue(s, mon, 60)).toBe(true)
  expect(previousSlot(s, mon + H, 60)).toBe(mon)
  expect(nextSlot(s, mon, 60)).toBe(mon + 7 * 24 * H)
  expect(isDue({ ...s, lastRunAt: mon }, mon + H, 60)).toBe(false)
  expect(isDue({ ...s, lastRunAt: mon }, mon + 15 * 24 * H, 60)).toBe(true) // two missed Mondays: due, once
  expect(isDue({ ...s, enabled: false }, mon, 60)).toBe(false)
  const wk = sched({ every: 'weekdays', day: undefined })
  expect(isDue({ ...wk, lastRunAt: Date.UTC(2026, 10, 13, 9) }, Date.UTC(2026, 10, 15, 12), 0)).toBe(false) // nothing on the weekend
  expect(cronLine(s, '/r/bin/run', '/p q')).toBe("0 9 * * 1 '/r/bin/run' '/p q'")
  expect(cronLine(sched({ every: 'monthly', day: 28, at: '17:30' }), '/r', '/p')).toBe("30 17 28 * * '/r' '/p'")
  expect(checkSchedule({ id: 'Bad Id', request: '', every: 'hourly', at: '9am' }, []).length).toBe(4)
  expect(checkSchedule({ id: 'ok', request: 'x', every: 'monthly', at: '09:00', day: 31 }, [])).toEqual(['day: 1 to 28 for monthly'])
  expect(checkSchedule({ id: 's', request: 'x', every: 'daily', at: '09:00' }, [s])).toEqual(['id s already exists: remove it first'])
})

test('policy: schedules and run state are written only by the mod, even with no run active', async () => {
  expect(guardState('Write', { file_path: '/p/.dispatch/schedules.json' }).allow).toBe(false)
  expect(guardState('Edit', { file_path: '/p/.dispatch/x/../schedules.json' }).allow).toBe(false)
  expect(guardState('Bash', { command: 'echo [] > .dispatch/schedules.json' }).allow).toBe(false)
  expect(guardState('Write', { file_path: '/p/notes.md' }).allow).toBe(true)
  expect(guardState('Edit', { file_path: '/p/.dispatch/runs/r1/run.json' }).allow).toBe(false)
  expect(guardState('Bash', { command: "sed -i '' s/false/true/ .dispatch/runs/r1/run.json" }).allow).toBe(false)
  expect(guardState('Bash', { command: 'python3 gen.py > .dispatch/runs/r1/t1/out.md' }).allow).toBe(true)
  expect(guardState('Write', { file_path: '/p/tools/run.json' }).allow).toBe(true)
  const run = sampleRun()
  expect(decide(run, CFG, { tool: 'Write', agentId: 'w', input: { file_path: '/p/.dispatch/schedules.json' } }).allow).toBe(false)
})

test('engine: a schedule is created only with the person, runs headless, queues its post, and waits for approval', async ($, on) => {
  const files = new Map<string, string>()
  const listed: string[] = []
  const clock = { now: Date.UTC(2026, 10, 12, 10) }
  let interactive = true
  const answers: string[] = []
  stubEngine(on, files, listed, [], clock)
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'inherit', agentId: 'a-op' }))
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { result: 'ok' }
    if (!interactive) throw new Error('no one to ask')
    const qs = (e as unknown as { questions: { question: string }[] }).questions
    return { result: { questions: qs, answers: Object.fromEntries(qs.map(q => [q.question, answers.shift() ?? 'Cancel'])) } }
  })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const run = (args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__dispatch__run', ...args } as never).then(parse)

  // The model cannot write the schedules file, run or no run.
  const sneaky = await $.tool.call({ tool: 'Write', file_path: '/p/.dispatch/schedules.json', content: '[]' } as never)
  expect(String((sneaky as { deny?: string }).deny ?? '')).toMatch(/schedules/)

  answers.push('Create schedule')
  const added = await run({ action: 'schedule', op: 'add', id: 'standup', request: 'Daily standup note to #team', every: 'daily', at: '09:00' })
  expect(added.created).toBe(true)
  expect(String((added.unattended as { crontab_line: string }).crontab_line)).toMatch(/^0 9 \* \* \* .*bin\/dispatch-run-due' '\/p'$/)
  expect(JSON.parse(files.get('/p/.dispatch/schedules.json')!).length).toBe(1)
  expect(files.get('/p/.dispatch/.gitignore')).toMatch(/schedules\.json/)
  expect((await run({ action: 'schedule', op: 'due' })).due).toEqual([])

  // A day later, headless: nobody can be asked.
  clock.now += 25 * H
  interactive = false
  expect(((await run({ action: 'schedule', op: 'due' })).due as unknown[]).length).toBe(1)
  expect((await run({ action: 'schedule', op: 'add', id: 'x', request: 'y', every: 'daily', at: '10:00' })).created).toBe(false)
  const started = await run({ action: 'start', objective: 'Daily standup note to #team', title: 'Standup', size: 'small', schedule: 'standup' })
  listed.push(String(started.run))
  expect((await run({ action: 'schedule', op: 'due' })).due).toEqual([])
  await run({ action: 'plan', tasks: [{ id: 't1', role: 'writer', title: 'Draft', inline: true }, { id: 't2', role: 'operator', title: 'Post', depends_on: ['t1'] }] })
  const queued = await run({ action: 'approve', task: 't2', actions: [{ tool: 'mcp__slack__send_message', args: { channel: 'C1', text: 'standup' }, summary: 'Post' }] })
  expect((queued.approvals as { approved: boolean }[])[0]!.approved).toBe(false)
  expect(String(queued.note)).toMatch(/Do not spawn the operator/)
  expect((await run({ action: 'finish', status: 'done', summary: 'drafted' })).status).toBe('waiting')
  expect(((await run({ action: 'list' })).runs as { waiting_for_approval?: number }[])[0]!.waiting_for_approval).toBe(1)

  // Back at the keyboard: the person approves the exact queued post, and only the operator sends it.
  interactive = true
  const resumed = await run({ action: 'resume', run: 'latest' })
  expect((resumed.queued as unknown[]).length).toBe(1)
  answers.push('Approve')
  const cleared = await run({ action: 'approve_queued' })
  expect((cleared.approvals as { approved: boolean; args: unknown }[])[0]).toEqual({ id: 't2-a1', task: 't2', tool: 'mcp__slack__send_message', approved: true, args: { channel: 'C1', text: 'standup' } })
  await $.agent.spawn(spawnInput({ prompt: 'post', subagentType: 'dispatch:operator', description: '[t2] Post' }))
  const posted = await $.tool.call({ tool: 'mcp__slack__send_message', channel: 'C1', text: 'standup', agentId: 'a-op' } as never)
  expect((posted as { result?: unknown }).result).toBe('ok')
  expect((await run({ action: 'finish', status: 'done', summary: 'posted' })).status).toBe('done')
})

test('engine: resume skips run folders an older Dispatch left behind', async ($, on) => {
  const files = new Map<string, string>()
  const listed: string[] = []
  stubEngine(on, files, listed)
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const started = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'start', objective: 'x', title: 'New run', size: 'small' }))
  await $.tool.call({ tool: 'mcp__dispatch__run', action: 'finish', status: 'done', summary: 's' })
  files.set('/p/.dispatch/runs/zzzz-old/run.json', JSON.stringify({ id: 'zzzz-old', steps: [] }))
  listed.push('zzzz-old', String(started.run))
  const resumed = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'resume', run: 'latest' }))
  expect(resumed.run).toBe(started.run)
})

test('engine: a session in a project Dispatch never ran in writes nothing', async ($, on) => {
  const files = new Map<string, string>()
  stubEngine(on, files)
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect([...files.keys()]).toEqual([])
})
