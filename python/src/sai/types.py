"""Response objects. Each keeps the server's JSON in `raw`, so a field the SDK
does not model yet is still reachable."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class Account:
    user_id: str
    plan_id: Optional[str]
    plan_title: str
    free: bool
    unlimited: bool
    credits_usd: Optional[float]
    """Spendable credit in USD; None on the unlimited plan or when billing could not be reached."""
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> Account:
        plan = d.get("plan") or {}
        credits = d.get("credits") or {}
        return cls(
            user_id=d.get("userId", ""),
            plan_id=plan.get("id"),
            plan_title=plan.get("title", ""),
            free=bool(plan.get("free")),
            unlimited=bool(plan.get("unlimited")),
            credits_usd=credits.get("usd"),
            raw=d,
        )


@dataclass
class Model:
    id: str
    name: str
    provider: str
    tier: str
    cost_tier: str
    allowed: bool
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> Model:
        return cls(
            id=d["id"],
            name=d.get("name", d["id"]),
            provider=d.get("provider", ""),
            tier=d.get("tier", ""),
            cost_tier=d.get("costTier", ""),
            allowed=bool(d.get("allowed", True)),
            raw=d,
        )


@dataclass
class Attachment:
    """A file uploaded with `sai.files.upload()`. Pass it in `attachments=`."""

    file_id: str
    name: str
    mime: str
    size: int
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> Attachment:
        return cls(
            file_id=d.get("fileId", ""),
            name=d.get("name", ""),
            mime=d.get("mime", ""),
            size=int(d.get("size", 0)),
            raw=d,
        )


@dataclass
class LiveView:
    """A view-only Guacamole stream of a computer's screen. The URL carries a token: keep it private."""

    machine_id: str
    websocket_url: str = field(repr=False)
    width: int
    height: int


@dataclass
class Approval:
    """Sai is waiting for permission (or for an answer to a choice question)."""

    id: str
    title: str
    description: str
    type: str
    """`exec`, `choice`, ... ; a `choice` needs `selections` when approved."""
    is_link_only: bool
    """True: a human must answer in a browser at `url`; the API cannot."""
    url: Optional[str]
    command: Optional[str]
    questions: list[dict[str, Any]]
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> Approval:
        return cls(
            id=d["approvalId"],
            title=d.get("title", ""),
            description=d.get("description", ""),
            type=d.get("approvalType", ""),
            is_link_only=bool(d.get("isLinkOnly")),
            url=d.get("approvalUrl"),
            command=d.get("command"),
            questions=d.get("questions") or [],
            raw=d,
        )


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cost_usd: float = 0.0
    model_calls: int = 0
    by_model: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def parse(cls, d: Optional[dict[str, Any]]) -> Optional[Usage]:
        if not d:
            return None
        return cls(
            input_tokens=d.get("inputTokens", 0),
            output_tokens=d.get("outputTokens", 0),
            cache_read_tokens=d.get("cacheReadTokens", 0),
            cache_write_tokens=d.get("cacheWriteTokens", 0),
            cost_usd=d.get("costUsd", 0.0),
            model_calls=d.get("modelCalls", 0),
            by_model=d.get("byModel") or {},
        )


# Wire event type → SDK kind. Anything not listed is framing or internal detail,
# and is yielded only with `events(raw=True)`.
_KINDS = {
    "data-progress": "step",
    "text-delta": "message",
    "data-approval-request": "approval",
    "tool-output-error": "tool_error",
    "error": "error",
    "finish": "finished",
}


@dataclass
class Event:
    """One thing that happened in a turn.

    `kind` is the SDK's name: `step` (a progress line), `message` (Sai's text),
    `approval`, `tool_error`, `error`, `finished`; with `events(raw=True)` also
    `other` for framing, reasoning and tool-call frames. `type` is the wire type.
    """

    kind: str
    type: str
    text: Optional[str]
    approval: Optional[Approval]
    code: Optional[str]
    """`insufficient_credits` / `free_computer_time_exhausted` on errors: stop retrying today."""
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> Event:
        t = d.get("type", "")
        data = d.get("data") or {}
        text: Optional[str] = None
        approval: Optional[Approval] = None
        if t == "data-progress":
            text = data.get("text")
        elif t in ("text-delta", "reasoning-delta"):
            text = d.get("delta")
        elif t in ("tool-output-error", "error"):
            text = d.get("errorText")
        elif t == "data-approval-request" and data.get("approvalId"):
            approval = Approval.parse(data)
            text = approval.title
        return cls(
            kind=_KINDS.get(t, "other"),
            type=t,
            text=text,
            approval=approval,
            code=d.get("code"),
            raw=d,
        )


@dataclass
class TurnResult:
    """Where a turn stopped.

    `status` is `idle` (done: `text` is the answer), `error`, or
    `needs_approval` (waiting on `approval`; answer it and call `wait()` again).
    """

    status: str
    text: str
    session_id: str
    approval: Optional[Approval]
    error: Optional[str]
    error_code: Optional[str]
    usage: Optional[Usage]
    session_usage: Optional[Usage] = field(default=None, repr=False)

    @property
    def ok(self) -> bool:
        return self.status == "idle"


@dataclass
class ExecError:
    kind: str
    """`exception`, `timeout` or `interrupted`."""
    message: str
    stack: Optional[str] = None


@dataclass
class ExecResult:
    """What one Simulang block returned. A block that threw is still a result: check `error`."""

    result: Any
    logs: list[str]
    error: Optional[ExecError]
    screenshot_png: Optional[bytes] = field(repr=False)
    """The screenshot the block captured (page/app snapshot, pageContent), decoded."""
    screenshot_omitted: bool
    variables: list[dict[str, Any]] = field(repr=False)
    duration_ms: int
    raw: dict[str, Any] = field(repr=False)

    @property
    def ok(self) -> bool:
        return self.error is None

    @classmethod
    def parse(cls, d: dict[str, Any]) -> ExecResult:
        obs = d.get("observations") or {}
        shot = obs.get("screenshot")
        err = d.get("error")
        return cls(
            result=d.get("result"),
            logs=d.get("logs") or [],
            error=ExecError(err.get("kind", ""), err.get("message", ""), err.get("stack")) if err else None,
            screenshot_png=base64.b64decode(shot["base64"]) if shot and shot.get("base64") else None,
            screenshot_omitted=bool(obs.get("screenshotOmitted")),
            variables=d.get("variables") or [],
            duration_ms=int(d.get("durationMs", 0)),
            raw=d,
        )
