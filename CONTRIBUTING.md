# Contributing to distill

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Security problems go through a private advisory, not a public issue. See [SECURITY.md](SECURITY.md).

## Setup

Node 20 or newer (CI uses 22).

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run test:e2e
npm run test:smoke
```

`npm run dev:web` runs the web UI with Vite next to a server on `:4321`.

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
