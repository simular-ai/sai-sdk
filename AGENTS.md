# SDKs — agent guide

`sdk/` holds the Sai API client libraries, one directory per language: `python/` (`sai-sdk`,
`import sai`) and `typescript/` (`@simular-ai/sai-sdk`). They are standalone packages, not npm
workspaces: each has its own lockfile and test command.

## Every SDK exposes the same surface

The SDKs are one product in several languages. A developer who learns one must be able to read the
other, and the docs show both side by side.

1. **`sdk/surface.json` is the contract.** It lists the client's resources, each resource's methods,
   the `Session` / `Turn` / `ControlSession` methods, the exported error classes, the event kinds and
   the turn statuses. Names are snake_case; TypeScript uses the camelCase of the same name.
2. **Each SDK has a parity test** (`python/tests/test_surface.py`, `typescript/test/surface.test.ts`)
   that fails when its public methods, errors or enums differ from `surface.json`, in either direction.
3. **A surface change lands in every SDK in the same PR**: `surface.json`, each SDK's code and tests,
   each SDK's README, and the docs pages (`platform/src/docs/content/sdks/*.md`). Never add a method to
   one language "for now".
4. **Same behaviour, not just same names.** Defaults (poll wait 30 s, request timeout 60 s, control
   session open 240 s), error mapping (status → class, `code` from `{ error, message }` bodies), event
   kind mapping, the approval-handler contract (answer / `[response, selections]` / null to leave it
   pending) and the acknowledgement-without-task case work the same. When fixing a bug in one SDK,
   check and fix the other, and add the same test to both suites.
5. **Language idiom is allowed where the surface is not affected**: keyword arguments vs an options
   object, `snake_case` vs `camelCase` fields, `with` vs `try/finally` / `await using`, iterators vs
   async iterators, `bytes` vs `Uint8Array`.
6. **The SDKs add no semantics of their own.** Behaviour belongs in the API and its docs; the SDKs wrap
   it. The names follow `docs/plans/2026-10-08-developer-api-contract.md`.

## Commands

```bash
cd sdk/python && uv sync && uv run pytest
cd sdk/typescript && npm install && npm test && npm run typecheck
```

CI runs both on any change under `sdk/` (`.github/workflows/sdk.yml`).

## Publishing

PyPI and npm releases go through CI only, after the sai-sdk repo split. Do not publish by hand.
Bump both SDKs' versions together.
