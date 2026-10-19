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

    // `storage.memory` survives hot reloads, but the value it returns is not a
    // reactive store: mutating it updates the dialog (which reads it on demand)
    // while the sidebar keeps rendering the snapshot it saw first. The signals
    // are what the section tracks; the memory store is the cross-generation
    // cache, seeded once at setup and written through on every change.
    const [stored, persist] = context.storage.memory<HudState>("usage", {
      initial: { snapshot: initialSnapshot(), fault: null },
    })

    const [snapshot, setSnapshot] = createSignal<UsageSnapshot>(stored.snapshot)
    const [fault, setFault] = createSignal<string | null>(stored.fault)

    const commit = (next: UsageSnapshot, nextFault: string | null) => {
      setSnapshot(next)
      setFault(nextFault)
      persist((draft) => {
        draft.snapshot = next
        draft.fault = nextFault
      })
    }

    const apply = (value: unknown) => {
      const parsed = parseSnapshot(value)
      if (parsed === null) return
      commit(parsed, null)
    }

    const pull = async (refresh: boolean) => {
      if (usage === undefined) {
        commit(snapshot(), "Usage unavailable: the usage plugin is not loaded")
        return
      }
      try {
        apply(await usage.get({ refresh }))
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : "unknown error"
        commit(snapshot(), `Usage unavailable: ${detail}`)
      }
    }

    // Start with a forced refresh, not a read of whatever the server has.
    //
    // The server fetches on its own setup and publishes `updated`; if the TUI
    // attaches after that event, a plain `get` can return the "not loaded yet"
    // placeholder and the section sits on it until the five-minute timer. Asking
    // for a refresh coalesces with any fetch already in flight and always
    // resolves to a real snapshot (or a real error).
    void pull(true)

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
        const failure = fault()
        if (failure !== null) return failure
        const current = snapshot()
        if (!current.ok && current.error !== null) return current.error
        return null
      })

      return (
        <box flexDirection="column">
          <text fg={themeColor(context, "base")}>Go usage</text>
          {body() !== null ? (
            <text fg={themeColor(context, "muted")}>{body()}</text>
          ) : (
            snapshot().windows.map((window) => (
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
              message: detailMessage(snapshot(), Date.now(), fault()),
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
