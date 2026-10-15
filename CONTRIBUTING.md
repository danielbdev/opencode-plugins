# Contributing

Thanks for wanting to improve these plugins. This repository is a small collection of **atomic** OpenCode
plugins: each package does one thing, installs alone, and never depends on a sibling.

## Before you write code

Open an issue first for anything that is not a trivial fix. Describe what you expected, what happened,
and the smallest reproduction you have. A pull request that arrives without an agreed problem is hard to
review, and it usually has to be rewritten.

## The development loop

```sh
npm install
npm test
npm run typecheck
```

There is no build step: the packages ship their TypeScript sources, and Node runs them directly. Tests use
`node --test` with no framework.

## What a good pull request looks like

- **One concern per pull request**, and one package per pull request. If you touch two plugins, send two.
- **Behaviour changes come with a test.** The pure modules (`packages/*/src/core/`) are where the logic
  lives, precisely so it can be tested without a host.
- **Keep the plugin's surface honest.** A plugin that needs a credential does the credential work in a
  server entrypoint, never in the TUI half, and never persists it. See the Security section of the
  affected package README.
- **Conventional commits** (`fix:`, `feat:`, `docs:`, `chore:`), with a body that says why when the reason
  is not obvious from the diff.
- **No version bumps.** Releases are cut by the maintainer with a tag; a version bump in a pull request
  will be dropped.

## The release path is protected

`.github/workflows/` and the package manifests decide what gets published. Changes there need the
maintainer's review — see `.github/CODEOWNERS` — and nobody but the maintainer creates release tags. If
you believe the release process itself needs to change, open an issue and explain the problem instead of
sending a patch.

## Reporting a security problem

Do not open a public issue for a vulnerability, and never paste a credential, a token or a full
configuration file into an issue or a pull request. Open a private security advisory through the
repository's Security tab, or contact the maintainer directly.

## License

Contributions are accepted under the MIT license that covers this repository.
