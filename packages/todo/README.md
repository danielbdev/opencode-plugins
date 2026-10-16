# @danielbdev/opencode-todo

An [OpenCode](https://opencode.ai) V2 plugin that gives the agent a **to-do list you can watch**: a `todo`
tool it keeps current while it works, and a section in the session sidebar that shows the list.

## Install

```sh
opencode plugin add @danielbdev/opencode-todo
```

Requires OpenCode V2. Nothing else to configure: the plugin tells the model the tool exists, so there is no
instruction to add to any `AGENTS.md`, in this project or any other.

## What it shows

```
To-do
2 of 5 done
[~] wire the sidebar section
[ ] write the tests
```

Finished and cancelled items stay in the list, marked `[x]` and `[-]`, so the count can be checked against what is there rather than trusted.

## How it works

| Entrypoint | Role |
| ---------- | ---- |
| `src/index.ts` (`@opencode/plugin`) | Registers the `todo` tool and injects one constant line into the system prompt. |
| `src/tui.tsx` (`@opencode/plugin/tui`) | Reads the list back out of the session history and renders it. |

The tool has three actions: `write` replaces the list, `update` changes one item's status by id, and `clear`
empties it. Its result carries the full new state in the tool result metadata, and returns the list as text
so the model reads the state back from the call it just made.

### Where the list lives

**In the session history, not in plugin memory.** Every tool result carries the whole snapshot, so the
server replays the last one on every call instead of keeping state, and the TUI replays it to render.
Nothing is persisted by the plugin, a server restart loses nothing, and a reload or a session switch
reconstructs the list exactly.

The tradeoff, stated plainly: each tool call reads the session history. That is an in-process read, not a
network call, and it happens a handful of times per session.

### Why the instruction is fixed text

The plugin pushes one constant line into the system prompt through the `context` hook. It is deliberately
never dynamic: the system prompt sits at the front of the request, so text that changed between calls would
invalidate the provider's prompt cache and re-bill the whole context every turn. The current list is never
injected — the model reads it from the tool results, which is what lets the instruction stay fixed.

## Security

This plugin **reads no credentials**. It reads and writes the session's own message history, which is what
any tool does, and it makes no network request of its own.

Like every package in this repository it ships its sources unminified, with no build step and no
install-time script, and each release carries a provenance attestation.

## Development

```sh
npm install
npm test        # node --test, no build step (Node 24 type stripping)
npm run typecheck
```

`src/core/todo.ts` holds the state machine, the replay and the formatters with no host dependency, so all of
it runs under plain `node --test`.

## License

MIT
