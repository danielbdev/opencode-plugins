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

/** The description the model reads. It is also what tells our tool apart from another plugin's. */
export const TODO_TOOL_DESCRIPTION =
  "Set and maintain the plan for the task at hand. write replaces the list with the given items, update changes one item's status by id, clear empties it. Call it whenever the plan changes so the user can follow along. Returns the full list."

/**
 * Conventional names a task list can go by.
 *
 * `task` is deliberately absent: in OpenCode that is the subagent tool, not a
 * plan, and treating it as a conflict would make this plugin step aside for the
 * wrong thing.
 */
const TASK_TOOL_NAMES: readonly string[] = ["todo", "todowrite", "todos"]

/**
 * Whether a registered tool is somebody else's task list.
 *
 * The description is the discriminator, not the name: when this plugin reloads,
 * its own tool is still in the registry, and matching on the name alone would
 * make it step aside for itself.
 */
export function isForeignTaskTool(tool: {
  readonly name: string
  readonly description: string
}): boolean {
  if (!TASK_TOOL_NAMES.includes(tool.name)) return false
  return tool.description !== TODO_TOOL_DESCRIPTION
}

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

/**
 * One recorded call to the todo tool, however it was reached.
 *
 * A first-class call leaves its own tool part and carries the snapshot the tool
 * wrote. A call made through Code Mode is nested inside an `execute` part, which
 * records what ran but not what it returned, so there the actions are folded.
 */
export interface TodoEvent {
  readonly snapshot: TodoState | null
  readonly actions: readonly TodoInput[]
}

/** The tool OpenCode uses to run other tools from JavaScript. */
const CODE_MODE_TOOL = "execute"

function parseInput(value: unknown): TodoInput | null {
  if (!isRecord(value)) return null

  const action = value.action
  if (action !== "write" && action !== "update" && action !== "clear") return null

  const items =
    Array.isArray(value.items) && value.items.every((item) => typeof item === "string")
      ? (value.items as readonly string[])
      : undefined
  const id = typeof value.id === "string" ? value.id : undefined
  const status = isStatus(value.status) ? value.status : undefined

  return { action, items, id, status }
}

/** The calls a Code Mode wrapper recorded inside its own metadata. */
function nestedActions(metadata: unknown, toolName: string): TodoInput[] {
  if (!isRecord(metadata)) return []

  const calls = metadata.toolCalls
  if (!Array.isArray(calls)) return []

  const actions: TodoInput[] = []
  for (const call of calls) {
    if (!isRecord(call)) continue
    if (call.tool !== toolName) continue
    if (call.status !== "completed") continue

    const parsed = parseInput(call.input)
    if (parsed !== null) actions.push(parsed)
  }

  return actions
}

/**
 * Pull this tool's calls out of a session's messages, in order.
 *
 * Both halves use it, which is why it lives here: the server replays the history
 * when a session is first touched, and the TUI replays it to render. The history
 * is the single source of truth for the list.
 *
 * The input is typed `unknown` because it comes straight from the host: the shape
 * is validated here rather than trusted.
 */
export function todoEventsFrom(messages: readonly unknown[], toolName: string): TodoEvent[] {
  const events: TodoEvent[] = []

  for (const message of messages) {
    if (!isRecord(message)) continue
    if (message.type !== "assistant") continue
    if (!Array.isArray(message.content)) continue

    for (const part of message.content) {
      if (!isRecord(part)) continue
      if (part.type !== "tool") continue

      const state = part.state
      if (!isRecord(state)) continue
      if (state.status !== "completed") continue

      if (part.name === toolName) {
        const snapshot = readSnapshot(state.metadata)
        if (snapshot !== null) {
          events.push({ snapshot, actions: [] })
          continue
        }

        // No snapshot: fall back to the arguments it was called with.
        const action = parseInput(state.input)
        if (action !== null) events.push({ snapshot: null, actions: [action] })
        continue
      }

      // Code Mode runs other tools inside itself: the wrapper keeps no tool part
      // of its own for them, so the calls are read out of its metadata instead.
      if (part.name === CODE_MODE_TOOL) {
        const actions = nestedActions(state.metadata, toolName)
        if (actions.length > 0) events.push({ snapshot: null, actions })
      }
    }
  }

  return events
}

/**
 * Rebuild the list from the recorded calls.
 *
 * A snapshot wins wherever one exists, because it is the frozen record the tool
 * wrote. Where there is none (a call reached through Code Mode) the actions are
 * folded in order onto the state so far, which lands on the same result because
 * the state machine is deterministic.
 */
export function replayTodo(events: readonly TodoEvent[]): TodoState {
  let state = EMPTY_TODO

  for (const event of events) {
    if (event.snapshot !== null) {
      state = event.snapshot
      continue
    }

    for (const action of event.actions) state = applyTodo(state, action)
  }

  return state
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

/** The theme slots this list uses. There is no failure colour: a to-do cannot fail. */
export type TodoTone = "base" | "muted" | "warning" | "success"

/** One session's list, with the agent that owns it. */
export interface AgentList {
  readonly sessionID: string
  readonly agent: string | null
  readonly root: boolean
  readonly state: TodoState
}

/**
 * Group the lists by session: the one being viewed first, then each subagent that
 * has one, so a delegated plan is visible without opening its session.
 *
 * It lives here rather than in the agents package on purpose: reading a plan means
 * knowing about the todo tool, and a package that knew about both would couple two
 * capabilities that are independent today.
 */
export function groupBySession(
  sessions: readonly {
    readonly id: string
    readonly agent?: string
    readonly messages: readonly unknown[]
  }[],
  rootID: string,
  toolName: string,
): AgentList[] {
  const groups: AgentList[] = []

  for (const session of sessions) {
    const state = replayTodo(todoEventsFrom(session.messages, toolName))
    if (state.items.length === 0) continue

    groups.push({
      sessionID: session.id,
      agent: session.agent ?? null,
      root: session.id === rootID,
      state,
    })
  }

  return groups.sort((left, right) => Number(right.root) - Number(left.root))
}

/** Pending and cancelled are muted: neither is work in flight. */
export function toneOf(status: TodoStatus): TodoTone {
  if (status === "in_progress") return "warning"
  if (status === "completed") return "success"
  return "muted"
}

/**
 * A header is loud only while something is in flight, and takes the base colour
 * otherwise. It deliberately does not turn green when the list is finished: a
 * completed plan is not a celebration, and the items already carry that colour.
 */
export function summaryTone(state: TodoState): TodoTone {
  if (state.items.some((item) => item.status === "in_progress")) return "warning"
  return "base"
}
