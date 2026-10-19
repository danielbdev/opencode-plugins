import { test } from "node:test"
import assert from "node:assert/strict"

import pkg from "../../package.json" with { type: "json" }

import {
  errorSnapshot,
  formatPercent,
  formatReset,
  formatStatus,
  formatWindow,
  formatWindowDetail,
  parseSnapshot,
  parseUsage,
  providerErrorMessage,
  USER_AGENT,
  type UsageWindow,
} from "./usage.ts"

const NOW = Date.parse("2026-10-14T20:35:38.000Z")

const LIVE_PAYLOAD = {
  usage: {
    rolling: { status: "ok", percent: 2, resetsAt: "2026-10-14T21:25:45.000Z" },
    weekly: { status: "ok", percent: 0, resetsAt: "2026-10-19T00:00:00.000Z" },
    monthly: { status: "ok", percent: 0, resetsAt: "2026-11-09T17:09:16.000Z" },
  },
}

test("parseUsage reads the three windows from the live payload shape", () => {
  const snapshot = parseUsage(LIVE_PAYLOAD, NOW)

  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.error, null)
  assert.deepEqual(
    snapshot.windows.map((w) => [w.key, w.percent]),
    [
      ["rolling", 2],
      ["weekly", 0],
      ["monthly", 0],
    ],
  )
  assert.equal(snapshot.windows[0]?.resetsAt, "2026-10-14T21:25:45.000Z")
})

test("parseUsage keeps each percent as received and never derives one window from another", () => {
  const snapshot = parseUsage(LIVE_PAYLOAD, NOW)

  // Observed live: rolling 2% while weekly and monthly were 0%. Not monotonic.
  assert.equal(snapshot.windows[0]?.percent, 2)
  assert.equal(snapshot.windows[1]?.percent, 0)
  assert.equal(snapshot.windows[2]?.percent, 0)
})

test("parseUsage degrades a missing window to an unknown window instead of throwing", () => {
  const snapshot = parseUsage({ usage: { rolling: LIVE_PAYLOAD.usage.rolling } }, NOW)

  assert.equal(snapshot.windows.length, 3)
  assert.equal(snapshot.windows[0]?.percent, 2)
  assert.equal(snapshot.windows[1]?.percent, null)
  assert.equal(snapshot.windows[1]?.resetsAt, null)
  assert.equal(snapshot.ok, true)
})

test("parseUsage degrades a malformed window to unknown", () => {
  const snapshot = parseUsage(
    {
      usage: {
        rolling: { status: "ok", percent: "2", resetsAt: 12345 },
        weekly: null,
        monthly: { status: "ok", percent: 50, resetsAt: "not-a-date" },
      },
    },
    NOW,
  )

  assert.equal(snapshot.windows[0]?.percent, null)
  assert.equal(snapshot.windows[0]?.resetsAt, null)
  assert.equal(snapshot.windows[1]?.percent, null)
  assert.equal(snapshot.windows[2]?.percent, 50)
  assert.equal(snapshot.windows[2]?.resetsAt, null)
})

test("parseUsage reports an error snapshot for a non-object payload", () => {
  for (const payload of [null, undefined, "boom", 42, []]) {
    const snapshot = parseUsage(payload, NOW)
    assert.equal(snapshot.ok, false)
    assert.ok(snapshot.error)
    assert.equal(snapshot.windows.length, 3)
    assert.equal(snapshot.windows[0]?.percent, null)
  }
})

test("parseUsage carries the provider status through untouched", () => {
  const snapshot = parseUsage(
    { usage: { rolling: { status: "overage", percent: 100, resetsAt: "2026-10-14T21:25:45.000Z" } } },
    NOW,
  )

  assert.equal(snapshot.windows[0]?.status, "overage")
})

test("formatPercent renders an integer percent or an em dash", () => {
  assert.equal(formatPercent(2), "2%")
  assert.equal(formatPercent(0), "0%")
  assert.equal(formatPercent(100), "100%")
  assert.equal(formatPercent(null), "—")
})

test("formatReset renders days, hours and minutes until the reset", () => {
  const now = Date.parse("2026-10-14T20:35:38.000Z")

  assert.equal(formatReset("2026-10-14T21:25:45.000Z", now), "resets in 50m")
  assert.equal(formatReset("2026-10-19T00:00:00.000Z", now), "resets in 4d 3h")
  assert.equal(formatReset("2026-11-09T17:09:16.000Z", now), "resets in 25d 20h")
})

test("formatReset handles the last minutes, the expired case and unknown input", () => {
  const now = Date.parse("2026-10-14T20:35:38.000Z")

  assert.equal(formatReset("2026-10-14T20:40:38.000Z", now), "resets in 5m")
  assert.equal(formatReset("2026-10-14T20:35:00.000Z", now), "resetting")
  assert.equal(formatReset(null, now), "unknown")
  assert.equal(formatReset("not-a-date", now), "unknown")
})

