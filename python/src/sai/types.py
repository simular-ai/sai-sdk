"""Response objects. Each keeps the server's JSON in `raw`, so a field the SDK
does not model yet is still reachable."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any, Optional, Union


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
    `record` is the turn's record for a structured message (one with `inputs`,
    `output_schema` or `success_criteria`).
    """

    status: str
    text: str
    session_id: str
    approval: Optional[Approval]
    error: Optional[str]
    error_code: Optional[str]
    usage: Optional[Usage]
    session_usage: Optional[Usage] = field(default=None, repr=False)
    record: Optional[TurnRecord] = None

    @property
    def ok(self) -> bool:
        """Idle, and for a structured message, the turn succeeded."""
        return self.status == "idle" and (self.record is None or self.record.ok)


@dataclass
class Check:
    """One yes/no constraint a structured message's turn is checked against after it ends."""

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


TURN_RECORD_STATUSES = ("running", "needs_input", "finalizing", "succeeded", "failed")


@dataclass
class TurnRecord:
    """A turn's record, from `GET /v1/agents/turns/{id}`.

    `status` is `running`, `needs_input` (an approval or question is pending),
    `finalizing` (the agent is done; output and checks are being worked out),
    `succeeded` or `failed`. On `failed`, `reason_code` says why: `agent_error`
    (with `error_code` when known), `machine_unavailable`, `not_started`, and for
    a structured message `output_invalid` (see `raw_answer` and `output_errors`),
    `criteria_not_met` or `criteria_unchecked`.
    """

    id: str
    session_id: Optional[str]
    machine_id: str
    status: str
    output: Any
    """The agent's final text; with `output_schema`, an object matching it."""
    reason_code: Optional[str]
    raw_answer: Optional[str]
    error_code: Optional[str]
    """`insufficient_credits` or `free_computer_time_exhausted`, for a known `agent_error`."""
    output_errors: list[str]
    evidence: list[Evidence]
    """Empty for a plain message."""
    usage: Optional[Usage]
    """Tokens of every model call the agent made in the turn."""
    record_trajectory: bool
    trajectory_recorded: bool
    """At least one step was stored (`sai.turns.trajectory()`)."""
    template: Optional[str]
    inputs: Optional[dict[str, Any]]
    replayed: bool
    """True when `idempotency_key` matched an earlier turn: this is that turn, and nothing was sent."""
    raw: dict[str, Any] = field(repr=False)

    @property
    def done(self) -> bool:
        return self.status in ("succeeded", "failed")

    @property
    def ok(self) -> bool:
        return self.status == "succeeded"

    @classmethod
    def parse(cls, d: dict[str, Any]) -> TurnRecord:
        return cls(
            id=d.get("turnId", ""),
            session_id=d.get("sessionId"),
            machine_id=d.get("machineId", ""),
            status=d.get("status", "running"),
            output=d.get("output"),
            reason_code=d.get("reason_code"),
            raw_answer=d.get("raw_answer"),
            error_code=d.get("error_code"),
            output_errors=d.get("output_errors") or [],
            evidence=[Evidence.parse(e) for e in d.get("evidence") or []],
            usage=Usage.parse(d.get("usage")),
            record_trajectory=bool(d.get("recordTrajectory")),
            trajectory_recorded=bool((d.get("trajectory") or {}).get("recorded")),
            template=d.get("template"),
            inputs=d.get("inputs"),
            replayed=bool(d.get("idempotent_replay")),
            raw=d,
        )


@dataclass
class TrajectoryStep:
    """One step the agent took: what it did, and why. Fetch its screen with `sai.turns.screenshot()`."""

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
    screenshot: Optional[bytes] = field(repr=False)
    """The screenshot the block captured (page/app snapshot, pageContent), decoded."""
    screenshot_omitted: bool
    variables: list[dict[str, Any]] = field(repr=False)
    duration_ms: int
    raw: dict[str, Any] = field(repr=False)
    screenshot_mime_type: Optional[str] = None
    """`image/jpeg` or `image/png`."""

    @property
    def ok(self) -> bool:
        return self.error is None

    @property
    def screenshot_png(self) -> Optional[bytes]:
        """Deprecated: use `screenshot`. Not always PNG; see `screenshot_mime_type`."""
        return self.screenshot

    @classmethod
    def parse(cls, d: dict[str, Any]) -> ExecResult:
        obs = d.get("observations") or {}
        shot = obs.get("screenshot")
        err = d.get("error")
        return cls(
            result=d.get("result"),
            logs=d.get("logs") or [],
            error=ExecError(err.get("kind", ""), err.get("message", ""), err.get("stack")) if err else None,
            screenshot=base64.b64decode(shot["base64"]) if shot and shot.get("base64") else None,
            screenshot_mime_type=shot.get("mimeType") if shot else None,
            screenshot_omitted=bool(obs.get("screenshotOmitted")),
            variables=d.get("variables") or [],
            duration_ms=int(d.get("durationMs", 0)),
            raw=d,
        )


