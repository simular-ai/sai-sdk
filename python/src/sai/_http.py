from __future__ import annotations

from typing import Any, Optional

import httpx

from ._errors import ConnectionError, SaiError, error_for
from ._version import __version__

DEFAULT_BASE_URL = "https://api.simular.ai"


class HTTP:
    """The one place requests are made: auth header, error mapping, timeouts."""

    def __init__(
        self,
        api_key: str,
        base_url: str,
        *,
        timeout: float,
        version_tag: Optional[str],
        transport: Optional[httpx.BaseTransport],
    ) -> None:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "User-Agent": f"sai-python/{__version__}",
        }
        if version_tag:
            # cloud-api preview revisions answer on this tag (a PR's staging preview).
            headers["x-sai-version"] = version_tag
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"), headers=headers, timeout=timeout, transport=transport
        )

    def close(self) -> None:
        self._client.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Optional[dict[str, Any]] = None,
        content: Optional[bytes] = None,
        headers: Optional[dict[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> httpx.Response:
        kwargs: dict[str, Any] = {}
        if timeout is not None:
            kwargs["timeout"] = timeout
        try:
            res = self._client.request(
                method, path, json=json, params=params, content=content, headers=headers, **kwargs
            )
        except httpx.TimeoutException as e:
            raise ConnectionError(f"Request to {self._client.base_url.host} timed out.") from e
        except httpx.TransportError as e:
            raise ConnectionError(
                f"Could not reach the Sai API at {self._client.base_url.host}: {e}. "
                "Check the network and SAI_API_URL."
            ) from e
        if res.status_code >= 400:
            raise _to_error(res)
        return res

    def json(self, method: str, path: str, **kwargs: Any) -> Any:
        res = self.request(method, path, **kwargs)
        if res.status_code == 204 or not res.content:
            return None
        return res.json()


def _to_error(res: httpx.Response) -> SaiError:
    try:
        body = res.json()
        if not isinstance(body, dict):
            body = {"error": str(body)}
    except ValueError:
        body = {"error": res.text[:500] or res.reason_phrase}
    retry_after: Optional[float] = None
    raw = res.headers.get("retry-after")
    if raw:
        try:
            retry_after = float(raw)
        except ValueError:
            retry_after = None
    return error_for(res.status_code, body, retry_after)
