"""Sessions: a conversation with Sai on one computer. Sai decides every click.

Maps to `/v1/agents/*` today: `new-session`, `message` (wait=false), `events`,
`approve`, `abort`. The contract (docs/plans/2026-10-08-developer-api-contract.md)
moves these to `/v1/sessions/{id}/...`; the SDK surface stays the same.
"""

from __future__ import annotations

import time
from collections.abc import Iterator, Sequence
from typing import TYPE_CHECKING, Any, Callable, Optional, Union

from ._errors import ConflictError, LinkOnlyApprovalError, NotFoundError, RateLimitError
from .types import Approval, Attachment, Event, TurnResult, Usage

if TYPE_CHECKING:
    from ._client import Sai
    from .machines import Machine

MachineRef = Union["Machine", str, None]

# `on_approval` may answer with a response string, (response, selections), or
# None to leave the approval pending (e.g. a human answers it in a browser).
ApprovalAnswer = Union[str, tuple[str, list[list[str]]], None]
ApprovalHandler = Callable[[Approval], ApprovalAnswer]

_POLL_WAIT = 30  # seconds the server may hold a poll; it caps at 60


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
    ) -> Turn:
        """Give Sai a task, or steer the running one. Returns at once.

        `model` is an id from `sai.models.list()` (or `auto`); it sticks to the
        session until changed. Sent while a turn is running, the message steers
        that turn (`turn.queued` is True) instead of starting a new one.
        """
        body: dict[str, Any] = {"message": message, "wait": False}
        if self.machine_id:
            body["machineId"] = self.machine_id
        if model:
            body["model"] = model
        if attachments:
            body["attachments"] = [a.raw for a in attachments]
        d = self._sai._http.json("POST", "/v1/agents/message", json=body)
        if not d.get("sessionId"):
            # Handled without starting a task (e.g. a plain acknowledgement): the reply is in `error`.
            return Turn(self, done=_result(self.id or "", "idle", d.get("error", "")))
        self.id = d["sessionId"]
        self.machine_id = d.get("machineId", self.machine_id)
        return Turn(self, queued=bool(d.get("queued")))

    def run(
        self,
        message: str,
        *,
        model: Optional[str] = None,
        attachments: Sequence[Attachment] = (),
        on_approval: Optional[ApprovalHandler] = None,
        timeout: Optional[float] = None,
    ) -> TurnResult:
        """`send()` then `wait()`: the answer, or where it stopped."""
        return self.send(message, model=model, attachments=attachments).wait(
            on_approval=on_approval, timeout=timeout
        )

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
    """One message's work. Iterate `events()` to watch it, or `wait()` for the result."""

    def __init__(self, session: Session, *, queued: bool = False, done: Optional[TurnResult] = None) -> None:
        self.session = session
        self.queued = queued
        self._cursor: Optional[str] = None
        self._result = done
        # answered without starting a task: nothing to poll
        self._local = done is not None

    def __repr__(self) -> str:
        return f"Turn(session_id={self.session.id!r}, status={self.status!r})"

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
        `timeout` (seconds) raises `TimeoutError` with the turn still running.
        """
        if self._local:
            return self._result  # type: ignore[return-value]
        deadline = None if timeout is None else time.monotonic() + timeout
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


def _result(session_id: str, status: str, text: str) -> TurnResult:
    return TurnResult(
        status=status, text=text, session_id=session_id, approval=None, error=None, error_code=None, usage=None
    )
