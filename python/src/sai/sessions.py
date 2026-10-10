"""Sessions: a conversation with Sai on one computer. Sai decides every click.

Maps to `/v1/agents/*`: `new-session`, `message` (wait=false), `events`,
`approve`, `abort`. Every message is a run (`/v1/runs`); a message with a
contract (inputs, output schema, success criteria) is a structured run.
"""

from __future__ import annotations

import time
import urllib.parse
from collections.abc import Iterator, Sequence
from typing import TYPE_CHECKING, Any, Callable, Optional, Union

from ._errors import ConflictError, LinkOnlyApprovalError, NotFoundError, RateLimitError
from .types import Approval, Attachment, Check, Event, Run, TurnResult, Usage

if TYPE_CHECKING:
    from ._client import Sai
    from .machines import Machine

MachineRef = Union["Machine", str, None]

# `on_approval` may answer with a response string, (response, selections), or
# None to leave the approval pending (e.g. a human answers it in a browser).
ApprovalAnswer = Union[str, tuple[str, list[list[str]]], None]
ApprovalHandler = Callable[[Approval], ApprovalAnswer]

_POLL_WAIT = 30  # seconds the server may hold a poll; it caps at 60
_RUN_POLL_INTERVAL = 2  # seconds between run reads; GET /v1/runs/{id} never holds

Inputs = dict[str, Union[str, int, float, bool]]
SuccessCriteria = Union[str, Sequence[Union[Check, dict[str, Any]]]]


class Sessions:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def create(self, machine: MachineRef = None) -> Session:
        """Start a fresh conversation on a computer: the next message has no
        memory of earlier ones. `machine` may be omitted with one computer."""
        machine_id = self._sai.machines._resolve_id(machine)
        try:
            d = self._sai._http.json(
                "POST", "/v1/agents/new-session", json={"machineId": machine_id, "channel": "api"}
            )
            session_id = d.get("sessionId")
        except NotFoundError:
            # A free account's computer between claims has no conversation to
            # rotate; the first message starts one.
            session_id = None
        return Session(self._sai, machine_id, session_id)

    def resume(self, session_id: str, machine: MachineRef = None) -> Session:
        """Reattach to a session started elsewhere, e.g. to poll or abort it."""
        machine_id = self._sai.machines._resolve_id(machine) if machine is not None else None
        return Session(self._sai, machine_id, session_id)