@dataclass
class LearnParameter:
    """One input of learned code: a `{{name}}` in the template and a key of `main`'s `params`."""

    name: str
    default_value: str
    description: Optional[str]


@dataclass
class Evaluation:
    """How learned code did on one run, for `sai.learn.create(..., initial_code=..., evaluations=[...])`."""

    inputs: dict[str, Any]
    result: Optional[ExecResult] = None
    """The run's result from `lease.exec()` / `lease.run()`; its screenshot is not sent."""
    judgement: Optional[Union[Judgement, str]] = None
    """A judgement of the run, or its id."""
    passed: Optional[bool] = None
    note: Optional[str] = None

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {"inputs": self.inputs}
        if self.result is not None:
            r: dict[str, Any] = {"result": self.result.result, "logs": self.result.logs[-30:]}
            if self.result.error:
                r["error"] = {"kind": self.result.error.kind, "message": self.result.error.message}
            d["result"] = r
        if self.judgement is not None:
            d["judgement"] = self.judgement if isinstance(self.judgement, str) else self.judgement.id
        if self.passed is not None:
            d["passed"] = self.passed
        if self.note is not None:
            d["note"] = self.note
        return d


@dataclass
class LearnReset:
    """What a `reset` did before a run or before the agent run."""

    kind: str
    """`code` or `task`."""
    ok: bool
    duration_ms: Optional[float]
    turn_id: Optional[str]
    """A reset task's turn."""
    error: Optional[str]

    @classmethod
    def parse(cls, d: Any) -> Optional[LearnReset]:
        if not isinstance(d, dict):
            return None
        return cls(
            "task" if d.get("kind") == "task" else "code",
            bool(d.get("ok")),
            d.get("durationMs"),
            d.get("turnId"),
            d.get("error"),
        )


@dataclass
class LearnRollout:
    """One run of a version of the code in a learn job.

    `verdict` is `passed`, `failed`, `error` (the run could not be judged) or `stopped` (the job
    stopped during this run; its `stop_reason` says why), and `None` while the run is going."""

    index: int
    verdict: Optional[str]
    reset: Optional[LearnReset]
    error: Optional[str]
    result: Any
    duration_ms: Optional[float]
    judgement_id: Optional[str]
    summary: Optional[str]
    """The judge's summary."""
    continuation_turn_id: Optional[str]
    """With `continue_with_agent`, the agent's turn after this failed run."""
    continuation_timed_out: bool

    @classmethod
    def parse(cls, d: dict[str, Any]) -> LearnRollout:
        return cls(
            index=d.get("index", 0),
            verdict=d.get("verdict"),
            reset=LearnReset.parse(d.get("reset")),
            error=d.get("error"),
            result=d.get("result"),
            duration_ms=d.get("durationMs"),
            judgement_id=d.get("judgementId"),
            summary=d.get("summary"),
            continuation_turn_id=d.get("continuationTurnId"),
            continuation_timed_out=bool(d.get("continuationTimedOut")),
        )


@dataclass
class LearnIteration:
    """One version of the code in a learn job and its runs."""

    index: int
    """1-based."""
    learn_id: Optional[str]
    """The convert or heal record that wrote this version (`sai.learn.get()` reads it)."""
    changes: Optional[str]
    passed: int
    runs: int
    rollouts: list[LearnRollout]

    @classmethod
    def parse(cls, d: dict[str, Any]) -> LearnIteration:
        return cls(
            index=d.get("index", 0),
            learn_id=d.get("learnId"),
            changes=d.get("changes"),
            passed=d.get("passed", 0),
            runs=d.get("runs", 0),
            rollouts=[LearnRollout.parse(r) for r in d.get("rollouts") or []],
        )


@dataclass
class LearnTestResult:
    """How the returned code did when it was run, on `inputs` only.

    `status` is `not_judged` (not run all its runs), `passed` (passed every run) or `failed`."""

    status: str
    passed_runs: int
    required_runs: int
    inputs: Optional[dict[str, Any]]

    @classmethod
    def parse(cls, d: Any) -> Optional[LearnTestResult]:
        if not isinstance(d, dict):
            return None
        return cls(d.get("status", "not_judged"), d.get("passedRuns", 0), d.get("requiredRuns", 0), d.get("inputs"))


@dataclass
class LearnRun:
    """One run of a learn job's code, from `sai.learn.rollout()`."""

    learn_id: str
    iteration: int
    rollout: int
    run: dict[str, Any]
    """What the run returned and logged: `{ result, logs, error, durationMs }`."""
    judgement: Optional[dict[str, Any]]
    """The judge's record of the run, when it was judged."""
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> LearnRun:
        return cls(
            learn_id=d.get("learnId", ""),
            iteration=d.get("iteration", 0),
            rollout=d.get("rollout", 0),
            run=d.get("run") or {},
            judgement=d.get("judgement"),
            raw=d,
        )


