import { test } from "node:test"
import assert from "node:assert/strict"

import {
  EMPTY_TODO,
  TODO_METADATA_KEY,
  TODO_TOOL_DESCRIPTION,
  applyTodo,
  feedbackOf,
  formatItem,
  formatSummary,
  isForeignTaskTool,
  readSnapshot,
  replayTodo,
  summaryFeedback,
  toolResultsFrom,
  visibleItems,
  type TodoState,
  type ToolResultLike,
} from "./todo.ts"

function snapshotOf(state: TodoState): ToolResultLike {
  return { name: "todo", status: "completed", metadata: { [TODO_METADATA_KEY]: state } }
}

test("write replaces the list and assigns stable ids", () => {
  const state = applyTodo(EMPTY_TODO, { action: "write", items: ["map the flow", "write the test"] })

  assert.deepEqual(
    state.items.map((item) => [item.id, item.text, item.status]),
    [
      ["1", "map the flow", "pending"],
      ["2", "write the test", "pending"],
    ],
  )
  assert.equal(state.nextId, 3)
})

test("write replaces instead of appending", () => {
  const first = applyTodo(EMPTY_TODO, { action: "write", items: ["a", "b"] })
  const second = applyTodo(first, { action: "write", items: ["c"] })

  assert.deepEqual(second.items.map((item) => item.text), ["c"])
  assert.equal(second.items[0]?.id, "1")
})

test("update changes one item by id and leaves the rest alone", () => {
  const state = applyTodo(EMPTY_TODO, { action: "write", items: ["a", "b", "c"] })
  const updated = applyTodo(state, { action: "update", id: "2", status: "in_progress" })

  assert.deepEqual(updated.items.map((item) => item.status), ["pending", "in_progress", "pending"])
  assert.deepEqual(updated.items.map((item) => item.id), ["1", "2", "3"])
})

test("update on an unknown id leaves the state untouched", () => {
  const state = applyTodo(EMPTY_TODO, { action: "write", items: ["a"] })

  assert.deepEqual(applyTodo(state, { action: "update", id: "9", status: "completed" }), state)
  assert.deepEqual(applyTodo(state, { action: "update", status: "completed" }), state)
})

test("clear empties the list and resets the counter", () => {
  const state = applyTodo(EMPTY_TODO, { action: "write", items: ["a", "b"] })

  assert.deepEqual(applyTodo(state, { action: "clear" }), EMPTY_TODO)
})

test("readSnapshot accepts a well-formed snapshot and rejects anything else", () => {
  const state = applyTodo(EMPTY_TODO, { action: "write", items: ["a"] })

  assert.deepEqual(readSnapshot({ [TODO_METADATA_KEY]: state }), state)
  assert.equal(readSnapshot(undefined), null)
  assert.equal(readSnapshot({}), null)
  assert.equal(readSnapshot({ [TODO_METADATA_KEY]: "nope" }), null)
  assert.equal(readSnapshot({ [TODO_METADATA_KEY]: { items: "nope", nextId: 1 } }), null)
  assert.equal(readSnapshot({ [TODO_METADATA_KEY]: { items: [{ id: 1, text: 2 }], nextId: 1 } }), null)
})

test("replayTodo takes the last completed call of that tool", () => {
  const older = applyTodo(EMPTY_TODO, { action: "write", items: ["old"] })
  const newer = applyTodo(EMPTY_TODO, { action: "write", items: ["new"] })

  const results: ToolResultLike[] = [
    snapshotOf(older),
    { name: "read", status: "completed", metadata: {} },
    snapshotOf(newer),
  ]

  assert.deepEqual(replayTodo(results, "todo"), newer)
})

test("replayTodo skips unfinished and errored calls, and returns null when there is nothing", () => {
  const state = applyTodo(EMPTY_TODO, { action: "write", items: ["a"] })

  assert.equal(replayTodo([], "todo"), null)
  assert.equal(replayTodo([{ name: "todo", status: "running", metadata: { [TODO_METADATA_KEY]: state } }], "todo"), null)
  assert.equal(replayTodo([{ name: "todo", status: "error", metadata: { [TODO_METADATA_KEY]: state } }], "todo"), null)
  assert.equal(replayTodo([snapshotOf(state)], "otro"), null)
})

test("formatSummary reports progress and has an explicit empty state", () => {
  assert.equal(formatSummary(EMPTY_TODO), "no tasks yet")

  const state = applyTodo(EMPTY_TODO, { action: "write", items: ["a", "b", "c", "d", "e"] })
  const two = applyTodo(applyTodo(state, { action: "update", id: "1", status: "completed" }), {
    action: "update",
    id: "2",
    status: "completed",
  })

  assert.equal(formatSummary(two), "2 of 5 done")
})

