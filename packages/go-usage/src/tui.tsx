/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup } from "solid-js"

import {
  errorSnapshot,
  formatWindow,
  formatWindowDetail,
  parseSnapshot,
  type UsageSnapshot,
} from "./core/usage.ts"
import { UsageRpc } from "./rpc.ts"

/** The reset countdown is the only thing that changes between refreshes. */
const COUNTDOWN_TICK_MS = 30_000

/**
 * The host publishes a coarse sidebar tree: `sidebar.content` (the sidebar's
 * content region, which holds the context and MCP blocks) and `sidebar.footer`.
 * The finer strings in the 2.0.28 bundle (`sidebar.context`, `sidebar.mcp`) are
 * internal identifiers, not slot paths — anchoring to one of those made the
 * section disappear.
 *
 * There is no sub-slot between the context and MCP blocks, so the only two
 * positions inside the content region are its start and its end. Usage owns the
 * top: `prepend` puts it above the context block. The planned agent and to-do
 * sections take the bottom (`append`, below MCP), so they do not compete with
 * this one for the same edge.
 */
const SIDEBAR_SLOT = "sidebar.content"

interface HudState {
  snapshot: UsageSnapshot
  /** Set when the last interaction failed, e.g. the server plugin is absent. */
  fault: string | null
}

function initialSnapshot(): UsageSnapshot {
  return errorSnapshot("Usage not loaded yet", Date.now())
}

function themeColor(context: Plugin.Context, key: "base" | "muted" | "accent"): string {
  const text = (context.theme as unknown as { text?: Record<string, string | undefined> } | undefined)
    ?.text
  return text?.[key] ?? (key === "muted" ? "gray" : "white")
}

function detailMessage(snapshot: UsageSnapshot, now: number, fault: string | null): string {
  if (fault !== null) return fault
  if (!snapshot.ok && snapshot.error !== null) return snapshot.error

  const rows = snapshot.windows.map((window) => formatWindowDetail(window, now))
  const fetched = new Date(snapshot.fetchedAt).toISOString().slice(11, 19)
  return `${rows.join("\n")}\n\nupdated ${fetched} UTC · each window resets on its own schedule`
}

/**
 * TUI plugin.
 *
 * It never touches the credential: the server plugin resolves it, reads the
 * endpoint and pushes the resulting snapshot over RPC.
 */
export default Plugin.define({
  id: "opencode-go-usage.tui",
  async setup(context) {
    // The RPC lives in the server half. If that half is not loaded the subclient
    // cannot be built, and the HUD must degrade instead of failing setup.
    let usage: ReturnType<typeof context.client.rpc<typeof UsageRpc>> | undefined
    try {
      usage = context.client.rpc(UsageRpc)
    } catch {
      usage = undefined
    }

    const [state, setState] = context.storage.memory<HudState>("usage", {
      initial: { snapshot: initialSnapshot(), fault: null },
    })

    const apply = (value: unknown) => {
      const parsed = parseSnapshot(value)
      if (parsed === null) return
      setState((draft) => {
        draft.snapshot = parsed
        draft.fault = null
      })
    }

    const pull = async (refresh: boolean) => {
      if (usage === undefined) {
        setState((draft) => {
          draft.fault = "Usage unavailable: the usage plugin is not loaded"
        })
        return
      }
      try {
        apply(await usage.get({ refresh }))
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : "unknown error"
        setState((draft) => {
          draft.fault = `Usage unavailable: ${detail}`
        })
      }
    }

    void pull(false)

    const stopEvents = (() => {
      try {
        return usage?.events.on("updated", (event) => {
          apply((event as { data?: unknown }).data)
        })
      } catch {
        return undefined
      }
    })()

    const UsageSection = () => {
      const [now, setNow] = createSignal(Date.now())
      const timer = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS)
      onCleanup(() => clearInterval(timer))

      const body = createMemo(() => {
        if (state.fault !== null) return state.fault
        if (!state.snapshot.ok && state.snapshot.error !== null) return state.snapshot.error
        return null
      })

      return (
        <box flexDirection="column">
          <text fg={themeColor(context, "base")}>Go usage</text>
          {body() !== null ? (
            <text fg={themeColor(context, "muted")}>{body()}</text>
          ) : (
            state.snapshot.windows.map((window) => (
              <text fg={themeColor(context, "muted")}>{formatWindow(window, now())}</text>
            ))
          )}
        </box>
      )
    }

    const stopSlot = context.ui.slot({
      prepend: SIDEBAR_SLOT,
      render: () => <UsageSection />,
    })

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "opencode-go-usage.usage",
          title: "OpenCode Go usage",
          description: "Show the 5h, weekly and monthly Go usage windows",
          group: "Go usage",
          palette: true,
          slash: { name: "usage", aliases: ["go-usage"] },
          run: async () => {
            await pull(true)
            await context.ui.dialog.alert({
              title: "OpenCode Go usage",
              message: detailMessage(state.snapshot, Date.now(), state.fault),
            })
          },
        },
      ],
    }))

    return () => {
      stopEvents?.()
      stopSlot()
    }
  },
})
