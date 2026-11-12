// Layered config: plugin defaults → team → project → user. A key a layer lists in
// `locked` (dotted path, e.g. "budgets.large") cannot be changed by later layers.
import type { EngineInterface } from 'claude-code'

import type { Role, Size, Tier } from '../types'

export type { Role, Size, Tier }

export type Price = { model: string; input: number; output: number; cache_read: number; cache_write: number }

export type Config = {
  locked: string[]
  storage: { home: string; project: string }
  tiers: Record<string, Tier>
  escalation: Tier[]
  budgets: Record<Size, number>
  weights: Record<Tier, number>
  prices: Record<Tier, Price>
  outward: {
    read_patterns: string[]
    allow_actions: string[]
    destinations: { allow: string[] }
    bash_block: string[]
  }
  data: { allow_internal_to_web: boolean }
  retries: { max: number; escalate: boolean }
}

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Merge `over` onto `base`, skipping any dotted path in `locked`. Pure; exported for tests. */
export function mergeLayer(base: Json, over: Json, locked: readonly string[], prefix = ''): Json {
  const out: Json = { ...base }
  for (const [key, value] of Object.entries(over)) {
    if (key === '$comment' || key === 'locked') continue
    const path = prefix ? `${prefix}.${key}` : key
    if (locked.some(l => l === path || path.startsWith(`${l}.`))) continue
    out[key] = isObject(value) && isObject(base[key])
      ? mergeLayer(base[key] as Json, value, locked, path)
      : value
  }
  return out
}

/** Fold layers in order; each layer's `locked` adds to the locks for the layers after it. */
export function mergeLayers(layers: readonly Json[]): Json {
  let merged: Json = {}
  let locked: string[] = []
  for (const layer of layers) {
    merged = mergeLayer(merged, layer, locked)
    const add = Array.isArray(layer.locked) ? (layer.locked as string[]) : []
    locked = [...new Set([...locked, ...add])]
  }
  merged.locked = locked
  return merged
}

export async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? '~'
}

export function expand(path: string, homeDir: string): string {
  return path.startsWith('~') ? homeDir + path.slice(1) : path
}

async function readJson($: EngineInterface, path: string): Promise<Json | undefined> {
  try {
    if (!(await $.fs.exists(path))) return undefined
    const parsed: unknown = JSON.parse(await $.fs.read(path))
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function loadConfig($: EngineInterface): Promise<Config> {
  const root = $.plugin.root
  const homeDir = await home($)
  const defaults = (await readJson($, `${root}/config/defaults.json`)) ?? {}
  const teamPath = (await $.env.get('DISPATCH_TEAM_CONFIG')) ?? `${root}/config/team.json`
  const storage = (defaults.storage ?? { home: '~/.dispatch', project: '.dispatch' }) as Config['storage']
  const cwd = await $.session.cwd()
  const layers = [
    defaults,
    (await readJson($, expand(teamPath, homeDir))) ?? {},
    (await readJson($, `${cwd}/${storage.project}/config.json`)) ?? {},
    (await readJson($, `${expand(storage.home, homeDir)}/config.json`)) ?? {},
  ]
  return mergeLayers(layers) as unknown as Config
}