class Session:
    """A conversation with Sai. Each `send()` is a turn; turns share context."""

    def __init__(self, sai: Sai, machine_id: Optional[str], session_id: Optional[str]) -> None:
        self._sai = sai
        self.machine_id = machine_id
        self.id = session_id

    def __repr__(self) -> str:
        return f"Session(id={self.id!r}, machine_id={self.machine_id!r})"

    def send(
        self,
        message: str,
        *,
        model: Optional[str] = None,
        attachments: Sequence[Attachment] = (),
        inputs: Optional[Inputs] = None,
        output_schema: Optional[dict[str, Any]] = None,
        success_criteria: Optional[SuccessCriteria] = None,
        idempotency_key: Optional[str] = None,
        record_trajectory: bool = False,
        keep_lock_at_turn_end: bool = False,
    ) -> Turn:
        """Give Sai a task, or steer the running one. Returns at once.

        `model` is an id from `sai.models.list()` (or `auto`); it sticks to the
        session until changed. Sent while a turn is running, the message steers
        that turn (`turn.queued` is True) instead of starting a new one.

        Any of `inputs`, `output_schema`, `success_criteria` or `idempotency_key`
        makes the message a structured run: `message` is a template whose
        `{{name}}` placeholders are filled from `inputs`, the output must match
        `output_schema` (JSON Schema, at most 32 KB), and the turn is checked
        against `success_criteria` (a guideline for a judge, or a list of `Check`).
        `wait()` then also returns the run's result in `result.run`. A structured
        run is refused with `ConflictError` (`session_busy`) while a turn is running.
        The same `idempotency_key` again returns the earlier run and sends nothing.
        `record_trajectory` keeps a screenshot and the action for each step
        (`sai.runs.trajectory()`). `keep_lock_at_turn_end` applies to `sai.runs.create()`.
        """
        body: dict[str, Any] = {"message": message, "wait": False}
        if self.machine_id:
            body["machineId"] = self.machine_id
        if self.id:
            body["sessionId"] = self.id
        if model:
            body["model"] = model
        if attachments:
            body["attachments"] = [a.raw for a in attachments]
        if inputs is not None:
            body["inputs"] = inputs
        if output_schema is not None:
            body["output_schema"] = output_schema
        if success_criteria is not None:
            body["success_criteria"] = (
                success_criteria
                if isinstance(success_criteria, str)
                else [c.to_json() if isinstance(c, Check) else c for c in success_criteria]
            )
        if idempotency_key is not None:
            body["idempotency_key"] = idempotency_key
        if record_trajectory:
            body["recordTrajectory"] = True
        if keep_lock_at_turn_end:
            body["keepLockAtTurnEnd"] = True
        structured = any(v is not None for v in (inputs, output_schema, success_criteria, idempotency_key))
        d = self._sai._http.json("POST", "/v1/agents/message", json=body)
        if d.get("idempotent_replay"):
            # The key was used before: this is that run, and nothing was sent.
            run = Run.parse(d)
            self.id = run.session_id or self.id
            self.machine_id = run.machine_id or self.machine_id
            return Turn(self, run_id=run.id, structured=True, replay=run)
        if not d.get("sessionId"):
            # Handled without starting a task (e.g. a plain acknowledgement): the reply is in `error`.
            return Turn(self, done=_result(self.id or "", "idle", d.get("error", "")))
        self.id = d["sessionId"]
        self.machine_id = d.get("machineId", self.machine_id)
        return Turn(self, queued=bool(d.get("queued")), run_id=d.get("runId"), structured=structured)

    def run(
        self,
        message: str,
        *,
        model: Optional[str] = None,
        attachments: Sequence[Attachment] = (),
        inputs: Optional[Inputs] = None,
        output_schema: Optional[dict[str, Any]] = None,
        success_criteria: Optional[SuccessCriteria] = None,
        idempotency_key: Optional[str] = None,
        record_trajectory: bool = False,
        keep_lock_at_turn_end: bool = False,
        on_approval: Optional[ApprovalHandler] = None,
        timeout: Optional[float] = None,
    ) -> TurnResult:
        """`send()` then `wait()`: the answer, or where it stopped."""
        return self.send(
            message,
            model=model,
            attachments=attachments,
            inputs=inputs,
            output_schema=output_schema,
            success_criteria=success_criteria,
            idempotency_key=idempotency_key,
            record_trajectory=record_trajectory,
            keep_lock_at_turn_end=keep_lock_at_turn_end,
        ).wait(on_approval=on_approval, timeout=timeout)

    def abort(self) -> bool:
        """Stop the running turn. Pending approvals are denied. False if nothing was running."""
        if not self.id:
            return False
        d = self._sai._http.json("POST", "/v1/agents/abort", json={"sessionId": self.id})
        return bool(d.get("aborted"))

    def respond(
        self,
        approval: Union[Approval, str],
        response: str = "yes",
        *,
        selections: Optional[list[list[str]]] = None,
    ) -> str:
        """Answer an approval: `yes`, `no`, or `task` (allow for the rest of the task).

        A `choice` approval needs `selections`, one list of option values per question.
        Raises `LinkOnlyApprovalError` (with `.approval_url`) when only a browser can answer it.
        Returns `approved`, `approved_task` or `denied`.
        """
        if isinstance(approval, Approval) and approval.is_link_only:
            raise LinkOnlyApprovalError(
                "This approval must be completed in a browser. Open approval.url.",
                status=409,
                code="link_only",
                body={"approvalUrl": approval.url},
            )
        approval_id = approval.id if isinstance(approval, Approval) else approval
        body: dict[str, Any] = {"approvalId": approval_id, "response": response}
        if selections is not None:
            body["selections"] = selections
        d = self._sai._http.json("POST", "/v1/agents/approve", json=body)
        return d.get("status", "")


