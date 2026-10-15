import { test } from "node:test"
import assert from "node:assert/strict"

import {
  errorSnapshot,
  formatPercent,
  formatReset,
  formatSummary,
  formatWindow,
  parseSnapshot,
  parseUsage,
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

test("formatWindow and formatSummary compose the rendered line", () => {
  const snapshot = parseUsage(LIVE_PAYLOAD, NOW)

  assert.equal(formatWindow(snapshot.windows[0]!, NOW), "5h 2% · resets in 50m")
  assert.equal(formatWindow(snapshot.windows[1]!, NOW), "wk 0% · resets in 4d 3h")
  assert.equal(formatSummary(snapshot, NOW), "GO 5h 2% · wk 0% · mo 0%")
})

test("formatSummary surfaces the failure state instead of percentages", () => {
  const snapshot = errorSnapshot("Go integration is not connected", NOW)

  assert.equal(snapshot.ok, false)
  assert.equal(formatSummary(snapshot, NOW), "GO usage unavailable")
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
  assert.equal(formatSummary(received!, NOW), "GO 5h 2% · wk 0% · mo 0%")
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

