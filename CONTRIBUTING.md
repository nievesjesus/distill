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

1. Bump `version` in `package.json` and commit it.
2. Tag the commit `vX.Y.Z` and push the tag. The Release workflow builds the installers for macOS, Windows and Linux and attaches them to a draft release. Installer names carry no version (`Distill-lite-mac-arm64.dmg`), so the site's `releases/latest/download/<file>` links keep working; do not add `${version}` back to `artifactName`. Intel Macs get only the lite installer, because the LLMLingua-2 ONNX runtime supports Apple Silicon, Windows x64 and Linux x64 only.
3. Review the draft, then publish the release.
4. Publishing triggers the Publish workflow: it publishes `distill-llm` to npm with provenance and pushes the multi-arch image to `ghcr.io/nievesjesus/distill`. It fails if `package.json` does not match the tag.

npm uses trusted publishing (OIDC), configured on npmjs.com under the `distill-llm` package's Settings > Trusted Publisher (repository `nievesjesus/distill`, workflow `publish.yml`). A trusted publisher can only be added to a package that already exists, so the very first publish is a bootstrap: add a granular npm token with publish rights as the `NPM_TOKEN` secret, publish the first release, set up the trusted publisher, then delete the secret. While `NPM_TOKEN` is absent the workflow uses OIDC.

### Signing secrets and variables

Signing is optional. Each step is skipped when its values are missing, so forks and local builds produce unsigned installers.

- macOS signing and notarization (all five required): secrets `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
- Windows signing through SignPath: secret `SIGNPATH_API_TOKEN` and variable `SIGNPATH_ORGANIZATION_ID` (both required); optional variables `SIGNPATH_PROJECT_SLUG` (default `distill`), `SIGNPATH_POLICY_SLUG` (default `release-signing`) and `SIGNPATH_ARTIFACT_CONFIG_SLUG` (default `installers`). In SignPath, create an artifact configuration whose root is a `zip-file` containing `pe-file` entries for `Distill-*.exe`, signed with Authenticode.
