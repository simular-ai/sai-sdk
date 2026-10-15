"""Learn and judge (research preview): turn recorded turns into Simulang code you own, repair that
code, and judge turns against criteria you choose now.

Maps to `/v1/agents/learn` and `/v1/agents/judge`.
"""

from __future__ import annotations

import urllib.parse
from typing import TYPE_CHECKING, Any, Optional, Sequence, Union

from .turns import TurnRef, _id
from .types import Check, Evaluation, Judgement, LearnResult

if TYPE_CHECKING:
    from ._client import Sai

LEARN_TIMEOUT = 600.0
"""A conversion is two model calls of up to a minute or two each, plus one retry."""
JUDGE_TIMEOUT = 180.0


class Learn:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def create(
        self,
        turns: Sequence[TurnRef] = (),
        *,
        template: Optional[str] = None,
        initial_code: Optional[str] = None,
        evaluations: Optional[Sequence[Evaluation]] = None,
        feedback: Optional[str] = None,
        model: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        timeout: float = LEARN_TIMEOUT,
    ) -> LearnResult:
        """Make Simulang code from `turns` (ordered, one session, each sent with
        `record_trajectory`), or, with `initial_code`, repair it from `evaluations`,
        `feedback` or new `turns`. Waits for the result (about two minutes). A result
        with `validation["errors"]` comes back `failed`.

        `template` (`"Submit claim for {{patient}} to {{payer}}"`) defaults to the first
        turn's template, else it is inferred. `model` defaults to `anthropic/claude-opus-5-5`.
        """
        body: dict[str, Any] = {"turns": [_id(t) for t in turns]}
        if template is not None:
            body["template"] = template
        if initial_code is not None:
            body["initialCode"] = initial_code
        if evaluations:
            body["evaluations"] = [e.to_json() for e in evaluations]
        if feedback is not None:
            body["feedback"] = feedback
        if model is not None:
            body["model"] = model
        if idempotency_key is not None:
            body["idempotency_key"] = idempotency_key
        return LearnResult.parse(self._sai._http.json("POST", "/v1/agents/learn", json=body, timeout=timeout))

    def get(self, learn_id: str) -> LearnResult:
        """A learn call's result, e.g. after the request timed out on your side."""
        return LearnResult.parse(
            self._sai._http.json("GET", f"/v1/agents/learn/{urllib.parse.quote(learn_id, safe='')}")
        )


class Judge:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def create(
        self,
        turns: Sequence[TurnRef],
        criteria: Union[str, Sequence[Check]],
        *,
        task: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        timeout: float = JUDGE_TIMEOUT,
    ) -> Judgement:
        """Judge recorded `turns` (one session, as one task) against `criteria`: a
        sentence for a model to judge, or a list of `Check`s. Nothing runs again, and
        the turns do not change. `task` defaults to the first turn's message."""
        body: dict[str, Any] = {
            "turns": [_id(t) for t in turns],
            "criteria": criteria if isinstance(criteria, str) else [c.to_json() for c in criteria],
        }
        if task is not None:
            body["task"] = task
        if idempotency_key is not None:
            body["idempotency_key"] = idempotency_key
        return Judgement.parse(self._sai._http.json("POST", "/v1/agents/judge", json=body, timeout=timeout))

    def get(self, judgement_id: str) -> Judgement:
        return Judgement.parse(
            self._sai._http.json("GET", f"/v1/agents/judge/{urllib.parse.quote(judgement_id, safe='')}")
        )
