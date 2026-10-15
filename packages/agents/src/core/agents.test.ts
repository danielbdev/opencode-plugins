import { test } from "node:test"
import assert from "node:assert/strict"

import {
  feedbackOf,
  formatAgentLine,
  formatCounts,
  formatElapsed,
  stateOf,
  summarize,
  summaryFeedback,
  type SessionLike,
} from "./agents.ts"

const NOW = 1_800_000_000_000

function subagent(overrides: Partial<SessionLike> & { id: string }): SessionLike {
  return { parentID: "ses_root", agent: "explore", time: { created: NOW - 42_000 }, ...overrides }
}

test("stateOf reads the queryable outcome before anything else", () => {
  assert.equal(stateOf({ id: "a", outcome: "succeeded" }, false), "succeeded")
  assert.equal(stateOf({ id: "a", outcome: "failed" }, false), "failed")
  assert.equal(stateOf({ id: "a", outcome: "interrupted" }, false), "interrupted")
  assert.equal(stateOf({ id: "a", outcome: "succeeded" }, true), "succeeded")
})

test("stateOf falls back to liveness when there is no outcome yet", () => {
  assert.equal(stateOf({ id: "a" }, true), "running")
  assert.equal(stateOf({ id: "a" }, false), "idle")
})

test("summarize counts only subagents and ignores the root session", () => {
  const summary = summarize(
    [
      { id: "ses_root", agent: "gentle-orchestrator" },
      subagent({ id: "s1", outcome: "succeeded" }),
      subagent({ id: "s2", outcome: "failed" }),
    ],
    new Set(),
    NOW,
  )

  assert.equal(summary.total, 2)
  assert.equal(summary.succeeded, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.running, 0)
  assert.equal(summary.done, 1)
})

test("summarize separates done from failed and counts running separately", () => {
  const summary = summarize(
    [
      subagent({ id: "s1", outcome: "succeeded" }),
      subagent({ id: "s2", outcome: "succeeded" }),
      subagent({ id: "s3", outcome: "interrupted" }),
      subagent({ id: "s4" }),
      subagent({ id: "s5" }),
    ],
    new Set(["s4", "s5"]),
    NOW,
  )

  assert.equal(summary.total, 5)
  assert.equal(summary.succeeded, 2)
  assert.equal(summary.failed, 1)
  assert.equal(summary.running, 2)
  assert.equal(summary.done, 2)
})

test("summarize lists running first, then failed, and never lists succeeded ones", () => {
  const summary = summarize(
    [
      subagent({ id: "ok", outcome: "succeeded" }),
      subagent({ id: "boom", outcome: "failed", agent: "verify" }),
      subagent({ id: "busy", agent: "general" }),
    ],
    new Set(["busy"]),
    NOW,
  )

  assert.deepEqual(
    summary.entries.map((entry) => [entry.id, entry.state]),
    [
      ["busy", "running"],
      ["boom", "failed"],
    ],
  )
  assert.equal(summary.entries[0]?.name, "general")
})

test("summarize measures a running subagent against now and a finished one against its end", () => {
  const summary = summarize(
    [
      subagent({ id: "busy", time: { created: NOW - 90_000 } }),
      subagent({ id: "done", outcome: "succeeded", time: { created: NOW - 500_000, idle: NOW - 440_000 } }),
      subagent({ id: "no-idle", outcome: "failed", time: { created: NOW - 30_000, updated: NOW - 10_000 } }),
    ],
    new Set(["busy"]),
    NOW,
  )

  const byId = new Map(summary.entries.map((entry) => [entry.id, entry]))
  assert.equal(byId.get("busy")?.elapsedMs, 90_000)
  assert.equal(byId.get("no-idle")?.elapsedMs, 20_000)
})

test("summarize names an unnamed subagent and survives a missing time block", () => {
  const summary = summarize([subagent({ id: "s1", agent: undefined, time: undefined })], new Set(), NOW)

  assert.equal(summary.entries.length, 0)
  assert.equal(summary.total, 1)

  const named = summarize(
    [subagent({ id: "s2", agent: undefined, outcome: "failed" })],
    new Set(),
    NOW,
  )
  assert.equal(named.entries[0]?.name, "subagent")
})

test("formatElapsed renders seconds, minutes and hours", () => {
  assert.equal(formatElapsed(0), "0s")
  assert.equal(formatElapsed(42_000), "42s")
  assert.equal(formatElapsed(59_999), "59s")
  assert.equal(formatElapsed(60_000), "1m")
  assert.equal(formatElapsed(192_000), "3m")
  assert.equal(formatElapsed(3_900_000), "1h 5m")
})

test("formatCounts omits a zero failed bucket and has an explicit empty state", () => {
  const busy = summarize(
    [subagent({ id: "a" }), subagent({ id: "b", outcome: "succeeded" })],
    new Set(["a"]),
    NOW,
  )
  assert.equal(formatCounts(busy), "1 running · 1 done")

  const broken = summarize(
    [subagent({ id: "a", outcome: "failed" }), subagent({ id: "b", outcome: "succeeded" })],
    new Set(),
    NOW,
  )
  assert.equal(formatCounts(broken), "0 running · 1 done · 1 failed")

  const empty = summarize([{ id: "ses_root" }], new Set(), NOW)
  assert.equal(formatCounts(empty), "no subagents yet")
})

test("formatAgentLine pairs the name with the elapsed time", () => {
  assert.equal(
    formatAgentLine({ id: "a", name: "explore", state: "running", elapsedMs: 42_000 }),
    "explore · 42s",
  )
  assert.equal(
    formatAgentLine({ id: "b", name: "verify", state: "failed", elapsedMs: 192_000 }),
    "verify · failed · 3m",
  )
})

test("feedbackOf maps every state onto a theme feedback kind", () => {
  assert.equal(feedbackOf("running"), "warning")
  assert.equal(feedbackOf("succeeded"), "success")
  assert.equal(feedbackOf("failed"), "error")
  assert.equal(feedbackOf("interrupted"), "error")
  assert.equal(feedbackOf("idle"), "info")
})

test("summaryFeedback reports the worst state present", () => {
  const allGood = summarize([subagent({ id: "a", outcome: "succeeded" })], new Set(), NOW)
  assert.equal(summaryFeedback(allGood), "success")

  const busy = summarize([subagent({ id: "a" }), subagent({ id: "b", outcome: "succeeded" })], new Set(["a"]), NOW)
  assert.equal(summaryFeedback(busy), "warning")

  const broken = summarize([subagent({ id: "a" }), subagent({ id: "b", outcome: "failed" })], new Set(["a"]), NOW)
  assert.equal(summaryFeedback(broken), "error")

  const empty = summarize([], new Set(), NOW)
  assert.equal(summaryFeedback(empty), "info")
})
