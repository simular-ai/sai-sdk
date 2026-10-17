"""Learn and judge (research preview): turn recorded turns, or a task the agent does first, into
Simulang code you own; repair that code; run, judge and repair it on a machine until it passes
(policy iteration); and judge turns against criteria you choose now.

Maps to `/v1/agents/learn` and `/v1/agents/judge`.
"""

from __future__ import annotations

import time
import urllib.parse
from typing import TYPE_CHECKING, Any, Mapping, Optional, Sequence, Union

from ._errors import RateLimitError
from .turns import TurnRef, _id
from .types import Check, Evaluation, Judgement, LearnResult, LearnRun

if TYPE_CHECKING:
    from ._client import Sai
    from .machines import Machine

LEARN_TIMEOUT = 600.0
"""A conversion is two model calls of up to a minute or two each, plus one retry."""
JUDGE_TIMEOUT = 180.0
LEARN_POLL_INTERVAL = 10.0
"""How often `wait` reads a learn job; a job's steps take tens of seconds to minutes."""


def _learn_id(job: Union[LearnResult, str]) -> str:
    return urllib.parse.quote(job if isinstance(job, str) else job.id, safe="")


class Learn:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def create(
        self,
        turns: Sequence[TurnRef] = (),
        *,
        task_template: Optional[str] = None,
        template: Optional[str] = None,
        inputs: Optional[Mapping[str, Union[str, int, float, bool]]] = None,
        initial_code: Optional[str] = None,
        evaluations: Optional[Sequence[Evaluation]] = None,
        guidance: Optional[str] = None,
        feedback: Optional[str] = None,
        max_iterations: Optional[int] = None,
        rollouts: Optional[int] = None,
        machine: Union[Machine, str, None] = None,
        criteria: Union[str, Sequence[Check], None] = None,
        reset: Optional[Mapping[str, str]] = None,
        judge_initial_agent_run: Optional[bool] = None,
        continue_with_agent: Optional[bool] = None,
        rollout_minutes: Optional[int] = None,
        agent_run_minutes: Optional[int] = None,
        continuation_minutes: Optional[int] = None,
        max_job_minutes: Optional[int] = None,
        model: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        timeout: float = LEARN_TIMEOUT,
    ) -> LearnResult:
        """Make Simulang code, and optionally run, judge and repair it on a machine.

        - `create(turns)`: code from recorded turns (ordered, one session, each sent with
          `record_trajectory`). Answers with the code; a longer task takes longer.
        - `create(initial_code=..., guidance=...)` (or `evaluations`): a repair. Answers with the code.
        - `create(turns, max_iterations=3)` or `create(task_template=..., inputs=..., max_iterations=3)`:
          a job on the machine (from `turns`, or after the agent does the task). Answers at once
          with `status` `running`; read it with `wait()`.

        `task_template` (`"Submit claim for {{patient}} to {{payer}}"`) defaults to the first
        turn's. `guidance` is what you know about the task, for writing and repairing the code.
        `max_iterations` (default 0, only write the code) is how many code versions to run, judge
        and repair; `rollouts` (default 3) the runs per version. `reset` is `{"code": ...}` or
        `{"task": ...}`, run before the agent run and every run. The `*_minutes` are time limits.
        `template` and `feedback` are the old names of `task_template` and `guidance`.
        A result with `validation["errors"]` comes back `failed`.
        """
        body: dict[str, Any] = {"turns": [_id(t) for t in turns]}
        # The old names go out as sent, so code that uses them keeps working with an older API.
        if task_template is not None:
            body["taskTemplate"] = task_template
        elif template is not None:
            body["template"] = template
        if inputs is not None:
            body["inputs"] = dict(inputs)
        if initial_code is not None:
            body["initialCode"] = initial_code
        if evaluations:
            body["evaluations"] = [e.to_json() for e in evaluations]
        if guidance is not None:
            body["guidance"] = guidance
        elif feedback is not None:
            body["feedback"] = feedback
        if machine is not None:
            body["machineId"] = machine if isinstance(machine, str) else machine.id
        if criteria is not None:
            body["criteria"] = criteria if isinstance(criteria, str) else [c.to_json() for c in criteria]
        if reset is not None:
            body["reset"] = dict(reset)
        for key, value in (
            ("maxIterations", max_iterations),
            ("rollouts", rollouts),
            ("judgeInitialAgentRun", judge_initial_agent_run),
            ("continueWithAgent", continue_with_agent),
            ("rolloutMinutes", rollout_minutes),
            ("agentRunMinutes", agent_run_minutes),
            ("continuationMinutes", continuation_minutes),
            ("maxJobMinutes", max_job_minutes),
        ):
            if value is not None:
                body[key] = value
        if model is not None:
            body["model"] = model
        if idempotency_key is not None:
            body["idempotency_key"] = idempotency_key
        return LearnResult.parse(self._sai._http.json("POST", "/v1/agents/learn", json=body, timeout=timeout))

    def get(self, learn_id: str) -> LearnResult:
        """A learn call's result, or a job's progress so far."""
        return LearnResult.parse(
            self._sai._http.json("GET", f"/v1/agents/learn/{urllib.parse.quote(learn_id, safe='')}")
        )

    def wait(
        self,
        job: Union[LearnResult, str],
        *,
        timeout: Optional[float] = None,
        poll_interval: float = LEARN_POLL_INTERVAL,
    ) -> LearnResult:
        """Read a learn job until it ends (`succeeded`, `failed` or `stopped`). `timeout`
        (seconds) raises `TimeoutError` with the job still running; it keeps running."""
        learn_id = job if isinstance(job, str) else job.id
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            try:
                r = self.get(learn_id)
            except RateLimitError as e:
                time.sleep(e.retry_after or 30)
                continue
            if r.status != "running":
                return r
            if deadline is not None and time.monotonic() + poll_interval > deadline:
                raise TimeoutError(f"Learn job {learn_id} is still running.")
            time.sleep(poll_interval)

    def cancel(self, job: Union[LearnResult, str]) -> None:
        """Stop a learn job at once, whatever step it is on. It keeps the last complete results
        and reads `stopped` / `cancelled` once it has ended, normally within seconds."""
        self._sai._http.json("POST", f"/v1/agents/learn/{_learn_id(job)}/cancel")

    def rollout(self, job: Union[LearnResult, str], iteration: int, rollout: int) -> LearnRun:
        """One run of a learn job's code: what it returned and logged, and its judgement."""
        return LearnRun.parse(
            self._sai._http.json(
                "GET", f"/v1/agents/learn/{_learn_id(job)}/iterations/{iteration}/rollouts/{rollout}"
            )
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
