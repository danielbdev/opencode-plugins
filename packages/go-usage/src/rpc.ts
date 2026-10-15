import { Rpc } from "@opencode/plugin/rpc"

/**
 * RPC contract shared by the server plugin (producer) and the TUI plugin
 * (consumer).
 *
 * The schemas are intentionally permissive. The snapshot crosses a process and
 * validation boundary, so the TUI re-parses it defensively with
 * `parseSnapshot` from `core/usage.ts` instead of trusting a generated type.
 * No credential ever appears in this contract: the snapshot carries only
 * percentages, reset instants and status strings.
 */
export const UsageRpc = Rpc.define({
  id: "go-usage",
  methods: {
    get: {
      input: {
        type: "object",
        properties: {
          /** Bypass the refresh interval and re-read the endpoint now. */
          refresh: { type: "boolean" },
        },
        additionalProperties: true,
      },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {
    updated: {
      /**
       * The full snapshot travels in the event payload, so the TUI applies it
       * directly instead of issuing a second round trip. No properties are
       * declared: the schema stays permissive on purpose and the consumer
       * re-parses defensively.
       */
      schema: { type: "object", additionalProperties: true },
    },
  },
})

export type UsageRpcDefinition = typeof UsageRpc
