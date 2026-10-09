# Sai SDKs

Client libraries for the [Sai API](https://platform.simular.ai/documentation): hand desktop work to Sai,
or drive a cloud computer directly.

| Directory                    | Package                                  | Status    |
| ---------------------------- | ---------------------------------------- | --------- |
| [`python/`](python/)         | `sai-sdk` (PyPI), `import sai`           | alpha     |
| [`typescript/`](typescript/) | `@simular-ai/sai-sdk` (npm)              | alpha     |
| [`mcp/`](mcp/)               | `@simular-ai/sai-mcp`: MCP server        | published |
| [`cli/`](cli/)               | `@simular-ai/sai-cli`: the `sai` command | published |

Every SDK exposes the surface in [`surface.json`](surface.json), checked by each SDK's parity test.
See [AGENTS.md](AGENTS.md) for the rules and commands.

MIT licensed (see each package's `LICENSE`).
