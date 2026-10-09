# Migration from the monorepo

Extracted from `simular-ai/simular-pro-unified-ui` on 2026-10-09 with full history, as phase 1 of the
repo split (that repo's `docs/plans/2026-10-09-split-sai-sdk-sai-platform.md`).

- Source: `main` at `ad8c64fc270520b6597bf5dbb40dad63ed568b53`.
- Paths: `packages/sai-mcp` → `mcp/`; `packages/sai-cli` and its earlier path `packages/sapi-cli` →
  `cli/`; `.github/workflows/publish-sai-{mcp,cli}.yml`. Tags kept: `sai-mcp-v*`, `sai-cli-v*`.
- Command:

  ```bash
  git filter-repo \
    --path packages/sai-mcp/ --path packages/sai-cli/ --path packages/sapi-cli/ \
    --path .github/workflows/publish-sai-mcp.yml --path .github/workflows/publish-sai-cli.yml \
    --path-rename packages/sai-mcp/:mcp/ \
    --path-rename packages/sai-cli/:cli/ \
    --path-rename packages/sapi-cli/:cli/ \
    --replace-message pr-refs.txt   # '#123' → 'simular-ai/simular-pro-unified-ui#123'
  ```

- `python/`, `typescript/`, `surface.json`: replayed commit by commit from the monorepo branch
  `chenchen/sai-python-sdk` (closed PR simular-ai/simular-pro-unified-ui#3103), which never merged there.
- [`docs/monorepo-commit-map.txt`](docs/monorepo-commit-map.txt): old SHA → new SHA for every kept commit,
  to follow a SHA from an old PR, issue or Slack thread.
