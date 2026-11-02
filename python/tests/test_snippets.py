"""Every Python block in the docs (sai-platform) runs against the mock server's fake API.
See ../../conformance/README.md#docs-snippets."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

CONFORMANCE = Path(__file__).resolve().parents[2] / "conformance"


def _snippets() -> list[dict[str, Any]]:
    out = subprocess.run(
        ["node", str(CONFORMANCE / "snippets.mjs"), "--lang", "python"], capture_output=True, text=True
    )
    if out.returncode != 0:
        if os.environ.get("SAI_DOCS_REQUIRED") == "1":
            raise RuntimeError(out.stderr)
        return []
    return json.loads(out.stdout)


SNIPPETS = _snippets()


@pytest.fixture(scope="module")
def mock_url() -> Iterator[str]:
    proc = subprocess.Popen(
        ["node", str(CONFORMANCE / "server.mjs")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
    )
    assert proc.stdout is not None
    yield proc.stdout.readline().strip().removeprefix("SAI_MOCK_URL=")
    proc.kill()
    proc.wait()


@pytest.fixture(scope="module")
def workdir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    d = tmp_path_factory.mktemp("snippets")
    shutil.copytree(CONFORMANCE / "fixtures", d, dirs_exist_ok=True)
    return d


@pytest.mark.skipif(not SNIPPETS, reason="no docs: check out sai-platform next to sai-sdk, or set SAI_DOCS_DIR")
@pytest.mark.parametrize("snippet", SNIPPETS, ids=[f"{s['file']}:{s['line']}" for s in SNIPPETS])
def test_snippet(snippet: dict[str, Any], mock_url: str, workdir: Path) -> None:
    httpx.post(f"{mock_url}/__mock/reset")
    name = re.sub(r"\W", "_", snippet["file"])
    path = workdir / f"{name}_{snippet['line']}.py"
    path.write_text(f"{snippet['context']}\n\n{snippet['code']}\n" if snippet["context"] else snippet["code"])
    env = {
        **os.environ,
        "SAI_API_KEY": "sapi_docs",
        "SAI_ORG_KEY": "sapi_docs_org",
        "SAI_API_URL": mock_url,
        "SAI_ORG_ID": "org_docs",
    }
    r = subprocess.run([sys.executable, str(path)], cwd=workdir, env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
