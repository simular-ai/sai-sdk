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
    `run` is the run's result for a structured message (one with a contract).
    """

    status: str
    text: str
    session_id: str
    approval: Optional[Approval]
    error: Optional[str]
    error_code: Optional[str]
    usage: Optional[Usage]
    session_usage: Optional[Usage] = field(default=None, repr=False)
    run: Optional[Run] = None

    @property
    def ok(self) -> bool:
        """Idle, and for a structured message, the run succeeded."""
        return self.status == "idle" and (self.run is None or self.run.ok)


@dataclass
class Check:
    """One yes/no constraint a structured run is checked against after its turn."""

    id: str
    """Letters, digits, `_` or `-`; at most 64 characters."""
    check: str
    return_evidence: bool = False
    """Also return one sentence of evidence for this check (an extra model call)."""

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {"id": self.id, "check": self.check}
        if self.return_evidence:
            d["returnEvidence"] = True
        return d


@dataclass
class Evidence:
    """The verdict on one success criterion."""

    id: Optional[str]
    """The check's id; None for a natural-language `success_criteria`."""
    passed: bool
    score: Optional[float]
    """The probability that the check holds (`Check` criteria only)."""
    evidence: Optional[str]
    """Always for a natural-language criteria; for a `Check`, only with `return_evidence`."""

    @classmethod
    def parse(cls, d: dict[str, Any]) -> Evidence:
        return cls(id=d.get("id"), passed=bool(d.get("passed")), score=d.get("score"), evidence=d.get("evidence"))


RUN_STATUSES = ("running", "needs_input", "finalizing", "succeeded", "failed")


@dataclass
class Run:
    """One message's result, from `GET /v1/runs/{id}`.

    `status` is `running`, `needs_input` (an approval or question is pending),
    `finalizing` (the agent is done; output and checks are being worked out),
    `succeeded` or `failed`. On `failed`, `reason_code` says why: `agent_error`,
    `output_invalid` (see `raw_answer` and `output_errors`), `criteria_not_met`,
    `criteria_unchecked`, `aborted`, `machine_unavailable` or `not_started`.
    """

    id: str
    session_id: Optional[str]
    machine_id: str
    kind: str
    """`plain` or `structured`."""
    status: str
    output: Any
    """Matches `output_schema`; the final text for a plain message."""
    reason_code: Optional[str]
    raw_answer: Optional[str]
    output_errors: list[str]
    evidence: list[Evidence]
    usage: Optional[Usage]
    """Tokens of every model call the agent made in the turn."""
    steer_of: Optional[str]
    """Set when the message joined a turn already running; the result is that run's."""
    record_trajectory: bool
    trajectory_ref: Optional[str]
    template: Optional[str]
    inputs: Optional[dict[str, Any]]
    replayed: bool
    """True when `idempotency_key` matched an earlier run: this is that run, and nothing was sent."""
    raw: dict[str, Any] = field(repr=False)

    @property
    def done(self) -> bool:
        return self.status in ("succeeded", "failed")

    @property
    def ok(self) -> bool:
        return self.status == "succeeded"

    @classmethod
    def parse(cls, d: dict[str, Any]) -> Run:
        return cls(
            id=d.get("runId", ""),
            session_id=d.get("sessionId"),
            machine_id=d.get("machineId", ""),
            kind=d.get("kind", ""),
            status=d.get("status", "running"),
            output=d.get("output"),
            reason_code=d.get("reason_code"),
            raw_answer=d.get("raw_answer"),
            output_errors=d.get("output_errors") or [],
            evidence=[Evidence.parse(e) for e in d.get("evidence") or []],
            usage=Usage.parse(d.get("usage")),
            steer_of=d.get("steerOf"),
            record_trajectory=bool(d.get("recordTrajectory")),
            trajectory_ref=d.get("trajectoryRef"),
            template=d.get("template"),
            inputs=d.get("inputs"),
            replayed=bool(d.get("idempotent_replay")),
            raw=d,
        )


@dataclass
class TrajectoryStep:
    """One step the agent took: what it did, and why. Fetch its screen with `sai.runs.screenshot()`."""

    index: int
    final: bool
    """The screenshot taken when the turn ended, after the last step."""
    timestamp: str
    title: Optional[str]
    code: Optional[str]
    rationale: Optional[str]
    """The agent's text before the action."""
    error: Optional[str]
    has_screenshot: bool
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> TrajectoryStep:
        return cls(
            index=int(d.get("index", 0)),
            final=bool(d.get("final")),
            timestamp=d.get("timestamp", ""),
            title=d.get("title"),
            code=d.get("code"),
            rationale=d.get("rationale"),
            error=d.get("error"),
            has_screenshot=bool(d.get("screenshot")),
            raw=d,
        )


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
