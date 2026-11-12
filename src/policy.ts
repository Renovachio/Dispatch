// Policy decisions, pure so they can be tested: which tool calls a role may make
// during a run, and whether an outward call matches an approval exactly.
import type { Config } from './config'
import type { Approval, Run } from '../types'
import { canonical, ownsPath } from './state'

const BROWSER_PREFIX = 'mcp__claude-in-chrome__'
const ENVELOPE = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta'])

export type Decision =
  | { allow: true; useApproval?: string }
  | { allow: false; reason: string }

export type Call = {
  tool: string
  agentId?: string
  input: Record<string, unknown>
}

export function callArgs(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) if (!ENVELOPE.has(k)) out[k] = v
  return out
}

/** "mcp__server__tool_name" → "tool_name"; plugin servers look like mcp__plugin_x_y__tool. */
export function mcpToolName(tool: string): string {
  const i = tool.indexOf('__', 5)
  return i >= 0 ? tool.slice(i + 2) : tool
}

export const OWN_TOOL = 'mcp__dispatch__run'
export const isOwnTool = (tool: string) => tool === OWN_TOOL

/** Resolve "." and ".." so a path cannot climb out of an allowed folder. */
export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return (path.startsWith('/') ? '/' : '') + out.join('/')
}

/** Files that hold Dispatch's own state or policy: no agent may write them. */
export function isProtected(file: string): boolean {
  return /(^|\/)run\.json$/.test(file) || /(^|\/)\.dispatch2?\/config\.json$/.test(file) || /(^|\/)\.dispatch2?\/(learnings\.md|playbooks\/)/.test(file)
}

const PROTECTED_IN_SHELL = /run\.json|\.dispatch2?\/(config\.json|learnings\.md|playbooks)/

export function isReadMcp(tool: string, cfg: Config): boolean {
  const name = mcpToolName(tool)
  return cfg.outward.read_patterns.some(p => new RegExp(p, 'i').test(name))
}

export function roleOf(run: Run, agentId: string | undefined): string {
  if (!agentId) return 'lead'
  return run.agents[agentId]?.role ?? 'other'
}

function findApproval(run: Run, task: string | undefined, tool: string, args: string): Approval | undefined {
  return run.approvals.find(
    a => a.approved && !a.used && a.tool === tool && a.args === args && (task === undefined || a.task === task),
  )
}

export function decide(run: Run, cfg: Config, call: Call): Decision {
  const { tool, agentId, input } = call
  if (isOwnTool(tool)) return { allow: true }
  const role = roleOf(run, agentId)
  const task = agentId ? run.agents[agentId]?.task : undefined
  const owned = task ? run.tasks[task]?.paths ?? [] : []

  // File writes: inside the run folder or the task's owned paths; never Dispatch's own state or policy.
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit') {
    const raw = String(input.file_path ?? input.notebook_path ?? '')
    if (!raw) return { allow: true }
    const file = normalize(raw.startsWith('/') ? raw : `${run.project}/${raw}`)
    if (isProtected(file)) return { allow: false, reason: `Dispatch: ${file} holds Dispatch state or policy; only the mod writes it.` }
    if (ownsPath(file, [run.dir], run.project)) return { allow: true }
    if (role === 'other') return { allow: true }
    if (ownsPath(file, owned, run.project)) return { allow: true }
    return {
      allow: false,
      reason: `Dispatch: ${role} may not edit ${file}. Owned paths: ${owned.length ? owned.join(', ') : 'none'}. Write deliverables under ${run.dir}/ or report the needed change.`,
    }
  }

  // Shell: no touching Dispatch state; publishing or history-changing commands need an exact approval
  // (operator only).
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '')
    if (PROTECTED_IN_SHELL.test(cmd)) return { allow: false, reason: 'Dispatch: shell access to Dispatch state or policy files is blocked.' }
    const hit = cfg.outward.bash_block.find(p => new RegExp(p).test(cmd))
    if (!hit) return { allow: true }
    if (role === 'operator') {
      const approval = findApproval(run, task, 'Bash', canonical({ command: cmd }))
      if (approval) return { allow: true, useApproval: approval.id }
      return { allow: false, reason: 'Dispatch: this command acts outside the machine and was not approved exactly (tool "Bash", args {command}).' }
    }
    return { allow: false, reason: `Dispatch: this command acts outside the machine (${hit}). Propose it as an action in your result instead.` }
  }

  if (!tool.startsWith('mcp__')) return { allow: true }

  // Browser: reading tools are free; acting tools need an approved browser session for the task.
  if (tool.startsWith(BROWSER_PREFIX)) {
    if (isReadMcp(tool, cfg)) return { allow: true }
    if (role !== 'operator') return { allow: false, reason: `Dispatch: only dispatch:operator may drive the browser. Propose a browser action instead.` }
    const session = run.approvals.find(a => a.approved && a.tool === 'browser' && (task === undefined || a.task === task))
    return session ? { allow: true } : { allow: false, reason: 'Dispatch: no approved browser session for this task.' }
  }

  // Connectors: researchers stay off internal sources unless the run allows it.
  if (role === 'researcher' && !run.allowInternalToWeb) {
    return { allow: false, reason: 'Dispatch: researchers do not read internal connectors in this run (data rule). Ask the lead for the content you need.' }
  }
  if (isReadMcp(tool, cfg)) return { allow: true }

  // Outward MCP call.
  if (role !== 'operator') {
    return { allow: false, reason: `Dispatch: ${tool} changes something outside this machine. Only dispatch:operator runs approved actions; put it in your result as a proposed action.` }
  }
  if (cfg.outward.allow_actions.some(p => new RegExp(p).test(tool))) return { allow: true }
  const approval = findApproval(run, task, tool, canonical(input))
  return approval
    ? { allow: true, useApproval: approval.id }
    : { allow: false, reason: `Dispatch: ${tool} with these exact arguments was not approved. Run only the approved actions, unchanged.` }
}

export function destinationAllowed(target: string | undefined, cfg: Config): boolean {
  const allow = cfg.outward.destinations.allow
  if (!allow.length || !target) return true
  return allow.some(p => new RegExp(p, 'i').test(target))
}
