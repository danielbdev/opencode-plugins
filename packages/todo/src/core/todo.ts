/**
 * Pure model for the agent-owned to-do list.
 *
 * The list lives in the **session history**, not in plugin memory: every tool
 * result carries the whole snapshot, and the section replays the last one. That
 * is why reloading, switching session or restarting reconstructs the state
 * without the plugin persisting anything.
 *
 * Host-free on purpose, so the state machine, the replay and the formatters all
 * run under plain `node --test`.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export type TodoAction = "write" | "update" | "clear"

/** The theme's semantic colour slots, so the view never names a colour. */
export type FeedbackKind = "success" | "warning" | "error" | "info"

export interface TodoItem {
  readonly id: string
  readonly text: string
  readonly status: TodoStatus
}

export interface TodoState {
  readonly items: readonly TodoItem[]
  /** The counter behind the next id, so ids stay stable across updates. */
  readonly nextId: number
}

export interface TodoInput {
  readonly action: TodoAction
  /** For `write`: the new list, in order. */
  readonly items?: readonly string[]
  /** For `update`: which item. */
  readonly id?: string
  /** For `update`: the status to set. */
  readonly status?: TodoStatus
}

/** The key the snapshot rides under inside the tool result metadata. */
export const TODO_METADATA_KEY = "todo"

/** The tool name the model calls and the replay looks for. */
export const TODO_TOOL_NAME = "todo"

export const EMPTY_TODO: TodoState = { items: [], nextId: 1 }

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value)
}

function parseItem(value: unknown): TodoItem | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== "string" || typeof value.text !== "string") return null
  if (!isStatus(value.status)) return null
  return { id: value.id, text: value.text, status: value.status }
}

/** Defensive parse of a snapshot that crossed the tool boundary. */
export function parseState(value: unknown): TodoState | null {
  if (!isRecord(value)) return null

  const rawItems = value.items
  if (!Array.isArray(rawItems)) return null

  const items: TodoItem[] = []
  for (const raw of rawItems) {
    const item = parseItem(raw)
    if (item === null) return null
    items.push(item)
  }

  const nextId = typeof value.nextId === "number" && Number.isFinite(value.nextId) ? value.nextId : items.length + 1

  return { items, nextId }
}

/** The snapshot carried by a tool result, if that result is one of ours. */
export function readSnapshot(metadata: unknown): TodoState | null {
  if (!isRecord(metadata)) return null
  return parseState(metadata[TODO_METADATA_KEY])
}

/**
 * Apply one action.
 *
 * `write` replaces the whole list and renumbers it from one; `update` changes a
 * single item's status and leaves every other id untouched; `clear` empties it.
 * An `update` that names an item that is not there changes nothing, so a stale
 * call from the model is harmless.
 */
export function applyTodo(state: TodoState, input: TodoInput): TodoState {
  if (input.action === "clear") return EMPTY_TODO

  if (input.action === "write") {
    const texts = input.items ?? []
    return {
      items: texts.map((text, index) => ({ id: String(index + 1), text, status: "pending" as const })),
      nextId: texts.length + 1,
    }
  }

  if (input.action === "update") {
    if (typeof input.id !== "string" || !isStatus(input.status)) return state

    let changed = false
    const items = state.items.map((item) => {
      if (item.id !== input.id) return item
      changed = true
      return { ...item, status: input.status as TodoStatus }
    })

    return changed ? { ...state, items } : state
  }

  return state
}

export interface ToolResultLike {
  readonly name: string
  readonly status: string
  readonly metadata?: unknown
}

/** The slice of a session message the extraction needs. */
export interface MessageLike {
  readonly type?: string
  readonly content?: readonly unknown[]
}

/**
 * Pull this tool's results out of a session's messages, in order.
 *
 * Both halves use it, which is why it lives here: the server replays the history
 * on every call instead of keeping state, and the TUI replays it to render. The
 * history is the single source of truth for the list.
 *
 * The input is typed `unknown` because it comes straight from the host: the
 * shape is validated here rather than trusted. A `MessageLike` is what it looks
 * like when well formed.
 */
export function toolResultsFrom(messages: readonly unknown[], toolName: string): ToolResultLike[] {
  const results: ToolResultLike[] = []

  for (const message of messages) {
    if (!isRecord(message)) continue
    if (message.type !== "assistant") continue
    if (!Array.isArray(message.content)) continue

    for (const part of message.content) {
      if (!isRecord(part)) continue
      if (part.type !== "tool" || part.name !== toolName) continue

      const state = part.state
      if (!isRecord(state)) continue

      results.push({
        name: toolName,
        status: typeof state.status === "string" ? state.status : "unknown",
        metadata: state.metadata,
      })
    }
  }

  return results
}

/** Rebuild the list from the message history: the last completed call wins. */
export function replayTodo(results: readonly ToolResultLike[], toolName: string): TodoState | null {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index]
    if (result === undefined) continue
    if (result.name !== toolName) continue
    if (result.status !== "completed") continue

    const snapshot = readSnapshot(result.metadata)
    if (snapshot !== null) return snapshot
  }

  return null
}

/** What the count line shows: progress, or an explicit empty state. */
export function formatSummary(state: TodoState): string {
  if (state.items.length === 0) return "no tasks yet"

  const done = state.items.filter((item) => item.status === "completed").length
  return `${done} of ${state.items.length} done`
}

export function formatItem(item: TodoItem): string {
  if (item.status === "in_progress") return `[~] ${item.text}`
  if (item.status === "completed") return `[x] ${item.text}`
  if (item.status === "cancelled") return `[-] ${item.text}`
  return `[ ] ${item.text}`
}

/** The open work: what still needs doing, in list order. */
export function visibleItems(state: TodoState): readonly TodoItem[] {
  return state.items.filter((item) => item.status === "pending" || item.status === "in_progress")
}

export function feedbackOf(status: TodoStatus): FeedbackKind {
  if (status === "in_progress") return "warning"
  if (status === "completed") return "success"
  return "info"
}

/** The count line takes the worst state present: running work outranks a finished list. */
export function summaryFeedback(state: TodoState): FeedbackKind {
  if (state.items.some((item) => item.status === "in_progress")) return "warning"
  if (state.items.length > 0 && state.items.every((item) => item.status === "completed")) return "success"
  return "info"
}
