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

**The session history is the durable record, and a cache closes the gap inside a turn.** Every tool result
carries the whole snapshot, so nothing is lost on a reload, a session switch or a restart.

The cache exists for a reason worth stating: a tool result only lands in the history once the turn that
produced it is committed, so a second call in the same turn would replay a history that does not contain the
first one yet and lose the list. The server therefore keeps a per-session state, seeded from the history the
first time a session is touched, and a restart loses nothing because the next call seeds itself again.

The tradeoff, stated plainly: the first call of a session reads that session's history. It is an in-process
read, not a network call, and it happens once per session.

**The sidebar reads that same history through a window, so it keeps its own copy of the calls.** The TUI data
layer holds the newest messages of a session and forgets the older ones, and a `sync` replaces that window
instead of extending it. A plan set earlier in a long session therefore ends up outside it, and replaying what
the window has alone would show nothing for a session that has one. So the section takes in the calls it sees
as they happen and, while what it holds has no `write`, `clear` or snapshot in it, reads back through the
session until it finds one. The read is skipped when the window already carries one, which is the case for
every session short enough to fit in a page.

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