class Turn:
    """One message's work (a run). Iterate `events()` to watch it, or `wait()` for the result.

    `run_id` names the run (`sai.runs.get(turn.run_id)`); None when the
    message was answered without starting a task.
    """

    def __init__(
        self,
        session: Session,
        *,
        queued: bool = False,
        done: Optional[TurnResult] = None,
        run_id: Optional[str] = None,
        structured: bool = False,
        replay: Optional[Run] = None,
    ) -> None:
        self.session = session
        self.queued = queued
        self.run_id = run_id
        self._structured = structured
        self._replay = replay
        self._cursor: Optional[str] = None
        self._result = done
        # answered without starting a task, or an idempotent replay: no events to poll
        self._local = done is not None or replay is not None

    def __repr__(self) -> str:
        return f"Turn(session_id={self.session.id!r}, run_id={self.run_id!r}, status={self.status!r})"

    @property
    def status(self) -> str:
        return self._result.status if self._result else "running"

    @property
    def result(self) -> Optional[TurnResult]:
        """The last known state, or None before the first poll."""
        return self._result

    def events(self, *, raw: bool = False, poll_wait: int = _POLL_WAIT) -> Iterator[Event]:
        """Yield events until the turn is idle or errors.

        It keeps going through `needs_approval`: answer with
        `turn.respond(ev.approval, ...)` from inside the loop, or let a human
        answer a link-only approval in a browser. Without `raw`, framing,
        reasoning and tool-call frames are skipped.
        """
        if self._local:
            return
        while True:
            page = self._poll(poll_wait)
            for e in page.get("events") or []:
                ev = Event.parse(e)
                if raw or ev.kind != "other":
                    yield ev
            if page.get("status") in ("idle", "error"):
                return

    def wait(
        self,
        *,
        on_approval: Optional[ApprovalHandler] = None,
        timeout: Optional[float] = None,
        poll_wait: int = _POLL_WAIT,
    ) -> TurnResult:
        """Block until the turn is done, or stops on an approval nobody answered.

        Without `on_approval`, returns with `status == "needs_approval"` and the
        `approval` so the caller can decide. With it, the handler's answer is
        sent and waiting continues; a handler returning None leaves the approval
        to someone else (a link-only one to a human) and keeps waiting.
        For a structured message, it then waits for the run's result
        (`result.run`: output, evidence), which is worked out after the turn.
        `timeout` (seconds) raises `TimeoutError` with the turn still running.
        """
        deadline = None if timeout is None else time.monotonic() + timeout
        if self._replay is not None:
            run = self._replay
            if not run.done:
                run = _wait_run(self.session._sai, run.id, deadline=deadline)
            self._result = _result(run.session_id or self.session.id or "", "idle", "")
            self._result.run = run
            return self._result
        if self._local:
            return self._result  # type: ignore[return-value]
        answered: set[str] = set()
        while True:
            if deadline is not None:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError(f"Turn still {self.status} after {timeout}s (session {self.session.id}).")
                poll_wait = max(1, min(poll_wait, int(left)))
            page = self._poll(poll_wait)
            status = page.get("status")
            if status in ("idle", "error"):
                if self._structured and self.run_id:
                    self._result.run = _wait_run(  # type: ignore[union-attr]
                        self.session._sai, self.run_id, deadline=deadline
                    )
                return self._result  # type: ignore[return-value]
            if status == "needs_approval" and self._result and self._result.approval:
                approval = self._result.approval
                if on_approval is None:
                    return self._result
                if approval.id in answered:
                    continue
                answer = on_approval(approval)
                if answer is None:
                    answered.add(approval.id)
                    continue
                response, selections = (answer, None) if isinstance(answer, str) else answer
                try:
                    self.session.respond(approval, response, selections=selections)
                except ConflictError:
                    pass  # answered elsewhere or expired; the next poll shows the new state
                answered.add(approval.id)

    def respond(
        self,
        approval: Union[Approval, str],
        response: str = "yes",
        *,
        selections: Optional[list[list[str]]] = None,
    ) -> str:
        return self.session.respond(approval, response, selections=selections)

    def abort(self) -> bool:
        return self.session.abort()

    def _poll(self, wait: int) -> dict[str, Any]:
        params: dict[str, Any] = {"sessionId": self.session.id, "wait": wait}
        if self._cursor:
            params["since"] = self._cursor
        while True:
            try:
                page = self.session._sai._http.json(
                    "GET", "/v1/agents/events", params=params, timeout=wait + 30
                )
                break
            except RateLimitError as e:
                time.sleep(e.retry_after or 30)
        self._cursor = page.get("cursor") or self._cursor
        error_text: Optional[str] = None
        error_code: Optional[str] = None
        for e in page.get("events") or []:
            if e.get("type") == "error":
                error_text, error_code = e.get("errorText"), e.get("code")
        approval = Approval.parse(page["approval"]) if page.get("approval") else None
        self._result = TurnResult(
            status=page.get("status", "running"),
            text=page.get("text", ""),
            session_id=page.get("sessionId", self.session.id or ""),
            approval=approval,
            error=error_text or (self._result.error if self._result else None),
            error_code=error_code or (self._result.error_code if self._result else None),
            usage=Usage.parse(page.get("usage")),
            session_usage=Usage.parse(page.get("sessionUsage")),
        )
        return page


def _wait_run(
    sai: Sai, run_id: str, *, deadline: Optional[float], stop: tuple[str, ...] = ("succeeded", "failed")
) -> Run:
    """Read the run until its status is in `stop`; `TimeoutError` past `deadline` (monotonic)."""
    while True:
        try:
            run = Run.parse(sai._http.json("GET", f"/v1/runs/{urllib.parse.quote(run_id, safe='')}"))
        except RateLimitError as e:
            time.sleep(e.retry_after or 30)
            continue
        if run.status in stop:
            return run
        if deadline is not None and time.monotonic() + _RUN_POLL_INTERVAL > deadline:
            raise TimeoutError(f"Run {run_id} still {run.status}.")
        time.sleep(_RUN_POLL_INTERVAL)


def _result(session_id: str, status: str, text: str) -> TurnResult:
    return TurnResult(
        status=status, text=text, session_id=session_id, approval=None, error=None, error_code=None, usage=None
    )
