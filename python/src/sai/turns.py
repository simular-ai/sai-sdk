"""Turns: what a message to Sai started or joined. Every message gets a turn id
(`turn.id`); this reads the turn's record: status, output, evidence, usage, and
its trajectory when the message set `record_trajectory`.

Maps to `/v1/agents/turns/*`.
"""

from __future__ import annotations

import time
import urllib.parse
from typing import TYPE_CHECKING, Optional, Union

from .sessions import Turn, _wait_record
from .types import TrajectoryStep, TurnRecord

if TYPE_CHECKING:
    from ._client import Sai

TurnRef = Union[str, Turn, TurnRecord]


class Turns:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def get(self, turn: TurnRef) -> TurnRecord:
        """The turn's record now. Never waits: `finalizing` while the result is worked out."""
        return TurnRecord.parse(self._sai._http.json("GET", f"/v1/agents/turns/{_quoted(turn)}"))

    def wait(self, turn: TurnRef, *, timeout: Optional[float] = None) -> TurnRecord:
        """Read the turn until it is `succeeded`, `failed` or `needs_input`.

        On `needs_input`, answer the approval on the turn's session
        (`sai.sessions.resume(record.session_id)`) and wait again.
        `timeout` (seconds) raises `TimeoutError` with the turn unfinished.
        """
        deadline = None if timeout is None else time.monotonic() + timeout
        return _wait_record(self._sai, _id(turn), deadline=deadline, stop=("succeeded", "failed", "needs_input"))

    def trajectory(self, turn: TurnRef) -> list[TrajectoryStep]:
        """The steps the agent took, in order. Recorded only when the message set `record_trajectory`."""
        d = self._sai._http.json("GET", f"/v1/agents/turns/{_quoted(turn)}/trajectory")
        return [TrajectoryStep.parse(s) for s in d.get("steps") or []]

    def screenshot(self, turn: TurnRef, index: int) -> bytes:
        """The screen before step `index` (the last one is after the turn), as JPEG bytes."""
        return self._sai._http.request("GET", f"/v1/agents/turns/{_quoted(turn)}/trajectory/screenshots/{index}").content


def _id(turn: TurnRef) -> str:
    turn_id = turn if isinstance(turn, str) else turn.id
    if not turn_id:
        raise ValueError("This turn has no id: the message was answered without starting one.")
    return turn_id


def _quoted(turn: TurnRef) -> str:
    return urllib.parse.quote(_id(turn), safe="")
