/**
 * Pure model and formatting for the OpenCode Go usage windows.
 *
 * The payload shape was verified live against
 * `GET https://opencode.ai/inference/go/v1/usage`:
 *
 *   { "usage": { "rolling": { "status": "ok", "percent": 2,
 *                             "resetsAt": "2026-10-14T21:25:45.000Z" },
 *                "weekly":  { ... }, "monthly": { ... } } }
 *
 * The 5-hour window is named `rolling`. The three percentages are NOT
 * monotonic (observed: rolling 2% while weekly and monthly were 0%), so every
 * value is carried through exactly as received and never derived from another
 * window.
 *
 * This module is deliberately free of any host API so it stays testable with
 * plain `node --test`.
 */

export const WINDOW_KEYS = ["rolling", "weekly", "monthly"] as const

export type WindowKey = (typeof WINDOW_KEYS)[number]

/** Short label used in the compact status line. */
const SHORT_LABEL: Record<WindowKey, string> = {
  rolling: "5h",
  weekly: "wk",
  monthly: "mo",
}

/** Longer label used in the detail view. */
const LONG_LABEL: Record<WindowKey, string> = {
  rolling: "5h window",
  weekly: "Weekly",
  monthly: "Monthly",
}

export interface UsageWindow {
  readonly key: WindowKey
  readonly short: string
  readonly long: string
  /** Integer 0-100 as reported by the endpoint, or null when unavailable. */
  readonly percent: number | null
  /** ISO-8601 UTC reset instant, or null when unavailable. */
  readonly resetsAt: string | null
  /** Provider-reported status string, or null when unavailable. */
  readonly status: string | null
}

export interface UsageSnapshot {
  readonly fetchedAt: number
  readonly ok: boolean
  readonly error: string | null
  readonly windows: readonly UsageWindow[]
}

function unknownWindow(key: WindowKey): UsageWindow {
  return {
    key,
    short: SHORT_LABEL[key],
    long: LONG_LABEL[key],
    percent: null,
    resetsAt: null,
    status: null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function readInstant(value: unknown): string | null {
  if (typeof value !== "string") return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

function readStatus(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function parseWindow(key: WindowKey, raw: unknown): UsageWindow {
  if (!isRecord(raw)) return unknownWindow(key)
  return {
    key,
    short: SHORT_LABEL[key],
    long: LONG_LABEL[key],
    percent: readPercent(raw.percent),
    resetsAt: readInstant(raw.resetsAt),
    status: readStatus(raw.status),
  }
}

/** Snapshot for any failure: no windows, an explicit message. */
export function errorSnapshot(message: string, now: number): UsageSnapshot {
  return {
    fetchedAt: now,
    ok: false,
    error: message,
    windows: WINDOW_KEYS.map(unknownWindow),
  }
}

/**
 * Parse an endpoint payload into a snapshot.
 *
 * A malformed or missing window degrades to an unknown window. Only a payload
 * that is not an object at all fails the whole snapshot.
 */
export function parseUsage(payload: unknown, now: number): UsageSnapshot {
  if (!isRecord(payload)) return errorSnapshot("Malformed usage response", now)

  const usage = payload.usage
  if (!isRecord(usage)) return errorSnapshot("Usage response has no usage object", now)

  return {
    fetchedAt: now,
    ok: true,
    error: null,
    windows: WINDOW_KEYS.map((key) => parseWindow(key, usage[key])),
  }
}

/**
 * Defensive parse of a snapshot that crossed the RPC boundary.
 *
 * Windows are matched positionally to WINDOW_KEYS, so a reordered or missing
 * entry degrades to an unknown window. Returns null only when the value is not
 * a snapshot at all.
 */
export function parseSnapshot(value: unknown): UsageSnapshot | null {
  if (!isRecord(value)) return null

  const rawWindows = value.windows
  if (!Array.isArray(rawWindows)) return null

  return {
    fetchedAt:
      typeof value.fetchedAt === "number" && Number.isFinite(value.fetchedAt) ? value.fetchedAt : 0,
    ok: value.ok === true,
    error: typeof value.error === "string" && value.error.length > 0 ? value.error : null,
    windows: WINDOW_KEYS.map((key, index) => parseWindow(key, rawWindows[index])),
  }
}

export function formatPercent(percent: number | null): string {
  return percent === null ? "—" : `${percent}%`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Human countdown to a reset instant. */
export function formatReset(resetsAt: string | null, now: number): string {
  if (resetsAt === null) return "unknown"

  const target = Date.parse(resetsAt)
  if (Number.isNaN(target)) return "unknown"

  const remaining = target - now
  if (remaining <= 0) return "resetting"

  const days = Math.floor(remaining / DAY)
  const hours = Math.floor((remaining % DAY) / HOUR)
  const minutes = Math.floor((remaining % HOUR) / MINUTE)

  if (days > 0) return `resets in ${days}d ${hours}h`
  if (hours > 0) return minutes > 0 ? `resets in ${hours}h ${minutes}m` : `resets in ${hours}h`
  return `resets in ${minutes}m`
}

/** One window as a single line, e.g. `5h 2% · resets in 50m`. */
export function formatWindow(window: UsageWindow, now: number): string {
  return `${window.short} ${formatPercent(window.percent)} · ${formatReset(window.resetsAt, now)}`
}

/** One window as a detail row, e.g. `5h window   2%   resets in 50m`. */
export function formatWindowDetail(window: UsageWindow, now: number): string {
  return `${window.long.padEnd(10)} ${formatPercent(window.percent).padStart(4)}   ${formatReset(
    window.resetsAt,
    now,
  )}`
}

/** Compact status line for the TUI slot, e.g. `GO 5h 2% · wk 0% · mo 0%`. */
export function formatSummary(snapshot: UsageSnapshot, _now: number): string {
  if (!snapshot.ok) return "GO usage unavailable"
  return `GO ${snapshot.windows.map((w) => `${w.short} ${formatPercent(w.percent)}`).join(" · ")}`
}
