from __future__ import annotations

from typing import Any, Optional


class SaiError(Exception):
    """A non-2xx response from the Sai API.

    `code` is the machine-readable `error` string when the server sent one
    (`machine_busy`, `link_only`, `insufficient_credits`, ...); `message` is the
    human text. `body` is the parsed JSON body, unchanged.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int = 0,
        code: Optional[str] = None,
        body: Optional[dict[str, Any]] = None,
        retry_after: Optional[float] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.body = body or {}
        self.retry_after = retry_after

    def __repr__(self) -> str:
        return f"{type(self).__name__}(status={self.status}, code={self.code!r}, message={self.message!r})"


class ConnectionError(SaiError):
    """The API could not be reached (DNS, TLS, timeout)."""


class BadRequestError(SaiError):
    """400: the request was invalid, e.g. several computers and no `machine`."""


class AuthenticationError(SaiError):
    """401: no key, or the key is unknown or revoked."""


class PermissionDeniedError(SaiError):
    """403: the key is valid but the account may not do this (plan, ownership)."""


class NotFoundError(SaiError):
    """404."""


class ConflictError(SaiError):
    """409: e.g. `machine_busy`, `link_only`, approval no longer pending."""


class GoneError(SaiError):
    """410 `control_closed`: the control lease has ended. Open a new one.

    `body["reason"]` says why: `closed`, `idle_timeout`, `lock_lost` (a Sai task
    took the computer) or `unresponsive` (the computer stopped answering).
    """


class RateLimitError(SaiError):
    """429: a rate limit, or a free-plan budget that resets daily."""


class ServiceUnavailableError(SaiError):
    """503: the computer did not come online, or no capacity. Honor `retry_after`."""


class BlockError(SaiError):
    """A control helper's Simulang block failed on the computer. `kind` is
    `exception`, `timeout` or `interrupted`."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(f"{kind}: {message}", code=kind)
        self.kind = kind


class LinkOnlyApprovalError(ConflictError):
    """The approval must be answered by a human in a browser: open `approval_url`."""

    @property
    def approval_url(self) -> Optional[str]:
        return self.body.get("approvalUrl")


_BY_STATUS = {
    400: BadRequestError,
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    410: GoneError,
    429: RateLimitError,
    503: ServiceUnavailableError,
}


def error_for(status: int, body: dict[str, Any], retry_after: Optional[float]) -> SaiError:
    err = body.get("error")
    detail = body.get("message")
    # Two body shapes: `{ error: "<human text>" }` (/v1/agents) and
    # `{ error: "<code>", message: "<human text>" }` (/v1/machines/{id}/control, newer errors).
    code = err if isinstance(err, str) and (detail is not None or _looks_like_code(err)) else None
    message = detail if isinstance(detail, str) else (err if isinstance(err, str) else f"HTTP {status}")
    if status == 401:
        message += " (SAI_API_KEY was rejected: it may be revoked.)"
    cls = LinkOnlyApprovalError if code == "link_only" else _BY_STATUS.get(status, SaiError)
    return cls(message, status=status, code=code, body=body, retry_after=retry_after)


def _looks_like_code(s: str) -> bool:
    return bool(s) and " " not in s and s == s.lower()
