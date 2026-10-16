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
  todoEventsFrom,
  visibleItems,
  type TodoInput,
  type TodoState,
} from "./todo.ts"

/** A first-class call to the tool: its own part, carrying the snapshot it wrote. */
function callMessage(state: TodoState): unknown {
  return {
    type: "assistant",
    content: [
      {
        type: "tool",
        name: "todo",
        state: { status: "completed", input: {}, metadata: { [TODO_METADATA_KEY]: state } },
      },
    ],
  }
}

/** A call reached through Code Mode: no part of its own, only the wrapper's record. */
function codeModeMessage(actions: readonly TodoInput[]): unknown {
  return {
    type: "assistant",
    content: [
      {
        type: "tool",
        name: "execute",
        state: {
          status: "completed",
          metadata: {
            toolCalls: actions.map((input) => ({ tool: "todo", status: "completed", input })),
          },
        },
      },
    ],
  }
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

test("replayTodo applies a snapshot where one exists and folds the actions where it does not", () => {
  const older = applyTodo(EMPTY_TODO, { action: "write", items: ["old"] })
  const newer = applyTodo(EMPTY_TODO, { action: "write", items: ["new"] })

  const events = todoEventsFrom([callMessage(older), callMessage(newer)], "todo")
  assert.deepEqual(replayTodo(events), newer)
})

test("replayTodo rebuilds the same state from a Code Mode call, which carries no snapshot", () => {
  const actions: TodoInput[] = [
    { action: "write", items: ["a", "b"] },
    { action: "update", id: "2", status: "in_progress" },
    { action: "update", id: "1", status: "completed" },
  ]

  const events = todoEventsFrom([codeModeMessage(actions)], "todo")
  assert.deepEqual(replayTodo(events), applyTodo(applyTodo(applyTodo(EMPTY_TODO, actions[0]!), actions[1]!), actions[2]!))
})

test("replayTodo mixes both shapes in order", () => {
  const fromCode = todoEventsFrom([codeModeMessage([{ action: "write", items: ["nested"] }])], "todo")
  const fromPart = todoEventsFrom([callMessage(applyTodo(EMPTY_TODO, { action: "write", items: ["direct"] }))], "todo")

  assert.deepEqual(replayTodo([...fromCode, ...fromPart]).items.map((item) => item.text), ["direct"])
  assert.deepEqual(replayTodo([...fromPart, ...fromCode]).items.map((item) => item.text), ["nested"])
})

test("replayTodo ignores unfinished, errored and unrelated calls", () => {
  const state = applyTodo(EMPTY_TODO, { action: "write", items: ["a"] })

  assert.deepEqual(replayTodo([]), EMPTY_TODO)
  assert.deepEqual(
    replayTodo(
      todoEventsFrom(
        [
          { type: "assistant", content: [{ type: "tool", name: "todo", state: { status: "running", metadata: { [TODO_METADATA_KEY]: state } } }] },
          { type: "assistant", content: [{ type: "tool", name: "todo", state: { status: "error", metadata: { [TODO_METADATA_KEY]: state } } }] },
          { type: "assistant", content: [{ type: "tool", name: "read", state: { status: "completed", metadata: { [TODO_METADATA_KEY]: state } } }] },
        ],
        "todo",
      ),
    ),
    EMPTY_TODO,
  )
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

test("todoEventsFrom records only completed calls to this tool, in order", () => {
  const state = applyTodo(EMPTY_TODO, { action: "write", items: ["a"] })

  const events = todoEventsFrom(
    [
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
    ],
    "todo",
  )

  assert.equal(events.length, 1)
  assert.deepEqual(events[0]?.snapshot, state)
})

test("todoEventsFrom survives malformed messages and parts", () => {
  assert.deepEqual(todoEventsFrom([], "todo"), [])
  assert.deepEqual(todoEventsFrom([null, { type: "assistant" }], "todo"), [])
  assert.deepEqual(
    todoEventsFrom(
      [{ type: "assistant", content: [null, "x", { type: "tool" }, { type: "tool", name: "todo" }] }],
      "todo",
    ),
    [],
  )
  assert.deepEqual(
    todoEventsFrom(
      [{ type: "assistant", content: [{ type: "tool", name: "execute", state: { status: "completed" } }] }],
      "todo",
    ),
    [],
  )
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