@dataclass
class LearnResult:
    """The result of `sai.learn.create()`: Simulang code made from recorded turns or from an
    agent run, a repair of code you sent, or a learn job that runs, judges and repairs the code.
    Run the code with `lease.run(learned, inputs)`. Research preview.

    `status` says whether the call did its work: `running` while a job runs; `failed` when it
    wrote no code (e.g. `validation["errors"]`, or `error` such as `trajectory_not_recorded`);
    `stopped` when a job ended early (see `stop_reason`). How the code did is `test_result`.
    """

    id: str
    mode: str
    """`convert` (code from turns), `heal` (a repair of `initial_code`) or `policyIteration` (a job that runs the code)."""
    status: str
    title: Optional[str]
    template: Optional[str]
    """The task with `{{name}}` placeholders: send it to `session.send()` with `inputs` to run it with the agent."""
    parameters: list[LearnParameter]
    code: str
    """`async function main(params = { ... })`."""
    output_schema: Optional[dict[str, Any]]
    validation: dict[str, list[str]]
    changes: Optional[str]
    """For `heal`: what changed and why."""
    source_turns: list[str]
    usage: Optional[Usage]
    error: Optional[str]
    replayed: bool
    """True when `idempotency_key` matched an earlier call: this is that call's result."""
    raw: dict[str, Any] = field(repr=False)
    stop_reason: Optional[str] = None
    """Why a job ended early, e.g. `cancelled`, `time_limit`, `agent_failed`, `interrupted`."""
    message: Optional[str] = None
    test_result: Optional[LearnTestResult] = None
    """How the returned code did when it was run."""
    progress: Optional[dict[str, Any]] = None
    """While a job runs: `{ step, iteration, rollout }`."""
    agent_turn_id: Optional[str] = None
    """A job's agent run; pass it as `turns` to start again from that run."""
    agent_run_reset: Optional[LearnReset] = None
    agent_judgement: Optional[dict[str, Any]] = None
    """With `judge_initial_agent_run`: `{ judgementId, verdict, summary }`."""
    version: Optional[int] = None
    """Which iteration `code` is from."""
    iterations: list[LearnIteration] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.status == "succeeded"

    @classmethod
    def parse(cls, d: dict[str, Any]) -> LearnResult:
        v = d.get("validation") or {}
        mode = d.get("mode")
        return cls(
            id=d.get("learnId", ""),
            mode=mode if mode in ("heal", "policyIteration") else "convert",
            status=d.get("status", "running"),
            stop_reason=d.get("stopReason"),
            message=d.get("message"),
            test_result=LearnTestResult.parse(d.get("testResult")),
            progress=d.get("progress"),
            agent_turn_id=d.get("agentTurnId"),
            agent_run_reset=LearnReset.parse(d.get("agentRunReset")),
            agent_judgement=d.get("agentJudgement"),
            version=d.get("version"),
            iterations=[LearnIteration.parse(i) for i in d.get("iterations") or []],
            title=d.get("title"),
            template=d.get("template"),
            parameters=[
                LearnParameter(p.get("name", ""), p.get("defaultValue", ""), p.get("description"))
                for p in d.get("parameters") or []
            ],
            code=d.get("code", ""),
            output_schema=d.get("outputSchema"),
            validation={"errors": v.get("errors") or [], "warnings": v.get("warnings") or []},
            changes=d.get("changes"),
            source_turns=d.get("sourceTurns") or [],
            usage=Usage.parse(d.get("usage")),
            error=d.get("error"),
            replayed=bool(d.get("idempotent_replay")),
            raw=d,
        )


@dataclass
class CriterionResult:
    """The verdict on one criterion of a judgement: `passed`, `failed` or `unverifiable`."""

    id: Optional[str]
    """The check's id; None for a natural-language criteria."""
    check: str
    verdict: str
    score: Optional[float]
    evidence: Optional[str]


@dataclass
class Judgement:
    """The result of `sai.judge.create()`. It never changes the turns it judged. Research preview."""

    id: str
    verdict: Optional[str]
    """`passed`, `failed` or `unverifiable`."""
    summary: Optional[str]
    task: Optional[str]
    criteria: list[CriterionResult]
    turns: list[str]
    usage: Optional[Usage]
    replayed: bool
    raw: dict[str, Any] = field(repr=False)

    @property
    def ok(self) -> bool:
        return self.verdict == "passed"

    @classmethod
    def parse(cls, d: dict[str, Any]) -> Judgement:
        return cls(
            id=d.get("judgementId", ""),
            verdict=d.get("verdict"),
            summary=d.get("summary"),
            task=d.get("task"),
            criteria=[
                CriterionResult(c.get("id"), c.get("check", ""), c.get("verdict", "unverifiable"), c.get("score"), c.get("evidence"))
                for c in d.get("criteria") or []
            ],
            turns=d.get("turns") or [],
            usage=Usage.parse(d.get("usage")),
            replayed=bool(d.get("idempotent_replay")),
            raw=d,
        )
