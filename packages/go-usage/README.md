# @danielbdev/opencode-go-usage

An [OpenCode](https://opencode.ai) V2 plugin that shows your **OpenCode Go** subscription usage in the
session sidebar: the rolling 5-hour window, the weekly window and the monthly window, each with the time
left until it resets.

## Install

```sh
opencode plugin add @danielbdev/opencode-go-usage
```

Requires OpenCode V2. The Go integration must be connected (`/connect` → OpenCode Go).

## What it shows

A `Go usage` section at the top of the sidebar content region, above the context block:

```
Go usage
5h 0% · resets in 4h 52m
wk 2% · resets in 3d 3h
mo 1% · resets in 24d 20h
```

`/usage` (or the command palette) opens the same data as a detail dialog and forces a refresh.

## How it works

Two entrypoints in one package:

| Entrypoint | Role |
| ---------- | ---- |
| `src/index.ts` (`@opencode/plugin`) | Server plugin. Resolves the `opencode-go` credential, reads the usage endpoint with a 5-minute cache, and publishes the snapshot over RPC. |
| `src/tui.tsx` (`@opencode/plugin/tui`) | TUI plugin. Renders the sidebar section and the `/usage` command. |

The credential never leaves the server process. The TUI plugin **cannot** read a credential — the
OpenCode client exposes only `credential.update/activate/remove` — so the split is not a style choice,
it is the only design that keeps the secret out of the terminal plugin. Only percentages, reset
instants and status strings cross the RPC boundary.

### Data source

```
GET https://opencode.ai/inference/go/v1/usage
Authorization: Bearer <opencode-go key>
```

```json
{ "usage": {
    "rolling": { "status": "ok", "percent": 2, "resetsAt": "2026-10-14T21:25:45.000Z" },
    "weekly":  { "status": "ok", "percent": 0, "resetsAt": "2026-10-19T00:00:00.000Z" },
    "monthly": { "status": "ok", "percent": 0, "resetsAt": "2026-11-09T17:09:16.000Z" } } }
```

This endpoint is **live but undocumented**. Two consequences the code respects:

- The three percentages are **not** monotonic (observed: rolling 2% while weekly and monthly were 0%),
  so each value is rendered exactly as received and never derived from another window.
- Because the endpoint can change without notice, every failure degrades to an explicit state
  (`Usage unavailable: ...`) instead of breaking the TUI.

The plugin mirrors the endpoint exactly; its own 5-minute cache is the only staleness it can add.

## Development

```sh
npm install
npm test        # node --test, no build step (Node 24 type stripping)
npm run typecheck
```

`src/core/usage.ts` is the only module with logic worth testing and it has no host dependency, so the
whole model, the parser and the formatters run under plain `node --test`.

This package lives in a monorepo of atomic plugins: each package does one thing and installs alone.

## Releasing

Versions are **independent per package**: touching one plugin never forces a release of another.

```sh
npm version patch -w @danielbdev/opencode-go-usage   # or minor / major
npm publish -w @danielbdev/opencode-go-usage --access public
```

`--access public` is required on every publish: scoped packages default to private.

`npm publish --workspaces` publishes every package at once, but npm refuses to republish a version that
already exists, so it only fits when every package is bumped together.

The repository root stays at `0.0.0` and is never published; it only holds the workspace configuration.
`npm version` also needs a version there, or npm crashes while reading the workspace manifest.

## Roadmap

Agent status and a to-do list are planned as **separate packages** in the same repository, not as modes
of this one — each capability gets its own install.

## License

MIT
