/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup } from "solid-js"

import {
  feedbackOf,
  formatAgentLine,
  formatCounts,
  summarize,
  summaryFeedback,
  type FeedbackKind,
  type SessionLike,
} from "./core/agents.ts"

/** Elapsed times move on their own; a running subagent needs no event to age. */
const ELAPSED_TICK_MS = 10_000

const EMPTY = summarize([], new Set(), Date.now())

/**
 * Colours come from the theme's semantic feedback slots
 * (`FeedbackKind = error | warning | success | info`), so the semaphore follows
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

/** The muted slot, for a line that reports absence instead of state. */
function mutedColor(context: Plugin.Context): string {
  const text = (context.theme as unknown as { text?: Record<string, unknown> } | undefined)?.text
  return (text?.["muted"] ?? "gray") as string
}

/**
 * TUI-only plugin.
 *
 * Subagent data is already in the TUI's data layer, so there is no server half,
 * no credential and no RPC: the section reads the session family of the session
 * it renders in.
 */
export default Plugin.define({
  id: "opencode-agents.tui",
  setup(context) {
    const AgentsSection = (props: { sessionID: string }) => {
      const [tick, setTick] = createSignal(0)

      const timer = setInterval(() => setTick((value) => value + 1), ELAPSED_TICK_MS)
      onCleanup(() => clearInterval(timer))

      const stopEvents = context.data.listen(({ details }) => {
        if (details.type.startsWith("session.")) setTick((value) => value + 1)
      })
      onCleanup(() => stopEvents())

      const summary = createMemo(() => {
        tick()

        const root = props.sessionID
        if (!root) return EMPTY

        const ids = context.data.session.family(root)
        const sessions = ids
          .map((id) => context.data.session.get(id))
          .filter((session): session is NonNullable<typeof session> => session !== undefined)

        const running = new Set(ids.filter((id) => context.data.session.status(id) === "running"))

        return summarize(sessions as readonly SessionLike[], running, Date.now())
      })

      return (
        <box flexDirection="column">
          <text fg={titleColor(context)}>Agents</text>
          <text fg={summary().total === 0 ? mutedColor(context) : feedbackColor(context, summaryFeedback(summary()))}>{formatCounts(summary())}</text>
          {summary().entries.map((entry) => (
            <text fg={feedbackColor(context, feedbackOf(entry.state))}>{formatAgentLine(entry)}</text>
          ))}
        </box>
      )
    }

    const stopSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <AgentsSection sessionID={input.sessionID} />,
    })

    return () => stopSlot()
  },
})
