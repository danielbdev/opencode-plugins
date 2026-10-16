/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup } from "solid-js"

import {
  EMPTY_TODO,
  TODO_TOOL_NAME,
  formatItem,
  formatSummary,
  replayTodo,
  summaryTone,
  todoEventsFrom,
  toneOf,
  type TodoTone,
} from "./core/todo.ts"

/** A safety net for reads that no event announced; the events do the real work. */
const TICK_MS = 10_000

/**
 * Colours come from the theme's semantic feedback slots
 * (`FeedbackKind = error | warning | success | info`), so the section follows
 * whatever theme is active instead of naming a colour here.
 */
function toneColor(context: Plugin.Context, tone: TodoTone): string {
  const text = (context.theme as unknown as { text?: Record<string, unknown> } | undefined)?.text
  if (tone === "muted") return (text?.["muted"] ?? "gray") as string

  const feedback = (text as { feedback?: Record<string, { base?: unknown } | undefined> } | undefined)
    ?.feedback
  return (feedback?.[tone]?.base ?? "white") as string
}

function titleColor(context: Plugin.Context): string {
  const text = (context.theme as unknown as { text?: Record<string, unknown> } | undefined)?.text
  return (text?.["base"] ?? "white") as string
}

/**
 * TUI half.
 *
 * It never writes: the list is read back out of the session history, which is the
 * same source the server half replays from. Reloading, switching session or
 * restarting reconstructs it with nothing persisted by the plugin.
 */
export default Plugin.define({
  id: "opencode-todo.tui",
  setup(context) {
    const TodoSection = (props: { sessionID: string }) => {
      const [tick, setTick] = createSignal(0)

      // The message collection is a cached snapshot: reading it without syncing
      // returns whatever was loaded at mount, which is why the section needs to
      // ask again and re-read only after the refresh lands.
      let syncing = false
      const refresh = () => {
        if (syncing) return
        syncing = true
        void context.data.session.message
          .sync(props.sessionID)
          .then(() => setTick((value) => value + 1))
          .catch(() => {})
          .finally(() => {
            syncing = false
          })
      }

      refresh()

      const stopEvents = context.data.listen(({ details }) => {
        if (details.type.startsWith("session.")) refresh()
      })
      onCleanup(() => stopEvents())

      // A slow safety net for anything no event announced.
      const timer = setInterval(refresh, TICK_MS)
      onCleanup(() => clearInterval(timer))

      const state = createMemo(() => {
        tick()

        const root = props.sessionID
        if (!root) return EMPTY_TODO

        const messages = context.data.session.message.list(root)
        return replayTodo(todoEventsFrom(messages, TODO_TOOL_NAME))
      })

      return (
        <box flexDirection="column">
          <text fg={titleColor(context)}>To-do</text>
          <text fg={toneColor(context, summaryTone(state()))}>{formatSummary(state())}</text>
          {state().items.map((item) => (
            <text fg={toneColor(context, toneOf(item.status))}>{formatItem(item)}</text>
          ))}
        </box>
      )
    }

    const stopSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <TodoSection sessionID={input.sessionID} />,
    })

    return () => stopSlot()
  },
})
