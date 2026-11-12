// Run state: a plain JSON document per run, persisted under <project>/.dispatch/runs/<id>/run.json.
// Pure transition functions first (tested), IO helpers after.
import type { EngineInterface } from 'claude-code'
import type { Config } from './config'
import type { Approval, Role, Run, Size, Task, Tier } from '../types'
import { addUsage, dollars, tierOf, weightedTokens, zeroUsage } from './cost'

export type { AgentRec, Approval, Run, RunStatus, Task, TaskStatus } from '../types'

// ---------- pure helpers ----------

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'run'
}

export function runId(now: number, title: string): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${slug(title)}`
}

/** Canonical JSON: sorted keys, so the same arguments always compare equal. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .filter(k => obj[k] !== undefined)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function newRun(args: {
  now: number
  objective: string
  title: string
  size: Size
  project: string
  runsDir: string
  cfg: Config
  leadModel: string
}): Run {
  const id = runId(args.now, args.title)
  return {
    id,
    objective: args.objective,
    title: args.title,
    size: args.size,
    status: 'active',
    project: args.project,
    dir: `${args.runsDir}/${id}`,
    createdAt: args.now,
    updatedAt: args.now,
    budget: args.cfg.budgets[args.size],
    allowInternalToWeb: args.cfg.data.allow_internal_to_web,
    tasks: {},
    order: [],
    agents: {},
    lead: zeroUsage(),
    leadTier: tierOf(args.leadModel),
    approvals: [],
    log: [`${new Date(args.now).toISOString()} start ${args.size}: ${args.title}`],
  }
}

export function log(run: Run, now: number, line: string): Run {
  return { ...run, updatedAt: now, log: [...run.log, `${new Date(now).toISOString()} ${line}`].slice(-300) }
}

export type TaskInput = {
  id: string
  role: Role
  title: string
  skills?: string[]
  paths?: string[]
  depends_on?: string[]
  inline?: boolean
}

export function defaultTier(role: Role, size: Size, cfg: Config): Tier {
  if (role === 'reviewer' && size === 'large') return cfg.tiers.reviewer_risky ?? 'opus'
  return cfg.tiers[role] ?? 'sonnet'
}

export function escalate(tier: Tier, cfg: Config): Tier {
  const ladder = cfg.escalation
  const i = ladder.indexOf(tier)
  return i >= 0 && i < ladder.length - 1 ? ladder[i + 1] : tier
}

const INLINE_ROLES = new Set(['builder', 'writer'])

/** Errors for a plan: unknown deps, unowned builders, inline misuse, and parallel writers sharing a path. */
export function checkPlan(tasks: readonly TaskInput[], size: Size = 'small'): string[] {
  const errors: string[] = []
  for (const t of tasks) {
    if (!t.inline) continue
    if (size !== 'small') errors.push(`${t.id}: inline tasks are for small runs only; spawn an agent`)
    if (!INLINE_ROLES.has(t.role)) errors.push(`${t.id}: only builder or writer tasks can run inline (${t.role} needs its own agent)`)
  }
  const ids = new Set<string>()
  for (const t of tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id ${t.id}`)
    ids.add(t.id)
  }
  for (const t of tasks) {
    for (const d of t.depends_on ?? []) if (!ids.has(d)) errors.push(`${t.id} depends on unknown ${d}`)
    if (t.role === 'builder' && (t.paths ?? []).length === 0) errors.push(`${t.id}: builder tasks must own paths`)
  }
  // Two writers with overlapping paths and no dependency path between them may collide.
  const writers = tasks.filter(t => (t.paths ?? []).length > 0)
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    const t = tasks.find(x => x.id === from)
    return (t?.depends_on ?? []).some(d => reaches(d, to, seen))
  }
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      const a = writers[i]
      const b = writers[j]
      const overlap = (a.paths ?? []).some(p => (b.paths ?? []).some(q => pathsOverlap(p, q)))
      if (overlap && !reaches(a.id, b.id) && !reaches(b.id, a.id)) {
        errors.push(`${a.id} and ${b.id} write overlapping paths in parallel: add a dependency or give one a worktree`)
      }
    }
  }
  return errors
}

const stripGlob = (p: string) => p.replace(/\/?\*\*?.*$/, '').replace(/\/$/, '')

