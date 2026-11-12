// Dispatch domain types and its $.state contract. Self-contained by rule.

export type Tier = 'haiku' | 'sonnet' | 'opus'
export type Role = 'scout' | 'researcher' | 'builder' | 'writer' | 'operator' | 'reviewer' | 'planner'
export type Size = 'small' | 'medium' | 'large'

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type TaskStatus = 'planned' | 'running' | 'done' | 'failed' | 'skipped'

export type Task = {
  id: string
  role: Role
  title: string
  skills: string[]
  paths: string[]
  depends_on: string[]
  status: TaskStatus
  attempts: number
  tier?: Tier
  summary?: string
  deliverables: string[]
  /** Small runs only: the lead does this task itself instead of spawning an agent. */
  inline?: boolean
}

export type AgentRec = {
  id: string
  task?: string
  role: string
  tier: Tier
  model: string
  description: string
  status: 'running' | 'done' | 'failed'
  usage: Usage
  startedAt: number
  endedAt?: number
  /** Has read internal-connector content in this run (blocks web tools unless the run allows it). */
  tainted?: boolean
}

export type Approval = {
  id: string
  task: string
  tool: string
  /** Canonical JSON of the exact arguments approved. */
  args: string
  summary: string
  approved: boolean
  used: boolean
  /** Proposed while nobody could be asked (a scheduled or headless run): waits for the person. */
  queued?: boolean
}

/** waiting: finished, with outward actions queued for the person to approve. */
export type RunStatus = 'active' | 'paused' | 'done' | 'failed' | 'cancelled' | 'waiting'

export type Run = {
  id: string
  objective: string
  title: string
  size: Size
  status: RunStatus
  project: string
  dir: string
  createdAt: number
  updatedAt: number
  budget: number
  allowInternalToWeb: boolean
  tasks: Record<string, Task>
  order: string[]
  agents: Record<string, AgentRec>
  lead: Usage
  leadTier: Tier
  approvals: Approval[]
  log: string[]
  summary?: string
  /** Set at finish: the lead's last turn is still to be added to the cost. */
  leadPending?: boolean
  /** The lead has read internal-connector content. */
  leadTainted?: boolean
  /** Files already changed in git when the run started (scope check baseline); absent outside git. */
  baseline?: string[]
  /** Started by this schedule (its id). */
  schedule?: string
}

export type Cadence = 'daily' | 'weekdays' | 'weekly' | 'monthly'

/** A recurring run, kept in the project's `.dispatch/schedules.json` (personal, git-ignored). */
export type Schedule = {
  id: string
  /** The request, as the person would type it after /dispatch. */
  request: string
  /** A saved playbook in `.dispatch/playbooks/` the run follows, if any. */
  playbook?: string
  every: Cadence
  /** Local time, "HH:MM". */
  at: string
  /** weekly: 0 (Sunday) to 6; monthly: 1 to 28. */
  day?: number
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  lastRunId?: string
}

declare module 'claude-code' {
  interface PluginState {
    dispatch: { run: Shaped<Run | null> }
  }
}
