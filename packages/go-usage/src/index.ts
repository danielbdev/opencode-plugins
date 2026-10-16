import { Plugin } from "@opencode/plugin"

import { errorSnapshot, parseUsage, USER_AGENT, type UsageSnapshot } from "./core/usage.ts"
import { UsageRpc } from "./rpc.ts"

const INTEGRATION_ID = "opencode-go"
const USAGE_URL = "https://opencode.ai/inference/go/v1/usage"

/** Usage moves slowly; the endpoint is undocumented, so we stay conservative. */
const REFRESH_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Server plugin.
 *
 * It owns the whole credential path: the TUI cannot read a credential (the
 * client exposes only update/activate/remove), so the fetch happens here and
 * only the resulting snapshot crosses the RPC boundary.
 */
export default Plugin.define({
  id: "opencode-go-usage.server",
  async setup(ctx) {
    let snapshot: UsageSnapshot = errorSnapshot("Usage not loaded yet", Date.now())
    let inFlight: Promise<UsageSnapshot> | null = null

    async function readApiKey(): Promise<string | null> {
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      if (!connection) return null

      const credential = await ctx.integration.connection.resolve(connection)
      if (!credential || credential.type !== "key") return null

      // Never log, print, persist or forward this value.
      return credential.key
    }

    async function fetchSnapshot(): Promise<UsageSnapshot> {
      const now = Date.now()

      try {
        const apiKey = await readApiKey()
        if (apiKey === null) {
          return errorSnapshot(`The ${INTEGRATION_ID} integration is not connected`, now)
        }

        const response = await fetch(USAGE_URL, {
          headers: {
            authorization: `Bearer ${apiKey}`,
            "user-agent": USER_AGENT,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })

        if (!response.ok) {
          return errorSnapshot(`Usage request failed with HTTP ${response.status}`, now)
        }

        return parseUsage(await response.json(), now)
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : "unknown error"
        return errorSnapshot(`Usage request failed: ${detail}`, now)
      }
    }

    /** Coalesces concurrent refreshes into one request. */
    async function refresh(): Promise<UsageSnapshot> {
      if (inFlight) return inFlight

      inFlight = fetchSnapshot()
      try {
        snapshot = await inFlight
      } finally {
        inFlight = null
      }

      // Publishing must not fail the refresh: the snapshot is already read, and
      // `refresh()` is awaited by setup and fired-and-forgotten by the interval,
      // where a rejection would surface as an unhandled rejection.
      try {
        await registration.events.emit("updated", {
          fetchedAt: snapshot.fetchedAt,
          ok: snapshot.ok,
          error: snapshot.error,
          windows: snapshot.windows.map((window) => ({ ...window })),
        })
      } catch {
        // Subscribers are optional; the caller still gets the fresh snapshot.
      }

      return snapshot
    }

    const registration = await ctx.rpc.register(UsageRpc, {
      get: async (input) => {
        const wantsRefresh = (input as { refresh?: boolean } | undefined)?.refresh === true
        return wantsRefresh ? await refresh() : snapshot
      },
    })

    await refresh()

    const timer = setInterval(() => {
      void refresh()
    }, REFRESH_MS)

    return () => {
      clearInterval(timer)
    }
  },
})
