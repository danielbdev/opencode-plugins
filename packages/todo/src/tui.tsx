/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup } from "solid-js"

import {
  EMPTY_TODO,
  TODO_TOOL_NAME,
  feedbackOf,
  formatItem,
  formatSummary,
  replayTodo,
  summaryFeedback,
  toolResultsFrom,
  visibleItems,
  type FeedbackKind,
} from "./core/todo.ts"

/** A safety net for reads that no event announced; the events do the real work. */
const TICK_MS = 10_000

/**
 * Colours come from the theme's semantic feedback slots
 * (`FeedbackKind = error | warning | success | info`), so the section follows
 * whatever theme is active instead of naming a colour here.
 */
function feedbackColor(context: Plugin.Context, kind: FeedbackKind): string {
  const feedback = (
    context.theme as unknown as
      | { text?: { feedback?: Record<string, { base?: unknown } | undefined> } }
      | undefined
  )?.text?.feedback

  return (feedback?.[kind]?.base ?? "white") as string
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

      const timer = setInterval(() => setTick((value) => value + 1), TICK_MS)
      onCleanup(() => clearInterval(timer))

      // The message collection may not be loaded yet on first render; asking
      // once is cheap and the events keep it current afterwards.
      void context.data.session.message.sync(props.sessionID).catch(() => {})

      const stopEvents = context.data.listen(({ details }) => {
        if (details.type.startsWith("session.")) setTick((value) => value + 1)
      })
      onCleanup(() => stopEvents())

      const state = createMemo(() => {
        tick()

        const root = props.sessionID
        if (!root) return EMPTY_TODO

        const messages = context.data.session.message.list(root)
        return replayTodo(toolResultsFrom(messages, TODO_TOOL_NAME), TODO_TOOL_NAME) ?? EMPTY_TODO
      })

      return (
        <box flexDirection="column">
          <text fg={titleColor(context)}>To-do</text>
          <text fg={feedbackColor(context, summaryFeedback(state()))}>{formatSummary(state())}</text>
          {visibleItems(state()).map((item) => (
            <text fg={feedbackColor(context, feedbackOf(item.status))}>{formatItem(item)}</text>
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
