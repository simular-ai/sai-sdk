# Sai SDKs

Client libraries for the [Sai API](https://platform.simular.ai/documentation), one directory per
language. Each is a thin wrapper over the same contract (the developer API contract,
`docs/plans/2026-10-08-developer-api-contract.md` in this repo): the API docs define behaviour, the
SDKs add no semantics of their own.

| Directory     | Package                         | Status     |
| ------------- | ------------------------------- | ---------- |
| `python/`     | `sai-sdk` on PyPI, `import sai` | alpha      |
| `typescript/` | `@simular/sai`                  | not yet    |

Same names in every language: `sessions`, `control_sessions` / `controlSessions`, `machines`,
`models`, `files`, `account`, and later `runs`.
