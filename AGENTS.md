# sai-sdk — agent guide

Client libraries for the Sai API:

| Directory     | Package                            | What it is                             |
| ------------- | ---------------------------------- | -------------------------------------- |
| `python/`     | `sai-sdk` (PyPI), `import sai`     | Python SDK                             |
| `typescript/` | `@simular-ai/sai-sdk` (npm)        | TypeScript SDK                         |
| `go/`         | `github.com/simular-ai/sai-sdk/go` | Go SDK, unreleased                     |
| `mcp/`        | `@simular-ai/sai-mcp` (npm)        | MCP server for coding agents           |
| `cli/`        | `@simular-ai/sai-cli` (npm)        | `sai` CLI, deprecated, no new releases |

`mcp`, `cli` and `typescript` are npm workspaces with one lockfile at the root. `python` is a uv
project with its own lockfile. `go` is a Go module with no dependencies.

This repo was extracted from `simular-ai/simular-pro-unified-ui` with full history; see
[MIGRATION.md](MIGRATION.md). PR numbers in old commit messages point at that repo.

## Every SDK exposes the same surface

The SDKs are one product in several languages. A developer who learns one must be able to read the
other, and the docs show both side by side.

1. **`surface.json` is the contract.** It lists the client's resources, each resource's methods,
   the `Session` / `Turn` / `ControlLease` methods, the exported error classes, the event kinds and
   the turn statuses. Names are snake_case; TypeScript uses the camelCase of the same name.
2. **Each SDK has a parity test** (`python/tests/test_surface.py`,
   `typescript/test/surface.test.ts`, `go/surface_test.go`) that fails when its public methods,
   errors or enums differ from `surface.json`, in either direction.
3. **A surface change lands in every SDK in the same PR**: `surface.json`, each SDK's code and tests,
   and each SDK's README. The docs pages live in `simular-ai/sai-platform`
   (`src/docs/content/sdks/*.md`): open the docs PR there and link it from the SDK PR. Never add a
   method to one language "for now".
4. **Same behaviour, not just same names.** Defaults (poll wait 30 s, request timeout 60 s, control
   session open 240 s), error mapping (status → class, `code` from `{ error, message }` bodies), event
   kind mapping, the approval-handler contract (answer / `[response, selections]` / null to leave it
   pending) and the acknowledgement-without-task case work the same. When fixing a bug in one SDK,
   check and fix the others, and add a case to `conformance/cases`.
5. **The conformance suite checks the behaviour.** [`conformance/`](conformance/README.md) holds
   language-neutral cases (calls, the HTTP exchanges they must make, what they must return or throw)
   and a mock server that checks them. Every SDK runs every case, and runs the docs' code snippets
   against the server's fake API (snapshotted in `conformance/snippets/`). A behaviour change is a
   case change, and every SDK must pass it.
6. **Language idiom is allowed where the surface is not affected**: keyword arguments vs an options
   object, `snake_case` vs `camelCase` fields, `with` vs `try/finally` / `await using`, iterators vs
   async iterators, `bytes` vs `Uint8Array`.
7. **The SDKs add no semantics of their own.** Behaviour belongs in the API and its OpenAPI spec; the
   SDKs wrap it. Once the spec exists, types generated from it replace the hand-kept `surface.json`.

## Commands

```bash
npm ci                                   # mcp, cli, typescript
npm run lint && npm run typecheck && npm run build && npm test
cd python && uv sync && uv run pytest
cd go && go vet ./... && go test ./...
node conformance/selftest.mjs            # the conformance suite's own checks
```

Each SDK's tests start the mock server (`node conformance/server.mjs`) themselves, so Node must be
on `PATH`. The docs snippets they run are committed in `conformance/snippets/`; after a docs change
in sai-platform, refresh them with `node conformance/snippets.mjs sync` and commit the result (see
[conformance/README.md](conformance/README.md#docs-snippets)).

## Publishing

Releases go through CI only, never by hand:

- `sai-mcp-v*` tags publish `@simular-ai/sai-mcp`
  (npm trusted publishing, bound to this repo and the workflow file name).
- `sai-sdk-py-v*` publishes `sai-sdk` to PyPI (`publish-sai-sdk-py.yml`, trusted publishing through the
  `pypi` environment); `sai-sdk-ts-v*` publishes `@simular-ai/sai-sdk` to npm (`publish-sai-sdk-ts.yml`).
  Bump the version in the package manifest and the version constant together; the workflow checks the tag.
