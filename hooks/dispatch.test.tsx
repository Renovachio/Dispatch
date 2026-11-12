import { expect, test } from 'claude-code/testing'

import { mergeLayers, type Config } from '../src/config'
import { dollars, tierOf, weightedTokens } from '../src/cost'
import { decide } from '../src/policy'
import { canonical, checkPlan, escalate, newRun, ownsPath, parsePorcelain, scopeViolations, setPlan, taskFromDescription } from '../src/state'

// A config close to config/defaults.json, inline so the pure tests need no IO.
const CFG = {
  locked: [],
  storage: { home: '~/.dispatch2', project: '.dispatch2' },
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

function stubEngine(on: Parameters<Parameters<typeof test>[1]>[1], files: Map<string, string>, listed: string[] = [], git: string[] = []) {
  on('process.run', () => ({ value: { exitCode: 0, stdout: git.join('\n'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'dispatch-panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_, e) => ({ value: (e as { name: string }).name === 'HOME' ? '/h' : undefined }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 12, 10, 0, 0) }))
  on('session.cwd', () => ({ value: '/p' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  const isDefaults = (p: string) => p.endsWith('/config/defaults.json')
  on('fs.exists', (_, e) => ({ value: files.has((e as { path: string }).path) || isDefaults((e as { path: string }).path) }))
  on('fs.read', (_, e) => {
    const p = (e as { path: string }).path
    if (isDefaults(p)) return { value: JSON.stringify(CFG) }
    if (!files.has(p)) throw new Error(`missing ${p}`)
    return { value: files.get(p) }
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

  const spawned = await $.agent.spawn({ prompt: 'draft', subagentType: 'dispatch:writer', description: '[t1] Draft update' })
  expect(spawned.model).toBe('sonnet')

  const denied = await $.tool.call({ tool: 'mcp__slack__send_message', channel: 'C1', text: 'hi', agentId: 'a-writer' })
  expect(String((denied as { deny?: string }).deny ?? '')).toMatch(/Only dispatch:operator/)

  await $.agent.spawn({ prompt: 'post', subagentType: 'dispatch:operator', description: '[t2] Post update' })
  const approval = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'approve', task: 't2', actions: [
    { tool: 'mcp__slack__send_message', args: { channel: 'C1', text: 'hi' }, summary: 'Post to #team' },
  ] }))
  expect((approval.approvals as { approved: boolean }[])[0].approved).toBe(true)

  const posted = await $.tool.call({ tool: 'mcp__slack__send_message', channel: 'C1', text: 'hi', agentId: 'a-op' })
  expect((posted as { result?: unknown }).result).toBe('ok')

  const again = await $.tool.call({ tool: 'mcp__slack__send_message', channel: 'C1', text: 'hi', agentId: 'a-op' })
  expect(String((again as { deny?: string }).deny ?? '')).toMatch(/not approved/)

  const status = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'finish', status: 'done', summary: 'posted' }))
  expect(status.status).toBe('done')
  expect([...files.keys()].some(k => k.startsWith('/p/.dispatch2/runs/') && k.endsWith('/run.json'))).toBe(true)
})

test('policy: protected state files, path traversal, operator shell needs approval', async () => {
  const run = sampleRun()
  expect(decide(run, CFG, { tool: 'Write', agentId: 'w', input: { file_path: `${run.dir}/run.json` } }).allow).toBe(false)
  expect(decide(run, CFG, { tool: 'Write', agentId: 'b', input: { file_path: '/p/.dispatch2/config.json' } }).allow).toBe(false)
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

  const scout = await $.agent.spawn({ prompt: 'look', subagentType: 'dispatch:scout', description: '[t1] Look' })
  expect(scout.model).toBe('haiku')

  const hijack = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'finish', status: 'done', agentId: 'at1' }))
  expect(String(hijack.error)).toMatch(/Only the Dispatch lead/)

  // The scout's turn uses 4M weighted-at-haiku tokens → 200k weighted, over the 150k small budget.
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'x', agentId: 'at1', usage: { model: 'claude-haiku-5-5', input_tokens: 4_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)
  const status = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'status' }))
  expect((status.budget as { used: number }).used).toBe(200000)
  expect(status.usd_equivalent).toBe(0.4)

  const blocked = await $.agent.spawn({ prompt: 'write', subagentType: 'dispatch:writer', description: '[t2] Write' })
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

  let run = newRun({ now: 0, objective: 'o', title: 'Inline', size: 'small', project: '/p', runsDir: '/p/.dispatch2/runs', cfg: CFG, leadModel: 'sonnet' })
  run = setPlan(run, [{ id: 't1', role: 'builder', title: 'Build', paths: ['textutil.py'], inline: true }], CFG, 0)
  const edit = () => decide(run, CFG, { tool: 'Write', input: { file_path: '/p/textutil.py' } }).allow
  expect(edit()).toBe(false)
  run.tasks.t1.status = 'running'
  expect(edit()).toBe(true)
  expect(decide(run, CFG, { tool: 'Write', input: { file_path: '/p/other.py' } }).allow).toBe(false)
  expect(decide(run, CFG, { tool: 'Bash', input: { command: 'git push' } }).allow).toBe(false)
  run.tasks.t1.status = 'done'
  expect(edit()).toBe(false)
})

test('scope check: porcelain parsing and files no task owns', async () => {
  expect(parsePorcelain(' M src/a.ts\n?? "new file.md"\nR  old.ts -> src/b.ts\n')).toEqual(['src/a.ts', 'new file.md', 'src/b.ts'])
  const run = sampleRun()
  run.baseline = ['notes.txt']
  expect(scopeViolations(['src/feature/x.ts', 'notes.txt', '.dispatch2/runs/r/run.json', 'README.md'], run, '.dispatch2')).toEqual(['README.md'])
})

test('data rule: an agent that read internal content loses web tools', async () => {
  const run = sampleRun()
  expect(decide(run, CFG, { tool: 'WebFetch', agentId: 'w', input: { url: 'https://x' } }).allow).toBe(true)
  run.agents.w.tainted = true
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
  await $.agent.spawn({ prompt: 'b', subagentType: 'dispatch:builder', description: '[t1] b' })

  await $.tool.call({ tool: 'mcp__jira__get_issue', key: 'P-1', agentId: 'a1' })
  const web = await $.tool.call({ tool: 'WebFetch', url: 'https://evil.example', prompt: 'x', agentId: 'a1' })
  expect(String((web as { deny?: string }).deny ?? '')).toMatch(/data rule/)

  git.push(' M src/ok.ts', ' M package.json')
  const done = parse(await $.tool.call({ tool: 'mcp__dispatch__run', action: 'task', task: 't1', status: 'done' }))
  expect(done.scope_violations).toEqual(['package.json'])
  expect((done.retry as { allowed: boolean }).allowed).toBe(true)
})
