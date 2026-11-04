# Sai SDKs

Client libraries for the [Sai API](https://platform.simular.ai/documentation): hand desktop work to Sai,
or drive a cloud computer directly.

| Directory                    | Package                                  | Status     |
| ---------------------------- | ---------------------------------------- | ---------- |
| [`python/`](python/)         | `sai-sdk` (PyPI), `import sai`           | published  |
| [`typescript/`](typescript/) | `@simular-ai/sai-sdk` (npm)              | published  |
| [`go/`](go/)                 | `github.com/simular-ai/sai-sdk/go`       | published  |
| [`java/`](java/)             | `ai.simular:sai-sdk` (Maven)             | published  |
| [`dotnet/`](dotnet/)         | `Simular.Sai` (NuGet)                    | published  |
| [`ruby/`](ruby/)             | `sai-sdk` (RubyGems), `require "sai"`    | published  |
| [`mcp/`](mcp/)               | `@simular-ai/sai-mcp`: MCP server        | published  |
| [`cli/`](cli/)               | `@simular-ai/sai-cli`: the `sai` command | deprecated |

Every SDK exposes the surface in [`surface.json`](surface.json), checked by each SDK's parity test.
See [AGENTS.md](AGENTS.md) for the rules and commands.

MIT licensed (see each package's `LICENSE`).
