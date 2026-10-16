import { Plugin } from "@opencode/plugin"

import {
  EMPTY_TODO,
  TODO_METADATA_KEY,
  TODO_TOOL_NAME,
  applyTodo,
  formatItem,
  formatSummary,
  replayTodo,
  toolResultsFrom,
  type TodoInput,
  type TodoState,
} from "./core/todo.ts"

/**
 * Pushed into every request's system prompt by the context hook.
 *
 * Constant on purpose: the system prompt sits at the front of the request, so
 * text that changed between calls would invalidate the provider's prompt cache
 * and re-bill the whole context. The current list is deliberately NOT injected —
 * the model reads it from the tool results instead, which is why this can stay
 * fixed.
 */
const INSTRUCTION = [
  "You have a `todo` tool for the plan of the task at hand.",
  'Call it with action "write" to set the list from an array of item texts,',
  '"update" to change one item\'s status by id, and "clear" to empty it.',
  "Keep it current as you work: mark an item in_progress when you start it and",
  "completed when it is done, and add items when the plan changes.",
  "It returns the full list after every call.",
].join(" ")

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["write", "update", "clear"],
      description: "write replaces the list, update changes one item, clear empties it",
    },
    items: {
      type: "array",
      items: { type: "string" },
      description: "For write: the new list, in order",
    },
    id: {
      type: "string",
      description: "For update: the id of the item to change, as shown in the last result",
    },
    status: {
      type: "string",
      enum: ["pending", "in_progress", "completed", "cancelled"],
      description: "For update: the status to set",
    },
  },
  required: ["action"],
  additionalProperties: false,
}

function render(state: TodoState): string {
  if (state.items.length === 0) return formatSummary(state)

  const lines = state.items.map((item) => `${formatItem(item)}  (id ${item.id})`)
  return [formatSummary(state), ...lines].join("\n")
}

/**
 * Server half.
 *
 * The session history is the durable record, but it is not enough on its own: a
 * tool result only lands in the history once the turn that produced it is
 * committed, so a second call in the same turn would replay a history that does
 * not contain the first one yet and lose the list. The cache below closes that
 * gap: it is seeded from the history the first time a session is touched, and
 * every call updates it. A server restart loses nothing, because the next call
 * seeds itself from the history again.
 */
export default Plugin.define({
  id: "opencode-todo.server",
  async setup(ctx) {
    const states = new Map<string, TodoState>()

    const tool = await ctx.tool.transform((editor) => {
      editor.add({
        name: TODO_TOOL_NAME,
        description:
          "Set and maintain the plan for the task at hand. write replaces the list with the given items, update changes one item's status by id, clear empties it. Call it whenever the plan changes so the user can follow along. Returns the full list.",
        input: INPUT_SCHEMA,
        execute: async (input, context) => {
          const sessionID = context.sessionID

          let current = states.get(sessionID)
          if (current === undefined) {
            const messages = await ctx.session.context({ sessionID })
            current = replayTodo(toolResultsFrom(messages, TODO_TOOL_NAME), TODO_TOOL_NAME) ?? EMPTY_TODO
          }

          const next = applyTodo(current, input as TodoInput)
          states.set(sessionID, next)

          return {
            content: render(next),
            metadata: { [TODO_METADATA_KEY]: next },
          }
        },
      })
    })

    // The plugin tells the model the tool exists, so installing it is the whole
    // setup: nothing is written into any AGENTS.md, in this project or any other.
    const instruction = await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: INSTRUCTION })
    })

    return () => {
      void tool.dispose()
      void instruction.dispose()
    }
  },
})
