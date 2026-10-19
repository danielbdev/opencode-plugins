# @danielbdev/opencode-agents

An [OpenCode](https://opencode.ai) V2 plugin that shows the status of your **subagents** in the session
sidebar, below the MCP block.

## Install

```sh
opencode plugin add @danielbdev/opencode-agents
```

Requires OpenCode V2.

## What it shows

```
Agents
2 running · 4 done · 1 failed
explore · 42s
general · 3m
verify · failed · 3m
```

Succeeded subagents are counted but not listed, so the section stays short. Running ones come first,
then the failed ones.

Colour comes from the theme's semantic feedback slots — succeeded green, running yellow, failed or
interrupted red — and the count line takes the worst state present, so a failure colours the whole
section at a glance. Nothing here names a colour: it resolves through `theme.text.feedback[kind].base`,
so the semaphore follows whatever theme you run.

## How it works

TUI-only: subagent data is already in the TUI's data layer, so this package ships **no server half, no
credential handling and no RPC**. It reads the session family of the session it renders in.

The state comes from fields that are queryable, not inferred from events:

| Field | Meaning |
| ----- | ------- |
| `parentID` | marks a record as a subagent |
| `agent` | the agent name |
| `outcome` | `succeeded`, `failed` or `interrupted` |
| `time.created` / `time.idle` | elapsed time |
| `data.session.status(id)` | adds the liveness bit: `idle` or `running` |

## Security

This plugin **reads no credentials and makes no network requests**. It has no server half, so there is
nothing to authenticate and nothing to send anywhere.

What it does read is the host's session records for the session it renders in: the agent name, the outcome
and the timing of each subagent. That is the feature — a status section cannot work without reading
status. Nothing is written back, nothing is persisted, and the data never leaves the TUI process.

Like every package in this repository it ships its sources unminified, with no build step and no
install-time script. Releases are built and staged by CI from this repository and published only after a
maintainer approves the staged version with 2FA; `npm audit signatures` reports whether a published version
carries a provenance attestation.

## Development

```sh
npm install
npm test        # node --test, no build step (Node 24 type stripping)
npm run typecheck
```

`src/core/agents.ts` holds the state mapping, the counts and the formatters with no host dependency, so
all of it runs under plain `node --test`.

This package lives in a monorepo of atomic plugins: each package does one thing and installs alone.

## Releasing

Same flow as every package in this repository: bump, commit, tag `<directory>@<version>`, push the tag, and
GitHub Actions stages the version; a maintainer then approves it with 2FA. See the repository README and
the sibling package's Releasing section for the exact commands.

## License

MIT
