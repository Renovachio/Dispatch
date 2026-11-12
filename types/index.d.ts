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
}

export type RunStatus = 'active' | 'paused' | 'done' | 'failed' | 'cancelled'

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
}

declare module 'claude-code' {
  interface PluginState {
    dispatch: { run: Shaped<Run | null> }
  }
}
