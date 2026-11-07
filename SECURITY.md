# Security policy

distill runs on your machine and reads files you point it at, so we take reports about file access, the local servers and the agent hooks seriously.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead: **Security → Report a vulnerability** on [nievesjesus/distill](https://github.com/nievesjesus/distill/security/advisories/new). Include the version, your OS, the steps to reproduce and the impact you expect.

You should get an answer within a week.

## Scope

In scope, for example:

- Reading files outside the `--root` directories of `distill-llm mcp --http`.
- Bypassing the host, origin or cross-site checks of the web server or the MCP HTTP server.
- A hook or plugin that blocks reads, runs unintended commands or writes outside its cache.
- `distill-llm hooks install` writing outside the intended settings file or leaking existing settings.

Out of scope: exposing a server with `--host 0.0.0.0` on an untrusted network (documented as unauthenticated), and parsing bugs inside LiteParse (please report those [upstream](https://github.com/run-llama/liteparse)).