export function pathsOverlap(a: string, b: string): boolean {
  const x = stripGlob(a)
  const y = stripGlob(b)
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`) || x === '' || y === ''
}

/** macOS reaches /tmp and /var through /private; compare paths without that prefix. */
const canon = (p: string) => p.replace(/^\/private(?=\/(tmp|var)\/)/, '')

/** Is `file` inside one of `owned` (project-relative or absolute paths, or globs)? */
export function ownsPath(file: string, owned: readonly string[], project: string): boolean {
  if (file.split('/').includes('..')) return false
  const root = canon(project)
  const rel = (p: string) => {
    const c = canon(p)
    return c.startsWith(`${root}/`) ? c.slice(root.length + 1) : c === root ? '' : c
  }
  const target = rel(file)
  return owned.some(p => {
    const base = rel(stripGlob(p))
    if (base === '') return true
    return target === base || target.startsWith(`${base}/`)
  })
}

/** Paths from `git status --porcelain=v1 -uall` output. */
export function parsePorcelain(out: string): string[] {
  return out
    .split('\n')
    .filter(l => l.length > 3)
    .map(l => {
      const p = l.slice(3).split(' -> ').pop() ?? ''
      return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p
    })
}

/**
 * Files changed since the run started that no task owns (Dispatch's own folder excepted).
 * A file already changed before the run is in the baseline and is not checked.
 */
export function scopeViolations(changed: readonly string[], run: Run, dispatchFolder: string): string[] {
  const before = new Set(run.baseline ?? [])
  const owned = Object.values(run.tasks).flatMap(t => t.paths)
  return changed.filter(
    f => !before.has(f) && !f.startsWith(`${dispatchFolder}/`) && !ownsPath(`${run.project}/${f}`, owned, run.project),
  )
}

export function setPlan(run: Run, tasks: readonly TaskInput[], cfg: Config, now: number): Run {
  const next: Record<string, Task> = { ...run.tasks }
  const order = [...run.order]
  for (const t of tasks) {
    const prev = next[t.id]
    next[t.id] = {
      id: t.id,
      role: t.role,
      title: t.title,
      skills: t.skills ?? [],
      paths: t.paths ?? [],
      depends_on: t.depends_on ?? [],
      status: prev?.status ?? 'planned',
      attempts: prev?.attempts ?? 0,
      tier: prev?.tier ?? defaultTier(t.role, run.size, cfg),
      deliverables: prev?.deliverables ?? [],
      summary: prev?.summary,
      inline: t.inline === true,
    }
    if (!order.includes(t.id)) order.push(t.id)
  }
  return log({ ...run, tasks: next, order }, now, `plan ${tasks.map(t => t.id).join(',')}`)
}

/** Task id from an Agent description written as "[t1] Draft the PRD". */
export function taskFromDescription(description: string): string | undefined {
  return /^\s*\[([A-Za-z0-9_.-]+)\]/.exec(description)?.[1]
}

export function runUsage(run: Run, cfg: Config) {
  let weighted = weightedTokens(run.lead, run.leadTier, cfg)
  let usd = dollars(run.lead, run.leadTier, cfg)
  let total = zeroUsage()
  total = addUsage(total, run.lead)
  for (const a of Object.values(run.agents)) {
    weighted += weightedTokens(a.usage, a.tier, cfg)
    usd += dollars(a.usage, a.tier, cfg)
    total = addUsage(total, a.usage)
  }
  return { weighted, usd: Math.round(usd * 100) / 100, total }
}

// ---------- IO ----------

/** Personal files in the project's Dispatch folder: never committed. */
const PERSONAL = ['runs/', 'config.local.json', 'schedules.json']

/** The project's Dispatch folder (no side effects). */
export async function projectDir($: EngineInterface, cfg: Config): Promise<string> {
  return `${await $.session.cwd()}/${cfg.storage.project}`
}

/** Create the folder's .gitignore so personal files are never committed. Call before writing into it. */
export async function ensureProjectDir($: EngineInterface, cfg: Config): Promise<string> {
  const dir = await projectDir($, cfg)
  const ignore = `${dir}/.gitignore`
  const prev = (await $.fs.exists(ignore)) ? await $.fs.read(ignore) : ''
  const missing = PERSONAL.filter(line => !prev.split('\n').includes(line))
  if (missing.length) await $.fs.write(ignore, `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`)
  return dir
}

/** Runs live in the project (`.dispatch/runs/`, git-ignored) so agents write there without prompts. */
export async function runsDir($: EngineInterface, cfg: Config): Promise<string> {
  return `${await ensureProjectDir($, cfg)}/runs`
}

/** A run.json written by this version (older Dispatch systems used the same folder name). */
export function isRun(value: unknown): value is Run {
  const r = value as Run
  return !!r && typeof r === 'object' && typeof r.id === 'string' && Array.isArray(r.order) && !!r.tasks && typeof r.tasks === 'object' && !!r.lead && Array.isArray(r.approvals)
}

export async function saveRun($: EngineInterface, run: Run): Promise<void> {
  await $.fs.write(`${run.dir}/run.json`, JSON.stringify(run, null, 2))
}

export async function loadRun($: EngineInterface, dir: string): Promise<Run | undefined> {
  try {
    const run = JSON.parse(await $.fs.read(`${dir}/run.json`)) as Run
    return isRun(run) ? run : undefined
  } catch {
    return undefined
  }
}

export async function listRuns($: EngineInterface, cfg: Config): Promise<string[]> {
  let entries: Awaited<ReturnType<EngineInterface['fs']['list']>>
  try {
    entries = await $.fs.list(`${await projectDir($, cfg)}/runs`)
  } catch {
    return []
  }
  return entries
    .filter(e => e.kind === 'dir')
    .map(e => e.name)
    .sort()
    .reverse()
}

/** Up to `limit` readable runs, newest first (folders an older Dispatch left are skipped). */
export async function recentRuns($: EngineInterface, cfg: Config, limit: number): Promise<Run[]> {
  const dir = `${await projectDir($, cfg)}/runs`
  const out: Run[] = []
  for (const id of await listRuns($, cfg)) {
    const r = await loadRun($, `${dir}/${id}`)
    if (r) out.push(r)
    if (out.length >= limit) break
  }
  return out
}
