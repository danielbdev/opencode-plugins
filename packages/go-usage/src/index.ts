import { Plugin } from "@opencode/plugin"

import { createResyncGate } from "./core/resync.ts"
import { errorSnapshot, parseUsage, providerErrorMessage, USER_AGENT, type UsageSnapshot } from "./core/usage.ts"
import { UsageRpc } from "./rpc.ts"

const INTEGRATION_ID = "opencode-go"
const USAGE_URL = "https://opencode.ai/inference/go/v1/usage"

/** Usage moves slowly; the endpoint is undocumented, so we stay conservative. */
const REFRESH_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 10_000

/** A settled turn moves usage; re-read on that signal, at most once per minute. */
const RESYNC_MIN_MS = 60_000

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
          // The provider explains its own failures ("api_key_expired" and the
          // like); reading that body is what turns an opaque 401 into a line
          // the user can act on.
          const detail = await response.text().then(
            (body) => providerErrorMessage(response.status, body.slice(0, 4096)),
            () => providerErrorMessage(response.status, ""),
          )
          return errorSnapshot(detail, now)
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

    // A settled turn is when usage actually moves, and the cache lives in this
    // half, so the trigger belongs here: the refreshed snapshot goes out over
    // `updated` and the TUI keeps working unchanged. The gate keeps quick
    // successive turns from hammering an undocumented endpoint.
    const controller = new AbortController()
    const allowed = createResyncGate(RESYNC_MIN_MS)

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "session.execution.succeeded") continue
        if (!allowed()) continue
        void refresh()
      }
    })().catch(() => {
      // A closed subscription is not a reason to fail the plugin.
    })

    return () => {
      controller.abort()
      clearInterval(timer)
    }
  },
})
