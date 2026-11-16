# Contributing to distill

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Security problems go through a private advisory, not a public issue. See [SECURITY.md](SECURITY.md).

## Setup

Node 22.12 or newer.

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run test:e2e
npm run test:smoke
```

For UI work, run `npm run build && node dist/cli.js --no-open` in one terminal and `npm run dev:web` (Vite, proxying `/api` to `:4321`) in another.

## Conventions

- TypeScript, ESM, imports without the `.js` extension.
- No inline comments: names and small functions should explain the code.
- Boosters are pure and idempotent, and never touch fenced code blocks or front matter. Every booster change needs fixtures that prove it does not drop content.
- UI strings live in `web/src/strings.ts` and are in English.
- Never edit `package-lock.json` or `lingua-runtime/package-lock.json` by hand; `npm run check:deps` keeps the pinned versions in sync.
- Nothing may send documents off the machine or add telemetry.
- Commits follow Conventional Commits (`feat(cli): …`, `fix(hooks): …`).

## Pull requests

Keep them focused, include tests, and make sure `npm test`, `npm run typecheck` and `npm run test:smoke` pass. Describe what changed for the user, not only in the code.

## Releasing

A release is one PR that bumps the version with `npm version X.Y.Z --no-git-tag-version`. Commit `package.json` and `package-lock.json`. `npm version` also syncs `server.json` and the plugin version, so commit those too. Optionally add `release-notes/vX.Y.Z.md`; without it, GitHub generates the notes from the merged PRs.

After that PR merges into `main`, everything runs on its own:

1. The `Tag release` workflow creates `vX.Y.Z`, only if it is new and higher than every existing release tag, and starts `Release`.
2. `Release` builds and signs the installers for macOS, Windows and Linux, verifies every update manifest (size and SHA-512) against the files, publishes the GitHub release and starts `Publish`.
3. `Publish` stages `distill-llm` on npm and pushes the multi-arch image to `ghcr.io/nievesjesus/distill`. It fails if `package.json` does not match the tag.

The only manual step: a maintainer approves the staged version with 2FA on npmjs.com > `distill-llm` > Staged Packages, or with `npm stage list distill-llm` then `npm stage approve <stage-id>`. Only then does it become public, with provenance.

Within the hour after the npm approval, the `MCP registry` workflow (`mcp-registry.yml`) lists the version in the official MCP registry; you can also run it by hand.

If a build or the verification fails, the release stays a draft and nothing reaches npm. Re-run the failed jobs, or fix and publish the draft by hand; publishing a draft by hand also starts `Publish`.

Release tags `v*` can be created but never moved or deleted (repository ruleset).

Installer names carry no version (`Distill-lite-mac-arm64.dmg`), so the site's `releases/latest/download/<file>` links keep working; do not add `${version}` back to `artifactName`. Intel Macs get only the lite installer, because the LLMLingua-2 ONNX runtime supports Apple Silicon, Windows x64 and Linux x64 only.

npm uses trusted publishing (OIDC) with staged publishing, so the workflow holds no npm token. The trusted publisher is configured on npmjs.com under the `distill-llm` package's Settings > Trusted Publisher: repository `nievesjesus/distill`, workflow `publish.yml`, with "Allow npm publish" left off so the workflow can only run `npm stage publish`. Nothing reaches the registry until a maintainer approves it with 2FA.

### Signing secrets and variables

Signing is optional. Each step is skipped when its values are missing, so forks and local builds produce unsigned installers.

- macOS signing and notarization (all five required): secrets `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
- Windows signing through SignPath: secret `SIGNPATH_API_TOKEN` and variable `SIGNPATH_ORGANIZATION_ID` (both required); optional variables `SIGNPATH_PROJECT_SLUG` (default `distill`), `SIGNPATH_POLICY_SLUG` (default `release-signing`) and `SIGNPATH_ARTIFACT_CONFIG_SLUG` (default `installers`). In SignPath, create an artifact configuration whose root is a `zip-file` containing `pe-file` entries for `Distill-*.exe`, signed with Authenticode.
