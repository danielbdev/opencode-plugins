import { test } from "node:test"
import assert from "node:assert/strict"

import { createResyncGate } from "./resync.ts"

const MINUTE = 60_000

test("the gate opens on the first call and then holds for the whole window", () => {
  let clock = 1_000_000
  const allow = createResyncGate(MINUTE, () => clock)

  assert.equal(allow(), true)

  clock += MINUTE - 1
  assert.equal(allow(), false)
})

test("the gate reopens once the window has elapsed", () => {
  let clock = 1_000_000
  const allow = createResyncGate(MINUTE, () => clock)

  assert.equal(allow(), true)

  clock += MINUTE
  assert.equal(allow(), true)

  // ...and closes again immediately after opening
  assert.equal(allow(), false)
})

test("a burst of settled turns opens the gate exactly once", () => {
  let clock = 1_000_000
  const allow = createResyncGate(MINUTE, () => clock)

  const openedAt: number[] = []
  for (let turn = 0; turn < 10; turn++) {
    if (allow()) openedAt.push(turn)
    clock += 100 // turns settling back to back
  }

  assert.deepEqual(openedAt, [0])
})
