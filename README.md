# Sai SDKs

Client libraries for the [Sai API](https://platform.simular.ai/documentation), one directory per
language. Each is a thin wrapper over the same contract (the developer API contract,
`docs/plans/2026-10-08-developer-api-contract.md` in this repo): the API docs define behaviour, the
SDKs add no semantics of their own.

| Directory     | Package                         | Status |
| ------------- | ------------------------------- | ------ |
| `python/`     | `sai-sdk` on PyPI, `import sai` | alpha  |
| `typescript/` | `@simular-ai/sai-sdk` on npm    | alpha  |

Every SDK exposes the surface in `surface.json`, checked by each SDK's parity test. See
[AGENTS.md](AGENTS.md) for the rules.
