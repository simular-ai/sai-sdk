from __future__ import annotations

import os
import urllib.parse
from pathlib import Path
from typing import Optional, Union

import httpx

from ._http import DEFAULT_BASE_URL, HTTP
from .control import ControlSessions
from .machines import Machines
from .sessions import Sessions
from .types import Account, Attachment, Model


class Sai:
    """The Sai API client.

    ```python
    sai = Sai()  # SAI_API_KEY, and SAI_API_URL if set
    session = sai.sessions.create()
    print(session.run("Open Notepad and type hello").text)
    ```
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        timeout: float = 60.0,
        version_tag: Optional[str] = None,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        key = api_key or os.environ.get("SAI_API_KEY")
        if not key:
            raise ValueError("No API key: pass api_key= or set SAI_API_KEY. Create one at https://platform.simular.ai.")
        self._http = HTTP(
            key,
            base_url or os.environ.get("SAI_API_URL") or DEFAULT_BASE_URL,
            timeout=timeout,
            version_tag=version_tag,
            transport=transport,
        )
        self.machines = Machines(self)
        self.sessions = Sessions(self)
        self.control_sessions = ControlSessions(self)
        self.models = _Models(self)
        self.files = _Files(self)
        self.account = _Account(self)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Sai:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class _Models:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def list(self) -> list[Model]:
        """Models a session can run on; `allowed` says whether this plan may use each."""
        d = self._sai._http.json("GET", "/v1/agents/models")
        return [Model.parse(m) for m in d.get("models") or []]


class _Files:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def upload(self, file: Union[str, Path], *, name: Optional[str] = None) -> Attachment:
        """Upload one file (max 25 MB) to attach to a message."""
        path = Path(file)
        d = self._sai._http.json(
            "POST",
            "/v1/agents/upload",
            content=path.read_bytes(),
            headers={"x-filename": urllib.parse.quote(name or path.name)},
            timeout=120,
        )
        return Attachment.parse(d)


class _Account:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def get(self) -> Account:
        """Plan and spendable credit. Slow-ish (billing lookup): not for a poll loop."""
        return Account.parse(self._sai._http.json("GET", "/v1/agents/account"))
