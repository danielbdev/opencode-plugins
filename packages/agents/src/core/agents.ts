/**
 * Pure model for the subagent section.
 *
 * Everything here is host-free on purpose: the TUI plugin feeds it the session
 * records it already has, so the whole state mapping, the counts and the
 * formatters run under plain `node --test`.
 *
 * The fields come from `SessionInfo` in `@opencode/client`, verified rather
 * than assumed:
 *
 *   parentID?: string                                    // marks a subagent
 *   agent?: string                                       // the agent name
 *   outcome?: "succeeded" | "failed" | "interrupted"     // queryable state
 *   time: { created, updated, idle? }
 *
 * Liveness is not part of the record: `data.session.status(id)` reports it, so
 * the caller passes the running ids in.
 */

export type AgentState = "running" | "succeeded" | "failed" | "interrupted" | "idle"

/** The theme's semantic colour slots, so the view never names a colour. */
export type FeedbackKind = "success" | "warning" | "error" | "info"

/** The slice of a session record this module needs. */
export interface SessionLike {
  readonly id: string
  readonly parentID?: string
  readonly agent?: string
  readonly outcome?: "succeeded" | "failed" | "interrupted"
  readonly time?: {
    readonly created?: number
    readonly updated?: number
    readonly idle?: number
  }
}

export interface AgentEntry {
  readonly id: string
  readonly name: string
  readonly state: AgentState
  readonly elapsedMs: number
}

export interface AgentSummary {
  /** Only the subagents worth a line: running first, then the failed ones. */
  readonly entries: readonly AgentEntry[]
  readonly running: number
  readonly succeeded: number
  /** Failed and interrupted together: both stopped for a reason. */
  readonly failed: number
  /** Finished without failing: succeeded or simply no longer running. */
  readonly done: number
  readonly total: number
}

const UNNAMED = "subagent"

/** A recorded outcome wins over liveness; liveness only covers the gap before one exists. */
export function stateOf(session: SessionLike, running: boolean): AgentState {
  if (session.outcome === "succeeded") return "succeeded"
  if (session.outcome === "failed") return "failed"
  if (session.outcome === "interrupted") return "interrupted"
  return running ? "running" : "idle"
}

function elapsedOf(session: SessionLike, running: boolean, now: number): number {
  const created = session.time?.created
  if (created === undefined) return 0

  // A running subagent is measured against now; a finished one against when it
  // stopped, falling back to its last update when no idle stamp exists.
  const end = running ? now : (session.time?.idle ?? session.time?.updated ?? now)
  return Math.max(0, end - created)
}

function isSubagent(session: SessionLike): boolean {
  return session.parentID !== undefined
}

function isFailure(state: AgentState): boolean {
  return state === "failed" || state === "interrupted"
}

/** Subagents only: the root session is the session itself, not a child. */
export function summarize(
  sessions: readonly SessionLike[],
  runningIds: ReadonlySet<string>,
  now: number,
): AgentSummary {
  const entries: AgentEntry[] = []
  let running = 0
  let succeeded = 0
  let failed = 0
  let done = 0

  const listed: AgentEntry[] = []

  for (const session of sessions) {
    if (!isSubagent(session)) continue

    const isRunning = runningIds.has(session.id)
    const state = stateOf(session, isRunning)

    if (state === "running") running += 1
    if (state === "succeeded") succeeded += 1
    if (isFailure(state)) failed += 1
    if (state === "succeeded" || state === "idle") done += 1

    if (state === "running" || isFailure(state)) {
      listed.push({
        id: session.id,
        name: session.agent ?? UNNAMED,
        state,
        // Measured against the state actually shown, not the raw liveness bit: a
        // recorded outcome wins over liveness in `stateOf`, so keying the clock
        // off liveness would let a failed entry's duration keep growing.
        elapsedMs: elapsedOf(session, state === "running", now),
      })
    }
  }

  entries.push(
    ...listed.filter((entry) => entry.state === "running"),
    ...listed.filter((entry) => isFailure(entry.state)),
  )

  return { entries, running, succeeded, failed, done, total: running + done + failed }
}

export function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`

  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  return `${hours}h ${minutes}m`
}

export function formatCounts(summary: AgentSummary): string {
  if (summary.total === 0) return "no subagents yet"

  const parts = [`${summary.running} running`, `${summary.done} done`]
  if (summary.failed > 0) parts.push(`${summary.failed} failed`)
  return parts.join(" · ")
}

export function formatAgentLine(entry: AgentEntry): string {
  const elapsed = formatElapsed(entry.elapsedMs)
  return entry.state === "running"
    ? `${entry.name} · ${elapsed}`
    : `${entry.name} · ${entry.state} · ${elapsed}`
}

export function feedbackOf(state: AgentState): FeedbackKind {
  if (state === "failed" || state === "interrupted") return "error"
  if (state === "running") return "warning"
  if (state === "succeeded") return "success"
  return "info"
}

/** The count line takes the worst state present, so a failure colours the whole section. */
export function summaryFeedback(summary: AgentSummary): FeedbackKind {
  if (summary.failed > 0) return "error"
  if (summary.running > 0) return "warning"
  if (summary.done > 0) return "success"
  return "info"
}
