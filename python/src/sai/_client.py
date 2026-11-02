from __future__ import annotations

import os
import urllib.parse
from pathlib import Path
from typing import Callable, Optional, Union

import httpx

from ._http import DEFAULT_BASE_URL, HTTP
from .control import Control
from .machines import Machines
from .sessions import Sessions
from .turns import Turns
from .learn import Judge, Learn
from .tenants import TenantMachines, Tenants
from .types import Account, Attachment, Model
from .usage import Auth, Usage


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
        org_id: Optional[str] = None,
        _token: Optional[Callable[[], str]] = None,
    ) -> None:
        """`org_id` (default `SAI_ORG_ID`) is the Organisation that `tenants.token()`,
        `tenants.client()` and `usage` act on; only an Organisation Key needs it."""
        key = _token or api_key or os.environ.get("SAI_API_KEY")
        if not key:
            raise ValueError("No API key: pass api_key= or set SAI_API_KEY. Create one at https://platform.simular.ai.")
        self._base_url = base_url or os.environ.get("SAI_API_URL") or DEFAULT_BASE_URL
        self._timeout = timeout
        self._version_tag = version_tag
        self._transport = transport
        self._org_id = org_id or os.environ.get("SAI_ORG_ID")
        self._http = HTTP(
            key,
            self._base_url,
            timeout=timeout,
            version_tag=version_tag,
            transport=transport,
        )
        self.machines = Machines(self)
        self.sessions = Sessions(self)
        self.turns = Turns(self)
        self.learn = Learn(self)
        """Recorded turns → Simulang code, and code repair (research preview)."""
        self.judge = Judge(self)
        """Judge recorded turns against new criteria (research preview)."""
        self.control = Control(self)
        self.models = _Models(self)
        self.files = _Files(self)
        self.account = _Account(self)
        self.auth = Auth(self)
        """Who the key acts as."""
        self.usage = Usage(self)
        """What an Organisation is charged, per Tenant and per session. Takes an Organisation Key."""
        self.tenants = Tenants(self)
        """Your customers under an Organisation. Takes an Organisation Key."""
        self.tenant_machines = TenantMachines(self)
        """A Tenant's computers: enrolled, and cloud machines Sai hosts. Takes an Organisation Key."""

    def _with_token(self, token: Callable[[], str]) -> Sai:
        return Sai(
            base_url=self._base_url,
            timeout=self._timeout,
            version_tag=self._version_tag,
            transport=self._transport,
            org_id=self._org_id,
            _token=token,
        )

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
            # The server reads only a body that has a Content-Type; it derives the MIME type from the name.
            headers={
                "Content-Type": "application/octet-stream",
                "x-filename": urllib.parse.quote(name or path.name),
            },
            timeout=120,
        )
        return Attachment.parse(d)


class _Account:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def get(self) -> Account:
        """Plan and spendable credit. Slow-ish (billing lookup): not for a poll loop."""
        return Account.parse(self._sai._http.json("GET", "/v1/agents/account"))
