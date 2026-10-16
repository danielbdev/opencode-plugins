/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup } from "solid-js"

import {
  TODO_TOOL_NAME,
  carriesWholeList,
  formatHeader,
  formatItem,
  formatSectionTitle,
  groupBySession,
  summaryTone,
  todoEventsFrom,
  toneOf,
  unseenMessages,
  type TodoTone,
} from "./core/todo.ts"

/** A safety net for reads that no event announced; the events do the real work. */
const TICK_MS = 10_000

/** How much history one read asks for. The data layer pages the same way. */
const PAGE_SIZE = 200

/** A stop for a cursor that never ends; no session is meant to be this long. */
const MAX_PAGES = 50

/**
 * Colours come from the theme's semantic feedback slots
 * (`FeedbackKind = error | warning | success | info`), so the section follows
 * whatever theme is active instead of naming a colour here.
 */
function toneColor(context: Plugin.Context, tone: TodoTone): string {
  const text = (context.theme as unknown as { text?: Record<string, unknown> } | undefined)?.text
  if (tone === "base") return (text?.["base"] ?? "white") as string
  if (tone === "muted") return (text?.["muted"] ?? "gray") as string

  const feedback = (text as { feedback?: Record<string, { base?: unknown } | undefined> } | undefined)
    ?.feedback
  return (feedback?.[tone]?.base ?? "white") as string
}

function titleColor(context: Plugin.Context): string {
  const text = (context.theme as unknown as { text?: Record<string, unknown> } | undefined)?.text
  return (text?.["base"] ?? "white") as string
}

/** What the section has taken in of one session's history. */
interface History {
  /** The messages carrying a call to this tool, oldest first. */
  readonly messages: unknown[]
  /** The ids of every message seen, so a window sliding back over them changes nothing. */
  readonly seen: Set<string>
  /** Set once what we have is trusted to hold the list. */
  seeded: boolean
}

/**
 * TUI half.
 *
 * It never writes: the list is read back out of the session history, which is the
 * same source the server half replays from. Reloading, switching session or
 * restarting reconstructs it with nothing persisted by the plugin.
 *
 * That history is handed out as a *window*, though — the data layer keeps the newest
 * messages and forgets the older ones — so the section keeps its own copy and reads
 * back through the session when the copy does not yet hold the call that built the
 * list. Without that, the list of a long session would vanish the moment those calls
 * fell out of the window.
 */
