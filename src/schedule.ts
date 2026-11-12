// Scheduled runs: when a schedule is due (pure, tested), its cron line, and the schedules file.
// Times are local: callers pass the local offset in minutes east of UTC (-new Date().getTimezoneOffset()).
import type { EngineInterface } from 'claude-code'
import type { Config } from './config'
import type { Cadence, Schedule } from '../types'
import { ensureProjectDir, projectDir } from './state'

export type { Schedule } from '../types'

const DAY = 86_400_000
const CADENCES: readonly Cadence[] = ['daily', 'weekdays', 'weekly', 'monthly']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export type ScheduleInput = { id?: string; request?: string; playbook?: string; every?: string; at?: string; day?: number }

/** Errors in a new schedule, empty when it is valid. */
export function checkSchedule(s: ScheduleInput, existing: readonly Schedule[]): string[] {
  const errors: string[] = []
  if (!s.id || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(s.id)) errors.push('id: lowercase letters, digits and dashes, up to 40')
  else if (existing.some(x => x.id === s.id)) errors.push(`id ${s.id} already exists: remove it first`)
  if (!s.request?.trim()) errors.push('request is required')
  if (!CADENCES.includes(s.every as Cadence)) errors.push(`every: one of ${CADENCES.join(', ')}`)
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at ?? '')) errors.push('at: local time as HH:MM')
  if (s.every === 'weekly' && !(Number.isInteger(s.day) && s.day! >= 0 && s.day! <= 6)) errors.push('day: 0 (Sunday) to 6 for weekly')
  if (s.every === 'monthly' && !(Number.isInteger(s.day) && s.day! >= 1 && s.day! <= 28)) errors.push('day: 1 to 28 for monthly')
  if (s.playbook !== undefined && !/^[a-z0-9-]+$/.test(s.playbook)) errors.push('playbook: a name from .dispatch/playbooks/')
  return errors
}

/** Does the schedule run on this local calendar day? `d` is a UTC-shifted date standing for local time. */
function runsOn(s: Schedule, d: Date): boolean {
  const wd = d.getUTCDay()
  if (s.every === 'daily') return true
  if (s.every === 'weekdays') return wd >= 1 && wd <= 5
  if (s.every === 'weekly') return wd === s.day
  return d.getUTCDate() === s.day
}

/** The slot (epoch ms) on the local day containing `localMs`, at the schedule's time. */
function slotOn(s: Schedule, localMs: number, offsetMin: number): number {
  const [h, m] = s.at.split(':').map(Number)
  const day = Math.floor(localMs / DAY) * DAY
  return day + (h * 60 + m) * 60_000 - offsetMin * 60_000
}

/** The latest slot at or before `now`, or undefined if none in the last 40 days. */
export function previousSlot(s: Schedule, now: number, offsetMin: number): number | undefined {
  const local = now + offsetMin * 60_000
  for (let i = 0; i <= 40; i++) {
    const dayLocal = local - i * DAY
    if (!runsOn(s, new Date(dayLocal))) continue
    const slot = slotOn(s, dayLocal, offsetMin)
    if (slot <= now) return slot
  }
  return undefined
}

/** The next slot after `now`. */
export function nextSlot(s: Schedule, now: number, offsetMin: number): number | undefined {
  const local = now + offsetMin * 60_000
  for (let i = 0; i <= 40; i++) {
    const dayLocal = local + i * DAY
    if (!runsOn(s, new Date(dayLocal))) continue
    const slot = slotOn(s, dayLocal, offsetMin)
    if (slot > now) return slot
  }
  return undefined
}

/** Due when a slot has passed since it last ran (or since it was created). Missed slots run once. */
export function isDue(s: Schedule, now: number, offsetMin: number): boolean {
  if (!s.enabled) return false
  const prev = previousSlot(s, now, offsetMin)
  return prev !== undefined && prev > (s.lastRunAt ?? s.createdAt)
}

/** A crontab line that starts the headless runner at the schedule's time. */
export function cronLine(s: Schedule, runner: string, project: string, pluginDir?: string): string {
  const [h, m] = s.at.split(':').map(Number)
  const dow = s.every === 'weekdays' ? '1-5' : s.every === 'weekly' ? String(s.day) : '*'
  const dom = s.every === 'monthly' ? String(s.day) : '*'
  const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`
  const env = pluginDir ? `DISPATCH_PLUGIN_DIR=${q(pluginDir)} ` : ''
  return `${m} ${h} ${dom} * ${dow} ${env}${q(runner)} ${q(project)}`
}

export function describe(s: Schedule): string {
  const when =
    s.every === 'daily' ? 'every day' :
    s.every === 'weekdays' ? 'every weekday' :
    s.every === 'weekly' ? `every ${WEEKDAYS[s.day ?? 1]}` :
    `on day ${s.day} of every month`
  return `${when} at ${s.at}`
}

/** Local offset in minutes east of UTC, at `now`. */
export const localOffset = (now: number) => -new Date(now).getTimezoneOffset()

// ---------- IO ----------

export async function schedulesPath($: EngineInterface, cfg: Config): Promise<string> {
  return `${await projectDir($, cfg)}/schedules.json`
}

export async function loadSchedules($: EngineInterface, cfg: Config): Promise<Schedule[]> {
  try {
    const parsed = JSON.parse(await $.fs.read(await schedulesPath($, cfg)))
    return Array.isArray(parsed) ? (parsed as Schedule[]).filter(s => s && typeof s.id === 'string' && typeof s.at === 'string') : []
  } catch {
    return []
  }
}

export async function saveSchedules($: EngineInterface, cfg: Config, list: readonly Schedule[]): Promise<void> {
  await ensureProjectDir($, cfg)
  await $.fs.write(await schedulesPath($, cfg), `${JSON.stringify(list, null, 2)}\n`)
}
