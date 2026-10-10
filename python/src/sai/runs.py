"""Runs: one message's result. Every message is a run; a message with a contract
(inputs, output schema, success criteria) is a structured run.

Maps to `POST /v1/agents/message` (without a session) and `/v1/runs/*`.
"""

from __future__ import annotations

import time
import urllib.parse
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any, Optional, Union

from .sessions import Inputs, Session, SuccessCriteria, Turn, _wait_run
from .types import Attachment, Run, TrajectoryStep

if TYPE_CHECKING:
    from ._client import Sai
    from .machines import Machine

RunRef = Union[Run, str]


class Runs:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def create(
        self,
        message: str,
        *,
        machine: Union[Machine, str, None] = None,
        model: Optional[str] = None,
        attachments: Sequence[Attachment] = (),
        inputs: Optional[Inputs] = None,
        output_schema: Optional[dict[str, Any]] = None,
        success_criteria: Optional[SuccessCriteria] = None,
        idempotency_key: Optional[str] = None,
        record_trajectory: bool = False,
        keep_lock_at_turn_end: bool = False,
    ) -> Turn:
        """Send a message without a session. A structured run opens a session of
        its own, so its result does not depend on earlier conversations, and
        gives the machine back when its turn ends unless `keep_lock_at_turn_end`.
        A plain message goes to the machine's API conversation. `turn.session`
        continues the run's session. Fields as on `Session.send()`.
        """
        session = Session(self._sai, self._sai.machines._resolve_id(machine), None)
        return session.send(
            message,
            model=model,
            attachments=attachments,
            inputs=inputs,
            output_schema=output_schema,
            success_criteria=success_criteria,
            idempotency_key=idempotency_key,
            record_trajectory=record_trajectory,
            keep_lock_at_turn_end=keep_lock_at_turn_end,
        )

    def get(self, run: RunRef) -> Run:
        """The run's status and, once done, its output, reason code, evidence and usage."""
        return Run.parse(self._sai._http.json("GET", f"/v1/runs/{_id(run)}"))

    def wait(self, run: RunRef, *, timeout: Optional[float] = None) -> Run:
        """Read the run until it is `succeeded`, `failed` or `needs_input`.

        On `needs_input`, answer the approval on the run's session
        (`sai.sessions.resume(run.session_id)`) and wait again.
        `timeout` (seconds) raises `TimeoutError` with the run unfinished.
        """
        deadline = None if timeout is None else time.monotonic() + timeout
        run_id = run.id if isinstance(run, Run) else run
        return _wait_run(self._sai, run_id, deadline=deadline, stop=("succeeded", "failed", "needs_input"))

    def trajectory(self, run: RunRef) -> list[TrajectoryStep]:
        """The steps the agent took, in order. Recorded only when the message set `record_trajectory`."""
        d = self._sai._http.json("GET", f"/v1/runs/{_id(run)}/trajectory")
        return [TrajectoryStep.parse(s) for s in d.get("steps") or []]

    def screenshot(self, run: RunRef, index: int) -> bytes:
        """The screen before step `index` (the last one is after the turn), as JPEG bytes."""
        return self._sai._http.request("GET", f"/v1/runs/{_id(run)}/trajectory/screenshots/{index}").content


def _id(run: RunRef) -> str:
    return urllib.parse.quote(run.id if isinstance(run, Run) else run, safe="")
