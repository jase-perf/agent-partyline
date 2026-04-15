/**
 * quota.ts — Poll Anthropic API rate limit headers to track quota usage.
 *
 * Sends a minimal Haiku request every N minutes and parses the
 * anthropic-ratelimit-unified-* headers to get 5-hour and 7-day
 * utilization, reset times, and fallback status.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

export interface QuotaStatus {
  /** 5-hour rolling window utilization (0.0 - 1.0) */
  fiveHourUtilization: number
  /** 5-hour window reset (unix timestamp seconds) */
  fiveHourReset: number
  /** 7-day rolling window utilization (0.0 - 1.0) */
  sevenDayUtilization: number
  /** 7-day window reset (unix timestamp seconds) */
  sevenDayReset: number
  /** Overage utilization (0.0 - 1.0) */
  overageUtilization: number
  /** Overage reset (unix timestamp seconds) */
  overageReset: number
  /** Whether the rate limit is currently allowing requests */
  status: string
  /** Whether fallback model is available */
  fallbackAvailable: boolean
  /** Fallback percentage threshold */
  fallbackPercentage: number
  /** When this data was last fetched */
  fetchedAt: string
}

const CREDENTIALS_PATH = resolve(
  process.env.HOME ?? '/home/claude',
  '.claude/.credentials.json',
)

function getOAuthToken(): string | null {
  try {
    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8')) as {
      claudeAiOauth?: { accessToken?: string }
    }
    return creds.claudeAiOauth?.accessToken ?? null
  } catch {
    return null
  }
}

let latestQuota: QuotaStatus | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

async function fetchQuota(): Promise<QuotaStatus | null> {
  const token = getOAuthToken()
  if (!token) return null

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      }),
    })

    const h = (name: string): string => resp.headers.get(name) ?? ''

    const quota: QuotaStatus = {
      fiveHourUtilization: parseFloat(h('anthropic-ratelimit-unified-5h-utilization')) || 0,
      fiveHourReset: parseInt(h('anthropic-ratelimit-unified-5h-reset'), 10) || 0,
      sevenDayUtilization: parseFloat(h('anthropic-ratelimit-unified-7d-utilization')) || 0,
      sevenDayReset: parseInt(h('anthropic-ratelimit-unified-7d-reset'), 10) || 0,
      overageUtilization: parseFloat(h('anthropic-ratelimit-unified-overage-utilization')) || 0,
      overageReset: parseInt(h('anthropic-ratelimit-unified-overage-reset'), 10) || 0,
      status: h('anthropic-ratelimit-unified-status') || 'unknown',
      fallbackAvailable: h('anthropic-ratelimit-unified-fallback') === 'available',
      fallbackPercentage: parseFloat(h('anthropic-ratelimit-unified-fallback-percentage')) || 0,
      fetchedAt: new Date().toISOString(),
    }

    // Consume the response body to free the connection
    await resp.text()

    latestQuota = quota
    return quota
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[quota] fetch error: ${msg}\n`)
    return null
  }
}

/** Start polling quota every intervalMs (default 5 minutes). */
export function startQuotaPoller(intervalMs: number = 300_000): void {
  // Fetch immediately, then on interval
  void fetchQuota()
  pollTimer = setInterval(() => void fetchQuota(), intervalMs)
}

/** Stop polling. */
export function stopQuotaPoller(): void {
  if (pollTimer) clearInterval(pollTimer)
}

/** Get the most recent quota status. */
export function getQuota(): QuotaStatus | null {
  return latestQuota
}
