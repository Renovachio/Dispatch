// Token accounting: weighted tokens for budgets, API-price $ equivalent for reports.
import type { Config } from './config'
import type { Tier, Usage } from '../types'

export type { Usage }

export const zeroUsage = (): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    input_tokens: a.input_tokens + (b.input_tokens ?? 0),
    output_tokens: a.output_tokens + (b.output_tokens ?? 0),
    cache_read_input_tokens: a.cache_read_input_tokens + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: a.cache_creation_input_tokens + (b.cache_creation_input_tokens ?? 0),
  }
}

/** Map any model id or alias ("claude-sonnet-5-5", "sonnet", "opus[1m]") to a tier. */
export function tierOf(model: string | undefined): Tier {
  const m = (model ?? '').toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('opus') || m.includes('fable') || m.includes('mythos')) return 'opus'
  return 'sonnet'
}

export function totalTokens(u: Usage): number {
  return u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

/**
 * Budget weight: cache reads count at 10% (they are cheap and dominate agent loops);
 * everything else counts in full; then scaled by the tier weight.
 */
export function weightedTokens(u: Usage, tier: Tier, cfg: Pick<Config, 'weights'>): number {
  const raw = u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + 0.1 * u.cache_read_input_tokens
  return Math.round(raw * (cfg.weights[tier] ?? 1))
}

export function dollars(u: Usage, tier: Tier, cfg: Pick<Config, 'prices'>): number {
  const p = cfg.prices[tier]
  if (!p) return 0
  const usd =
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_input_tokens * p.cache_read +
      u.cache_creation_input_tokens * p.cache_write) /
    1_000_000
  return Math.round(usd * 10_000) / 10_000
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}
