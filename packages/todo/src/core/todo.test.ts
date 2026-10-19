import { test } from "node:test"
import assert from "node:assert/strict"

import {
  EMPTY_TODO,
  TODO_METADATA_KEY,
  TODO_TOOL_DESCRIPTION,
  applyTodo,
  carriesWholeList,
  formatHeader,
  formatItem,
  formatSectionTitle,
  formatSummary,
  groupBySession,
  isForeignTaskTool,
  readSnapshot,
  replayTodo,
  summaryTone,
  todoEventsFrom,
  toneOf,
  unseenMessages,
  type AgentList,
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

test("unseenMessages takes each message in once, in order", () => {
  const seen = new Set<string>()
  const first = { id: "msg_a", type: "user" }
  const second = { id: "msg_b", type: "assistant" }

  assert.deepEqual(unseenMessages(seen, [first, second]), [first, second])

  // A window sliding back over what we already have adds nothing, so a call is
  // never folded in twice.
  assert.deepEqual(unseenMessages(seen, [second, first]), [])

  assert.deepEqual(unseenMessages(seen, [{ id: "msg_c" }]), [{ id: "msg_c" }])
})

test("unseenMessages drops what it cannot remember", () => {
  const seen = new Set<string>()

  assert.deepEqual(unseenMessages(seen, [null, "x", { type: "assistant" }, { id: 7 }]), [])
  assert.equal(seen.size, 0)
})

test("carriesWholeList is true only where a call replaced the whole list", () => {
  const state = applyTodo(EMPTY_TODO, { action: "write", items: ["a", "b"] })

  // A first-class call carries the snapshot it wrote.
  assert.equal(carriesWholeList([callMessage(state)], "todo"), true)

  // So does a write reached through Code Mode: it resets the list either way.
  assert.equal(carriesWholeList([codeModeMessage([{ action: "write", items: ["a"] }])], "todo"), true)

  // An update on its own proves nothing: the window is missing the write it edits,
  // and a fold of it lands on nothing. This is the long-session case.
  assert.equal(
    carriesWholeList([codeModeMessage([{ action: "update", id: "2", status: "completed" }])], "todo"),
    false,
  )
  assert.equal(carriesWholeList([], "todo"), false)
  assert.equal(carriesWholeList([{ type: "assistant", content: [] }], "todo"), false)
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

test("groupBySession keeps the viewed session first and drops the ones with nothing", () => {
  const rootState = applyTodo(EMPTY_TODO, { action: "write", items: ["root"] })
  const childState = applyTodo(EMPTY_TODO, { action: "write", items: ["child"] })

  const groups = groupBySession(
    [
      { id: "child", agent: "explore", messages: [callMessage(childState)] },
      { id: "quiet", agent: "verify", messages: [] },
      { id: "root", messages: [callMessage(rootState)] },
    ],
    "root",
    "todo",
  )

  assert.deepEqual(
    groups.map((group) => [group.sessionID, group.agent, group.root]),
    [
      ["root", null, true],
      ["child", "explore", false],
    ],
  )
})

test("formatHeader names the owner of a list and marks a folded one", () => {
  const started = applyTodo(
    applyTodo(EMPTY_TODO, { action: "write", items: ["a", "b", "c"] }),
    { action: "update", id: "1", status: "completed" },
  )
  const root: AgentList = { sessionID: "root", agent: null, root: true, state: started }
  const child: AgentList = { sessionID: "child", agent: "explore", root: false, state: started }

  assert.equal(formatHeader(root, false), "1 of 3 done")
  assert.equal(formatHeader(child, false), "explore · 1 of 3 done")

  // A folded list says so instead of reading as a plan with nothing under it.
  assert.equal(formatHeader(root, true), "▸ 1 of 3 done")
  assert.equal(formatHeader(child, true), "▸ explore · 1 of 3 done")

  // A subagent OpenCode did not name still gets a line of its own.
  assert.equal(formatHeader({ ...child, agent: null }, false), "subagent · 1 of 3 done")
})

test("formatSectionTitle marks the section once it is folded away", () => {
  assert.equal(formatSectionTitle(false), "TO-DO")
  assert.equal(formatSectionTitle(true), "▸ TO-DO")
})

test("toneOf maps every status onto a theme slot", () => {
  assert.equal(toneOf("pending"), "muted")
  assert.equal(toneOf("in_progress"), "warning")
  assert.equal(toneOf("completed"), "success")
  assert.equal(toneOf("cancelled"), "muted")
})

test("summaryTone is loud only while something is in flight", () => {
  assert.equal(summaryTone(EMPTY_TODO), "base")

  const state = applyTodo(EMPTY_TODO, { action: "write", items: ["a", "b"] })
  assert.equal(summaryTone(state), "base")

  const running = applyTodo(state, { action: "update", id: "1", status: "in_progress" })
  assert.equal(summaryTone(running), "warning")

  // Finished is not a celebration: the items carry the green, the header does not.
  const allDone = applyTodo(
    applyTodo(state, { action: "update", id: "1", status: "completed" }),
    { action: "update", id: "2", status: "completed" },
  )
  assert.equal(summaryTone(allDone), "base")
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
