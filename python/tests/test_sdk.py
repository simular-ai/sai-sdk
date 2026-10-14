from __future__ import annotations

import base64
import json
from typing import Any, Callable

import httpx
import pytest

from sai import (
    AuthenticationError,
    BadRequestError,
    Check,
    ConflictError,
    GoneError,
    LinkOnlyApprovalError,
    Sai,
)

Handler = Callable[[httpx.Request], httpx.Response]


def client(routes: dict[str, Any], calls: list[httpx.Request] | None = None) -> Sai:
    """`routes` maps "METHOD /path" to a JSON body, a list of bodies (served in
    order), or a function of the request."""
    queues = {k: list(v) if isinstance(v, list) else v for k, v in routes.items()}

    def handle(req: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(req)
        key = f"{req.method} {req.url.path}"
        r = queues.get(key)
        if r is None:
            return httpx.Response(404, json={"error": f"no route {key}"})
        if callable(r):
            return r(req)
        if isinstance(r, list):
            r = r.pop(0) if len(r) > 1 else r[0]
        status, body = r if isinstance(r, tuple) else (200, r)
        return httpx.Response(status, json=body)

    return Sai("sapi_test", base_url="https://api.test", transport=httpx.MockTransport(handle))


MACHINES = {"machines": [{"machineId": "m_1", "name": "Work PC", "kind": "own", "online": True}]}


def test_requires_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SAI_API_KEY", raising=False)
    with pytest.raises(ValueError):
        Sai()


def test_errors_map_status_and_code() -> None:
    sai = client({"GET /v1/agents/machines": (401, {"error": "Invalid API key"})})
    with pytest.raises(AuthenticationError) as e:
        sai.machines.list()
    assert e.value.status == 401

    sai = client({"POST /v1/machines/m_1/control": (409, {"error": "machine_busy", "message": "A task holds it"})})
    with pytest.raises(ConflictError) as c:
        sai.control.open("m_1")
    assert c.value.code == "machine_busy"
    assert c.value.message == "A task holds it"


def test_machine_resolution() -> None:
    sai = client({"GET /v1/agents/machines": MACHINES, "POST /v1/agents/new-session": {"sessionId": "cs_1"}})
    s = sai.sessions.create()
    assert (s.id, s.machine_id) == ("cs_1", "m_1")

    two = {"machines": MACHINES["machines"] + [{"machineId": "m_2"}]}
    sai = client({"GET /v1/agents/machines": two})
    with pytest.raises(BadRequestError, match="m_2"):
        sai.sessions.create()


def test_run_polls_until_idle_with_cursor() -> None:
    calls: list[httpx.Request] = []
    sai = client(
        {
            "POST /v1/agents/new-session": {"sessionId": "cs_1"},
            "POST /v1/agents/message": (202, {"sessionId": "cs_1", "machineId": "m_1", "queued": False}),
            "GET /v1/agents/events": [
                {
                    "sessionId": "cs_1",
                    "status": "running",
                    "events": [
                        {"type": "reasoning-delta", "id": "r", "delta": "thinking"},
                        {"type": "data-progress", "data": {"text": "Opening Notepad", "tool": "execute"}},
                    ],
                    "text": "",
                    "cursor": "c1",
                },
                {
                    "sessionId": "cs_1",
                    "status": "idle",
                    "events": [
                        {"type": "text-delta", "id": "t", "delta": "Saved."},
                        {"type": "finish", "finishReason": "stop"},
                    ],
                    "text": "Saved.",
                    "cursor": "c2",
                    "usage": {"inputTokens": 10, "outputTokens": 2, "costUsd": 0.01, "modelCalls": 1},
                },
            ],
        },
        calls,
    )
    turn = sai.sessions.create("m_1").send("type hello", model="auto")
    kinds = [(e.kind, e.text) for e in turn.events()]
    assert kinds == [("step", "Opening Notepad"), ("message", "Saved."), ("finished", None)]
    assert turn.result is not None and turn.result.ok and turn.result.text == "Saved."
    assert turn.result.usage is not None and turn.result.usage.cost_usd == 0.01

    msg = next(c for c in calls if c.url.path == "/v1/agents/message")
    assert json.loads(msg.content) == {
        "message": "type hello",
        "wait": False,
        "machineId": "m_1",
        "sessionId": "cs_1",
        "model": "auto",
    }
    polls = [c for c in calls if c.url.path == "/v1/agents/events"]
    assert "since" not in polls[0].url.params and polls[1].url.params["since"] == "c1"
    assert all(c.headers["authorization"] == "Bearer sapi_test" for c in calls)


APPROVAL = {
    "approvalId": "ap_1",
    "title": "Command Approval Required",
    "description": "",
    "approvalType": "exec",
    "isLinkOnly": False,
    "command": "del temp",
}


def _waiting(approval: dict[str, Any]) -> dict[str, Any]:
    return {
        "sessionId": "cs_1",
        "status": "needs_approval",
        "events": [{"type": "data-approval-request", "data": approval}],
        "text": "",
        "cursor": "c1",
        "approval": approval,
    }


def test_wait_returns_on_unanswered_approval() -> None:
    sai = client(
        {
            "POST /v1/agents/message": (202, {"sessionId": "cs_1", "machineId": "m_1"}),
            "GET /v1/agents/events": _waiting(APPROVAL),
        }
    )
    result = sai.sessions.resume("cs_1", "m_1").run("clean up")
    assert result.status == "needs_approval"
    assert result.approval is not None and result.approval.command == "del temp"


def test_on_approval_answers_and_continues() -> None:
    calls: list[httpx.Request] = []
    sai = client(
        {
            "POST /v1/agents/message": (202, {"sessionId": "cs_1", "machineId": "m_1"}),
            "GET /v1/agents/events": [
                _waiting(APPROVAL),
                {"sessionId": "cs_1", "status": "idle", "events": [], "text": "Done", "cursor": "c2"},
            ],
            "POST /v1/agents/approve": {"ok": True, "status": "denied"},
        },
        calls,
    )
    result = sai.sessions.resume("cs_1", "m_1").run("clean up", on_approval=lambda a: "no")
    assert result.text == "Done"
    approve = next(c for c in calls if c.url.path == "/v1/agents/approve")
    assert json.loads(approve.content) == {"approvalId": "ap_1", "response": "no"}


def test_link_only_is_refused_locally() -> None:
    sai = client({"GET /v1/agents/events": _waiting({**APPROVAL, "isLinkOnly": True, "approvalUrl": "https://x"})})
    from sai.sessions import Turn

    t = Turn(sai.sessions.resume("cs_1"))
    r = t.wait()
    assert r.approval is not None and r.approval.is_link_only
    with pytest.raises(LinkOnlyApprovalError) as e:
        t.respond(r.approval)
    assert e.value.approval_url == "https://x"


def test_acknowledgement_without_task() -> None:
    sai = client({"POST /v1/agents/message": {"error": "Hi! What should I do?"}})
    turn = sai.sessions.resume("cs_1", "m_1").send("hello")
    assert list(turn.events()) == []
    assert turn.wait().text == "Hi! What should I do?"


def test_error_code_surfaces() -> None:
    sai = client(
        {
            "POST /v1/agents/message": (202, {"sessionId": "cs_1"}),
            "GET /v1/agents/events": {
                "sessionId": "cs_1",
                "status": "error",
                "events": [{"type": "error", "errorText": "out of credit", "code": "insufficient_credits"}],
                "text": "",
                "cursor": "c",
            },
        }
    )
    r = sai.sessions.resume("cs_1").run("x")
    assert (r.status, r.error_code) == ("error", "insufficient_credits")


def test_control_lease_exec_and_close() -> None:
    png = b"\x89PNG fake"
    calls: list[httpx.Request] = []
    sai = client(
        {
            "POST /v1/machines/m_1/control": {"machineId": "m_1", "expiresAfterIdleSec": 600},
            "POST /v1/machines/m_1/control/exec": [
                {"result": {"stdout": "HOST\r\n", "exitCode": 0}, "logs": [], "observations": {}, "variables": [], "durationMs": 5},
                {
                    "result": None,
                    "logs": [],
                    "observations": {"screenshot": {"base64": base64.b64encode(png).decode(), "mimeType": "image/png"}},
                    "variables": [],
                    "durationMs": 9,
                },
                {"logs": [], "error": {"kind": "exception", "message": "boom"}, "observations": {}, "variables": [], "durationMs": 1},
            ],
            "DELETE /v1/machines/m_1/control": lambda req: httpx.Response(204),
        },
        calls,
    )
    with sai.control.open("m_1") as cs:
        assert cs.shell("hostname")["stdout"].strip() == "HOST"
        assert cs.screenshot() == png
        r = cs.exec("throw new Error('boom')")
        assert not r.ok and r.error is not None and r.error.kind == "exception"
    assert calls[-1].method == "DELETE"
    first_exec = next(c for c in calls if c.url.path.endswith("/exec"))
    assert json.loads(first_exec.content)["code"] == 'await machine.exec({"command": "hostname"})'


def test_control_exec_raises_gone_with_reason_when_lease_lost() -> None:
    sai = client(
        {
            "POST /v1/machines/m_1/control": {"machineId": "m_1", "expiresAfterIdleSec": 600},
            "POST /v1/machines/m_1/control/exec": (
                410,
                {
                    "error": "control_closed",
                    "message": "The computer stopped answering, so this control lease was closed.",
                    "reason": "unresponsive",
                },
            ),
            "DELETE /v1/machines/m_1/control": lambda req: httpx.Response(204),
        }
    )
    cs = sai.control.open("m_1")
    with pytest.raises(GoneError) as e:
        cs.exec("1")
    assert e.value.code == "control_closed"
    assert e.value.body["reason"] == "unresponsive"
    cs.close()


def test_upload_sends_raw_body_and_filename() -> None:
    calls: list[httpx.Request] = []
    sai = client(
        {"POST /v1/agents/upload": {"path": "uploads/a b.txt", "name": "a b.txt", "mime": "text/plain", "size": 3, "fileId": "f_1"}},
        calls,
    )
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as d:
        p = Path(d, "a b.txt")
        p.write_text("abc")
        a = sai.files.upload(p)
    assert a.file_id == "f_1" and a.raw["path"] == "uploads/a b.txt"
    assert calls[0].headers["x-filename"] == "a%20b.txt" and calls[0].content == b"abc"


DONE = {
    "turnId": "turn_1",
    "sessionId": "cs_1",
    "machineId": "m_1",
    "status": "succeeded",
    "output": {"path": "C:\\Users\\me\\Desktop\\inv-1001.txt"},
    "reason_code": None,
    "evidence": [{"id": "saved", "passed": True, "score": 0.93, "evidence": "The file is on the Desktop."}],
    "usage": {"inputTokens": 120, "outputTokens": 30},
    "recordTrajectory": True,
    "trajectory": {"recorded": True, "url": "/v1/agents/turns/turn_1/trajectory"},
    "template": "Save {{file_name}}",
    "inputs": {"file_name": "inv-1001.txt"},
}
SCHEMA = {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}


def test_structured_message_sends_options_and_waits_for_the_record(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("sai.sessions._RECORD_POLL_INTERVAL", 0)
    calls: list[httpx.Request] = []
    sai = client(
        {
            "POST /v1/agents/new-session": {"sessionId": "cs_1"},
            "POST /v1/agents/message": (202, {"sessionId": "cs_1", "machineId": "m_1", "queued": False, "turnId": "turn_1"}),
            "GET /v1/agents/events": {"sessionId": "cs_1", "status": "idle", "events": [], "text": "Saved.", "cursor": "c1"},
            "GET /v1/agents/turns/turn_1": [{**DONE, "status": "running"}, {**DONE, "status": "finalizing"}, DONE],
        },
        calls,
    )
    turn = sai.sessions.create("m_1").send(
        "Save {{file_name}}",
        inputs={"file_name": "inv-1001.txt"},
        output_schema=SCHEMA,
        success_criteria=[Check("saved", "The file is saved on the Desktop", return_evidence=True)],
        idempotency_key="inv-1001",
        record_trajectory=True,
    )
    assert turn.id == "turn_1"
    result = turn.wait()
    assert result.ok and result.record is not None
    assert result.record.output == {"path": "C:\\Users\\me\\Desktop\\inv-1001.txt"}
    assert result.record.evidence[0].score == 0.93 and result.record.usage is not None
    assert result.record.usage.input_tokens == 120 and result.record.trajectory_recorded

    body = json.loads(next(c for c in calls if c.url.path == "/v1/agents/message").content)
    assert body["sessionId"] == "cs_1"
    # Everything beyond a plain message goes in `options`.
    assert body["options"] == {
        "inputs": {"file_name": "inv-1001.txt"},
        "output_schema": SCHEMA,
        "success_criteria": [{"id": "saved", "check": "The file is saved on the Desktop", "returnEvidence": True}],
        "idempotency_key": "inv-1001",
        "recordTrajectory": True,
    }
    assert "output_schema" not in body
    assert len([c for c in calls if c.url.path == "/v1/agents/turns/turn_1"]) == 3


def test_failed_structured_turn_is_not_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("sai.sessions._RECORD_POLL_INTERVAL", 0)
    failed = {
        **DONE,
        "status": "failed",
        "output": None,
        "reason_code": "output_invalid",
        "raw_answer": "I saved it.",
        "output_errors": ["must have required property 'path'"],
    }
    sai = client(
        {
            "POST /v1/agents/new-session": {"sessionId": "cs_1"},
            "POST /v1/agents/message": (202, {"sessionId": "cs_1", "machineId": "m_1", "turnId": "turn_1"}),
            "GET /v1/agents/events": {"sessionId": "cs_1", "status": "idle", "events": [], "text": "I saved it."},
            "GET /v1/agents/turns/turn_1": failed,
        }
    )
    result = sai.sessions.create("m_1").run("Save it", output_schema={"type": "object"})
    assert result.status == "idle" and not result.ok
    assert result.record is not None and result.record.reason_code == "output_invalid"
    assert result.record.raw_answer == "I saved it." and result.record.output_errors


def test_plain_message_has_a_turn_id_but_does_not_wait_for_the_record() -> None:
    calls: list[httpx.Request] = []
    sai = client(
        {
            "POST /v1/agents/new-session": {"sessionId": "cs_1"},
            "POST /v1/agents/message": (202, {"sessionId": "cs_1", "machineId": "m_1", "turnId": "turn_2"}),
            "GET /v1/agents/events": {"sessionId": "cs_1", "status": "idle", "events": [], "text": "Done."},
        },
        calls,
    )
    turn = sai.sessions.create("m_1").send("hello")
    assert turn.id == "turn_2"
    assert turn.wait().record is None
    assert not any(c.url.path.startswith("/v1/agents/turns") for c in calls)
    assert "options" not in json.loads(next(c for c in calls if c.url.path == "/v1/agents/message").content)


def test_idempotency_key_alone_keeps_the_message_plain() -> None:
    calls: list[httpx.Request] = []
    sai = client(
        {
            "POST /v1/agents/new-session": {"sessionId": "cs_1"},
            "POST /v1/agents/message": (202, {"sessionId": "cs_1", "machineId": "m_1", "turnId": "turn_3"}),
            "GET /v1/agents/events": {"sessionId": "cs_1", "status": "idle", "events": [], "text": "Done."},
        },
        calls,
    )
    assert sai.sessions.create("m_1").run("hello", idempotency_key="k").record is None
    assert not any(c.url.path.startswith("/v1/agents/turns") for c in calls)


def test_steer_gets_the_id_of_the_turn_it_joined() -> None:
    sai = client(
        {
            "POST /v1/agents/new-session": {"sessionId": "cs_1"},
            "POST /v1/agents/message": (202, {"sessionId": "cs_1", "machineId": "m_1", "queued": True, "turnId": "turn_running"}),
        }
    )
    turn = sai.sessions.create("m_1").send("also this")
    assert turn.queued and turn.id == "turn_running"


def test_idempotent_replay_returns_the_earlier_turn() -> None:
    calls: list[httpx.Request] = []
    sai = client(
        {
            "POST /v1/agents/new-session": {"sessionId": "cs_1"},
            "POST /v1/agents/message": {**DONE, "idempotent_replay": True},
        },
        calls,
    )
    turn = sai.sessions.create("m_1").send("Save {{file_name}}", inputs={"file_name": "x"}, idempotency_key="k")
    assert list(turn.events()) == []
    result = turn.wait()
    assert turn.id == "turn_1"
    assert result.record is not None and result.record.replayed and result.record.id == "turn_1"
    assert [c.url.path for c in calls] == ["/v1/agents/new-session", "/v1/agents/message"]


def test_structured_message_to_a_busy_session_is_a_conflict() -> None:
    sai = client(
        {
            "POST /v1/agents/new-session": {"sessionId": "cs_1"},
            "POST /v1/agents/message": (409, {"error": "session_busy", "message": "The session is still working."}),
        }
    )
    with pytest.raises(ConflictError) as e:
        sai.sessions.create("m_1").send("x", output_schema={"type": "object"})
    assert e.value.code == "session_busy"


def test_turns_get_wait_trajectory_and_screenshot(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("sai.sessions._RECORD_POLL_INTERVAL", 0)
    jpeg = b"\xff\xd8jpeg"

    def shot(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=jpeg, headers={"content-type": "image/jpeg"})

    sai = client(
        {
            "GET /v1/agents/turns/turn_1": [{**DONE, "status": "running"}, {**DONE, "status": "needs_input"}],
            "GET /v1/agents/turns/turn_1/trajectory": {
                "turnId": "turn_1",
                "trajectory": {"recorded": True, "url": "/v1/agents/turns/turn_1/trajectory"},
                "steps": [
                    {"index": 0, "timestamp": "t0", "title": "Open Notepad", "code": "app.open('notepad')",
                     "screenshot": "/v1/agents/turns/turn_1/trajectory/screenshots/0"},
                    {"index": 1, "final": True, "timestamp": "t1", "screenshot": None},
                ],
            },
            "GET /v1/agents/turns/turn_1/trajectory/screenshots/0": shot,
        }
    )
    assert sai.turns.get("turn_1").status == "running"
    assert sai.turns.wait("turn_1").status == "needs_input"
    steps = sai.turns.trajectory("turn_1")
    assert [(s.index, s.title, s.has_screenshot, s.final) for s in steps] == [
        (0, "Open Notepad", True, False),
        (1, None, False, True),
    ]
    assert sai.turns.screenshot("turn_1", 0) == jpeg


LEARNED = {
    "learnId": "learn_1",
    "mode": "convert",
    "status": "succeeded",
    "title": "Read the top story",
    "template": "Open {{site}} and read the top story",
    "parameters": [
        {"name": "site", "defaultValue": "https://news.ycombinator.com"},
        {"name": "n", "defaultValue": "1"},
    ],
    "code": 'async function main(params = { site: "x", n: "1" }) { return params.site }',
    "validation": {"errors": [], "warnings": ["w"]},
    "sourceTurns": ["turn_1"],
    "usage": {"inputTokens": 100, "outputTokens": 20},
}


def test_learn_converts_and_repairs_with_trimmed_evaluations() -> None:
    from sai import Evaluation, ExecError, ExecResult

    calls: list[httpx.Request] = []
    sai = client({"POST /v1/agents/learn": LEARNED, "GET /v1/agents/learn/learn_1": LEARNED}, calls)
    r = sai.learn.create(["turn_1"], template="Open {{site}} and read the top story", idempotency_key="k1")
    assert json.loads(calls[0].content) == {
        "turns": ["turn_1"],
        "template": "Open {{site}} and read the top story",
        "idempotency_key": "k1",
    }
    assert (r.id, r.mode, r.ok, r.source_turns) == ("learn_1", "convert", True, ["turn_1"])
    assert r.parameters[0].default_value == "https://news.ycombinator.com"
    assert r.validation["warnings"] == ["w"]

    logs = [f"line {i}" for i in range(40)]
    result = ExecResult(None, logs, ExecError("exception", "boom", "st"), b"x", False, [], 5, {})
    sai.learn.create(
        initial_code="code",
        evaluations=[Evaluation(inputs={"site": "a"}, result=result, judgement="judgement_1", passed=False)],
    )
    assert json.loads(calls[1].content) == {
        "turns": [],
        "initialCode": "code",
        "evaluations": [
            {
                "inputs": {"site": "a"},
                "result": {"result": None, "logs": logs[-30:], "error": {"kind": "exception", "message": "boom"}},
                "judgement": "judgement_1",
                "passed": False,
            }
        ],
    }
    assert sai.learn.get("learn_1").id == "learn_1"


def test_judge_checks_turns() -> None:
    calls: list[httpx.Request] = []
    sai = client(
        {
            "POST /v1/agents/judge": {
                "judgementId": "judgement_1",
                "verdict": "failed",
                "summary": "0 of 1 checks passed.",
                "criteria": [{"id": "title", "check": "A title", "verdict": "failed", "score": 0.1}],
                "turns": ["turn_1"],
            }
        },
        calls,
    )
    j = sai.judge.create(["turn_1"], [Check("title", "A title")])
    assert json.loads(calls[0].content) == {"turns": ["turn_1"], "criteria": [{"id": "title", "check": "A title"}]}
    assert (j.id, j.verdict, j.ok) == ("judgement_1", "failed", False)
    assert (j.criteria[0].verdict, j.criteria[0].score, j.criteria[0].evidence) == ("failed", 0.1, None)


def test_lease_runs_learned_code_with_inputs_over_defaults() -> None:
    from sai import LearnResult

    calls: list[httpx.Request] = []
    sai = client(
        {
            "POST /v1/machines/m_1/control": {"machineId": "m_1", "expiresAfterIdleSec": 600},
            "POST /v1/machines/m_1/control/exec": {"result": "ok", "logs": [], "durationMs": 1},
        },
        calls,
    )
    cs = sai.control.open("m_1")
    r = cs.run(LearnResult.parse(LEARNED), {"n": 3})
    assert r.result == "ok"
    assert json.loads(calls[1].content)["code"] == (
        f'{LEARNED["code"]}\nawait main({{"site": "https://news.ycombinator.com", "n": 3}})'
    )
