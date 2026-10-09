# sai-sdk — agent guide

Client libraries for the Sai API:

| Directory     | Package                        | What it is                   |
| ------------- | ------------------------------ | ---------------------------- |
| `python/`     | `sai-sdk` (PyPI), `import sai` | Python SDK                   |
| `typescript/` | `@simular-ai/sai-sdk` (npm)    | TypeScript SDK               |
| `mcp/`        | `@simular-ai/sai-mcp` (npm)    | MCP server for coding agents |
| `cli/`        | `@simular-ai/sai-cli` (npm)    | `sai` command-line interface |

`mcp`, `cli` and `typescript` are npm workspaces with one lockfile at the root. `python` is a uv
project with its own lockfile.

This repo was extracted from `simular-ai/simular-pro-unified-ui` with full history; see
[MIGRATION.md](MIGRATION.md). PR numbers in old commit messages point at that repo.

## Every SDK exposes the same surface

The SDKs are one product in several languages. A developer who learns one must be able to read the
other, and the docs show both side by side.

1. **`surface.json` is the contract.** It lists the client's resources, each resource's methods,
   the `Session` / `Turn` / `ControlSession` methods, the exported error classes, the event kinds and
   the turn statuses. Names are snake_case; TypeScript uses the camelCase of the same name.
2. **Each SDK has a parity test** (`python/tests/test_surface.py`, `typescript/test/surface.test.ts`)
   that fails when its public methods, errors or enums differ from `surface.json`, in either direction.
3. **A surface change lands in every SDK in the same PR**: `surface.json`, each SDK's code and tests,
   and each SDK's README. The docs pages live in `simular-ai/sai-platform`
   (`src/docs/content/sdks/*.md`): open the docs PR there and link it from the SDK PR. Never add a
   method to one language "for now".
4. **Same behaviour, not just same names.** Defaults (poll wait 30 s, request timeout 60 s, control
   session open 240 s), error mapping (status → class, `code` from `{ error, message }` bodies), event
   kind mapping, the approval-handler contract (answer / `[response, selections]` / null to leave it
   pending) and the acknowledgement-without-task case work the same. When fixing a bug in one SDK,
   check and fix the other, and add the same test to both suites.
5. **Language idiom is allowed where the surface is not affected**: keyword arguments vs an options
   object, `snake_case` vs `camelCase` fields, `with` vs `try/finally` / `await using`, iterators vs
   async iterators, `bytes` vs `Uint8Array`.
6. **The SDKs add no semantics of their own.** Behaviour belongs in the API and its OpenAPI spec; the
   SDKs wrap it. Once the spec exists, types generated from it replace the hand-kept `surface.json`.

## Commands

```bash
npm ci                                   # mcp, cli, typescript
npm run lint && npm run typecheck && npm test
cd python && uv sync && uv run pytest
```

## Publishing

Releases go through CI only, never by hand:

- `sai-mcp-v*` / `sai-cli-v*` tags publish `@simular-ai/sai-mcp` / `@simular-ai/sai-cli`
  (npm trusted publishing, bound to this repo and the workflow file name).
- The Python and TypeScript SDKs are not published yet.