test("formatWindow and formatWindowDetail compose the rendered line", () => {
  const snapshot = parseUsage(LIVE_PAYLOAD, NOW)

  assert.equal(formatWindow(snapshot.windows[0]!, NOW), "5h 2% · resets in 50m")
  assert.equal(formatWindow(snapshot.windows[1]!, NOW), "wk 0% · resets in 4d 3h")
  assert.equal(formatWindowDetail(snapshot.windows[0]!, NOW), "5h window    2%   resets in 50m")
})

test("formatStatus stays silent in the steady state and surfaces anything else", () => {
  // `ok` is the steady state, so it adds nothing to the line.
  assert.equal(formatStatus("ok"), "")
  assert.equal(formatStatus(null), "")
  assert.equal(formatStatus(""), " ()")

  // Any other status is unknown territory on an undocumented endpoint: show it
  // verbatim rather than guessing a friendlier wording.
  assert.equal(formatStatus("overage"), " (overage)")
  assert.equal(formatStatus("exceeded"), " (exceeded)")
})

test("formatWindow and formatWindowDetail surface a non-ok provider status", () => {
  const window: UsageWindow = {
    key: "rolling",
    short: "5h",
    long: "5h window",
    percent: 100,
    resetsAt: "2026-10-14T21:25:45.000Z",
    status: "overage",
  }

  assert.equal(formatWindow(window, NOW), "5h 100% · resets in 50m (overage)")
  assert.equal(formatWindowDetail(window, NOW), "5h window  100%   resets in 50m (overage)")
})

test("an error snapshot renders as an unknown window, not fabricated percentages", () => {
  const snapshot = errorSnapshot("Go integration is not connected", NOW)

  assert.equal(snapshot.ok, false)
  assert.equal(formatWindow(snapshot.windows[0]!, NOW), "5h — · unknown")
})

test("parseSnapshot accepts a snapshot that crossed the RPC boundary", () => {
  const sent = parseUsage(LIVE_PAYLOAD, NOW)
  const received = parseSnapshot(JSON.parse(JSON.stringify(sent)))

  assert.notEqual(received, null)
  assert.equal(received!.ok, true)
  assert.equal(received!.fetchedAt, NOW)
  assert.deepEqual(
    received!.windows.map((w) => w.percent),
    [2, 0, 0],
  )
  assert.equal(received!.windows[0]!.short, "5h")
  assert.equal(received!.windows[0]!.long, "5h window")
})

test("parseSnapshot rejects anything that is not a snapshot object", () => {
  for (const value of [null, undefined, "boom", 42, [], {}, { windows: "nope" }]) {
    assert.equal(parseSnapshot(value), null)
  }
})

test("parseSnapshot degrades a malformed window entry instead of throwing", () => {
  const received = parseSnapshot({
    fetchedAt: "nope",
    ok: "yes",
    error: 7,
    windows: [{ key: "rolling", short: "5h", long: "5h window", percent: 9 }, null, "x"],
  })

  assert.notEqual(received, null)
  assert.equal(received!.ok, false)
  assert.equal(received!.error, null)
  assert.equal(received!.fetchedAt, 0)
  assert.equal(received!.windows.length, 3)
  assert.equal(received!.windows[0]!.percent, 9)
  assert.equal(received!.windows[1]!.percent, null)
  assert.equal(received!.windows[2]!.key, "monthly")
})

test("providerErrorMessage turns a live api_key_expired body into an actionable line", () => {
  // Recorded live on 2026-10-19: the provider explains itself and says signing
  // in again will not renew the key.
  const body = JSON.stringify({
    error: {
      type: "unauthorized",
      code: "api_key_expired",
      message:
        "This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store. Signing in again will not renew this key.",
    },
  })

  assert.equal(providerErrorMessage(401, body), "API key expired — create a new one in OpenCode Console")
})

test("providerErrorMessage keeps the HTTP status for an unknown code", () => {
  assert.equal(
    providerErrorMessage(403, JSON.stringify({ error: { code: "forbidden" } })),
    "Usage request failed with HTTP 403 (forbidden)",
  )
})

test("providerErrorMessage falls back to the status when the body is not usable", () => {
  assert.equal(providerErrorMessage(400, "not json"), "Usage request failed with HTTP 400")
  assert.equal(providerErrorMessage(500, ""), "Usage request failed with HTTP 500")
  assert.equal(providerErrorMessage(502, JSON.stringify({ error: "boom" })), "Usage request failed with HTTP 502")
  assert.equal(providerErrorMessage(503, JSON.stringify({ error: {} })), "Usage request failed with HTTP 503")
})

test("USER_AGENT tracks the published package version", () => {
  // Guards the drift a hardcoded literal invites: bump the manifest without
  // touching the constant and this fails before the package is published.
  assert.equal(USER_AGENT, `opencode-go-usage/${pkg.version}`)
})