test("formatItem marks every status", () => {
  assert.equal(formatItem({ id: "1", text: "a", status: "pending" }), "[ ] a")
  assert.equal(formatItem({ id: "2", text: "b", status: "in_progress" }), "[~] b")
  assert.equal(formatItem({ id: "3", text: "c", status: "completed" }), "[x] c")
  assert.equal(formatItem({ id: "4", text: "d", status: "cancelled" }), "[-] d")
})

test("visibleItems keeps the open work and drops the rest", () => {
  const state = applyTodo(EMPTY_TODO, { action: "write", items: ["a", "b", "c", "d"] })
  const marked = applyTodo(
    applyTodo(
      applyTodo(state, { action: "update", id: "2", status: "in_progress" }),
      { action: "update", id: "3", status: "completed" },
    ),
    { action: "update", id: "4", status: "cancelled" },
  )

  assert.deepEqual(visibleItems(marked).map((item) => item.id), ["1", "2"])
})

test("feedbackOf maps every status onto a theme feedback kind", () => {
  assert.equal(feedbackOf("pending"), "info")
  assert.equal(feedbackOf("in_progress"), "warning")
  assert.equal(feedbackOf("completed"), "success")
  assert.equal(feedbackOf("cancelled"), "info")
})

test("summaryFeedback reports the worst state present", () => {
  assert.equal(summaryFeedback(EMPTY_TODO), "info")

  const state = applyTodo(EMPTY_TODO, { action: "write", items: ["a", "b"] })
  assert.equal(summaryFeedback(state), "info")

  const running = applyTodo(state, { action: "update", id: "1", status: "in_progress" })
  assert.equal(summaryFeedback(running), "warning")

  const allDone = applyTodo(
    applyTodo(state, { action: "update", id: "1", status: "completed" }),
    { action: "update", id: "2", status: "completed" },
  )
  assert.equal(summaryFeedback(allDone), "success")
})

test("toolResultsFrom pulls this tool's results out of the assistant messages, in order", () => {
  const state = applyTodo(EMPTY_TODO, { action: "write", items: ["a"] })

  const messages = [
    { type: "user", content: [] },
    {
      type: "assistant",
      content: [
        { type: "text", text: "thinking" },
        { type: "tool", name: "todo", state: { status: "completed", metadata: { [TODO_METADATA_KEY]: state } } },
        { type: "tool", name: "read", state: { status: "completed", metadata: {} } },
      ],
    },
    {
      type: "assistant",
      content: [{ type: "tool", name: "todo", state: { status: "running", metadata: {} } }],
    },
  ]

  const results = toolResultsFrom(messages, "todo")
  assert.deepEqual(
    results.map((result) => result.status),
    ["completed", "running"],
  )
})

test("toolResultsFrom survives malformed messages and parts", () => {
  assert.deepEqual(toolResultsFrom([], "todo"), [])
  assert.deepEqual(toolResultsFrom([null, { type: "assistant" }], "todo"), [])
  assert.deepEqual(
    toolResultsFrom([{ type: "assistant", content: [null, "x", { type: "tool" }, { type: "tool", name: "todo" }] }], "todo"),
    [],
  )
})

test("messages replay end to end: the last completed call wins", () => {
  const older = applyTodo(EMPTY_TODO, { action: "write", items: ["old"] })
  const newer = applyTodo(EMPTY_TODO, { action: "write", items: ["new"] })

  const messages = [
    {
      type: "assistant",
      content: [{ type: "tool", name: "todo", state: { status: "completed", metadata: { [TODO_METADATA_KEY]: older } } }],
    },
    {
      type: "assistant",
      content: [{ type: "tool", name: "todo", state: { status: "completed", metadata: { [TODO_METADATA_KEY]: newer } } }],
    },
  ]

  assert.deepEqual(replayTodo(toolResultsFrom(messages, "todo"), "todo"), newer)
})

test("isForeignTaskTool recognizes a task list that belongs to another plugin", () => {
  // Ours, told apart by its description rather than by its name, because our own
  // registration is still listed when the plugin reloads.
  assert.equal(isForeignTaskTool({ name: "todo", description: TODO_TOOL_DESCRIPTION }), false)
  assert.equal(isForeignTaskTool({ name: "todowrite", description: TODO_TOOL_DESCRIPTION }), false)

  // A conventional task name carrying someone else's description is theirs.
  assert.equal(isForeignTaskTool({ name: "todo", description: "Manage the plan" }), true)
  assert.equal(isForeignTaskTool({ name: "todowrite", description: "Write todos" }), true)
  assert.equal(isForeignTaskTool({ name: "todos", description: "Anything at all" }), true)

  // Not a task list, whatever it is called or says. `task` is the subagent tool.
  assert.equal(isForeignTaskTool({ name: "read", description: "Read a file" }), false)
  assert.equal(isForeignTaskTool({ name: "task", description: "Run a subagent" }), false)
  assert.equal(isForeignTaskTool({ name: "todo", description: "" }), true)
})
