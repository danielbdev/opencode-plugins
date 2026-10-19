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
5h 2% · resets in 50m
wk 0% · resets in 4d 3h
mo 0% · resets in 25d 20h
```

A window whose provider status is anything other than `ok` renders that status after the countdown, so
an exhausted or over-limit window is visible instead of showing a bare percentage.

`/usage` (or the command palette) opens the same data as a detail dialog and forces a refresh.

## How it works

Two entrypoints in one package:

| Entrypoint | Role |
| ---------- | ---- |
| `src/index.ts` (`@opencode/plugin`) | Server plugin. Resolves the `opencode-go` credential, reads the usage endpoint with a 5-minute cache, re-reads once a settled turn has moved usage, and publishes the snapshot over RPC. |
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

The plugin mirrors the endpoint exactly. The 5-minute cache bounds how stale a background reading can
be; a settled turn re-reads sooner, throttled to at most one read per minute so rapid turns cannot hammer
the endpoint.

## Security

**This plugin reads your OpenCode Go credential.** That is exactly what a malicious plugin would do, so it
deserves to be reviewed with that lens. Here is what it does with it, and how to check it yourself.

### What happens to the credential

1. The server half asks OpenCode for the `opencode-go` connection and resolves it through the credential
   store the host already owns. It never goes looking for a key on disk.
2. The key is used in exactly one place: the `Authorization` header of one `GET` to
   `https://opencode.ai/inference/go/v1/usage`, a host hardcoded in the source.
3. It is never logged (`console.` and `process.stdout` appear nowhere in the sources), never written to
   storage, and never part of the snapshot that crosses the RPC boundary. The TUI half receives
   percentages, reset instants and status strings, and nothing else.

### What you can verify instead of trusting

- **The sources ship unminified.** There is no build step and no bundle: `npm pack` publishes the same
  eight files you can read in this repository, so the audit surface is the entire program.
- **Provenance.** Releases are published from GitHub Actions over OIDC and carry a SLSA provenance
  attestation that ties the tarball to the commit and the workflow that produced it.
- **Nothing runs at install time.** There is no `preinstall`, `postinstall` or `prepare` script, so
  installing the package executes no code.

### The honest limit

The plugin API is not a sandbox: a plugin runs with the host's plugin capabilities, so the guarantee here
is the code, not an enforced restriction. That is exactly why the code ships readable and every release is
attestable. This design also keeps the exposure smaller than the alternatives — asking you to paste a key
into a config file would leave it in plain text indefinitely, and reading `auth.json` directly would
bypass the host's credential store entirely.

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

A release is cut by pushing a tag shaped `<workspace-directory>@<version>`; GitHub Actions then publishes
that package through npm trusted publishing (OIDC), so no npm token is stored anywhere.

```sh
npm version patch -w @danielbdev/opencode-go-usage --no-git-tag-version
git add packages/go-usage/package.json package-lock.json
git commit -m "chore(release): go-usage 0.1.1"
git tag -a go-usage@0.1.1 -m "go-usage 0.1.1"
git push --follow-tags
```

Use an **annotated** tag (`-a`): `git push --follow-tags` only pushes annotated tags, so a lightweight tag
would silently never trigger the workflow.

The workflow checks that the tag matches the version in the manifest, so a mistyped tag fails loudly
instead of publishing the wrong thing. It runs the tests and the typecheck before publishing, and npm
attaches a provenance attestation automatically because the repository and the package are public.

After a successful publish the workflow opens a **release page for the tag**, with notes generated from the
commits since the previous release. That is where "what changed in this version" gets answered; edit the
notes afterwards when the generated list is broader than the package being released.

Versions are **independent per package**: touching one plugin never forces a release of another.

The repository root stays at `0.0.0` and is never published; it only holds the workspace configuration.
`npm version` still needs a version there, or npm crashes while reading the workspace manifest.

## Roadmap

Agent status and a to-do list are planned as **separate packages** in the same repository, not as modes
of this one — each capability gets its own install.

## License

MIT