export default Plugin.define({
  id: "opencode-todo.tui",
  setup(context) {
    const histories = new Map<string, History>()

    /**
     * What the user has folded away, for as long as the plugin is loaded.
     *
     * A signal rather than a plain object, because the section redraws from it: reading
     * `folds()` inside the render is what makes a click show up instead of waiting for
     * the next event. The section toggle belongs to the HUD and outlives the session on
     * screen; a group's is keyed by the session whose items it hides.
     */
    const [folds, setFolds] = createSignal<{
      readonly section: boolean
      readonly groups: Readonly<Record<string, boolean>>
    }>({ section: false, groups: {} })

    const toggleSection = () => setFolds((previous) => ({ ...previous, section: !previous.section }))

    const toggleGroup = (id: string) =>
      setFolds((previous) => ({
        ...previous,
        groups: { ...previous.groups, [id]: !previous.groups[id] },
      }))

    // A runtime that did not expose the client would leave the section with the
    // window the data layer has, which is where it started: the read-back is skipped
    // rather than attempted and failed on every event.
    const canReadBack = typeof context.client?.message?.list === "function"

    const historyFor = (id: string): History => {
      let history = histories.get(id)
      if (history === undefined) {
        history = { messages: [], seen: new Set(), seeded: false }
        histories.set(id, history)
      }
      return history
    }

    /**
     * The messages in a stretch of history that carry a call and that we have not seen
     * yet. A copy of the *calls* is what is kept, not a copy of the session: the rest
     * would sit in memory only to replay as nothing.
     */
    const newCalls = (history: History, messages: readonly unknown[]): unknown[] =>
      unseenMessages(history.seen, messages).filter(
        (message) => todoEventsFrom([message], TODO_TOOL_NAME).length > 0,
      )

    /**
     * Read back through a session until a call that replaced the whole list turns up,
     * or the start is reached. The first page is the newest one, so what comes back is
     * a contiguous stretch of history ending at the newest message.
     *
     * The read stops as soon as a `write`, a `clear` or a snapshot is in hand: each of
     * them supersedes everything before it, so the calls older than that cannot change
     * the list.
     */
    const readBack = async (id: string): Promise<unknown[]> => {
      const collected: unknown[] = []
      let cursor: string | undefined

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await context.client.message.list({
          sessionID: id,
          limit: PAGE_SIZE,
          order: "desc",
          cursor,
        })
        collected.unshift(...response.data.toReversed())
        if (carriesWholeList(collected, TODO_TOOL_NAME)) break

        cursor = response.cursor.next ?? undefined
        if (cursor === undefined) break
      }

      return collected
    }

    const TodoSection = (props: { sessionID: string }) => {
      const [tick, setTick] = createSignal(0)

      // The message collection is a cached window: reading it without syncing returns
      // whatever was loaded at mount. The read below asks for the newest messages only
      // when there is nothing there at all, because a sync replaces the window and
      // would throw away everything read back past it — which is also what would make
      // the section lose the list of a long session on every event.
      let syncing = false
      const refresh = () => {
        if (syncing) return
        syncing = true

        const message = context.data.session.message
        const family = context.data.session.family(props.sessionID)

        void Promise.all(
          family.map(async (id) => {
            const history = historyFor(id)

            if (message.list(id).length === 0) await message.sync(id).catch(() => {})
            history.messages.push(...newCalls(history, message.list(id)))

            // A window holding the call that replaced the list is enough on its own, so
            // a session short enough to fit in one never pays for a read.
            if (history.seeded || carriesWholeList(history.messages, TODO_TOOL_NAME)) {
              history.seeded = true
              return
            }
            if (!canReadBack) return

            // The list was built before the window reaches: the older messages go in
            // front of what we have, which is where they belong in order.
            try {
              history.messages.unshift(...newCalls(history, await readBack(id)))
              history.seeded = true
            } catch {
              // Keep what we have and try again on the next event.
            }
          }),
        )
          .catch(() => {})
          .then(() => setTick((value) => value + 1))
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

      const lists = createMemo(() => {
        tick()

        const root = props.sessionID
        if (!root) return []

        const sessions = context.data.session.family(root).map((id) => {
          const info = context.data.session.get(id)
          return { id, agent: info?.agent, messages: histories.get(id)?.messages ?? [] }
        })

        return groupBySession(sessions, root, TODO_TOOL_NAME)
      })

      // Read through the signal, so a click redraws the section on its own.
      const folded = (id: string) => folds().groups[id] === true

      return (
        <box flexDirection="column">
          <box onMouseDown={toggleSection}>
            <text fg={titleColor(context)}>{formatSectionTitle(folds().section)}</text>
          </box>
          {folds().section ? null : lists().length === 0 ? (
            <text fg={toneColor(context, "muted")}>no tasks yet</text>
          ) : (
            lists().map((list) => (
              <box flexDirection="column">
                <box onMouseDown={() => toggleGroup(list.sessionID)}>
                  <text fg={toneColor(context, summaryTone(list.state))}>
                    {formatHeader(list, folded(list.sessionID))}
                  </text>
                </box>
                {folded(list.sessionID)
                  ? null
                  : list.state.items.map((item) => (
                      <text fg={toneColor(context, toneOf(item.status))}>{formatItem(item)}</text>
                    ))}
                <text> </text>
              </box>
            ))
          )}
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
