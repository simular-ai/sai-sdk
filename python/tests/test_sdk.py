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
    ExecResult,
    GoneError,
    LinkOnlyApprovalError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    Sai,
    SpendCapReachedError,
    TurnResult,
)

Handler = Callable[[httpx.Request], httpx.Response]


def client(routes: dict[str, Any], calls: list[httpx.Request] | None = None, **kwargs: Any) -> Sai:
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

    return Sai("sapi_test", base_url="https://api.test", transport=httpx.MockTransport(handle), **kwargs)


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


def test_spend_cap_reached_has_its_own_error() -> None:
    body = {"error": "spend_cap_reached", "message": "This key reached its limit.", "resetsAt": "2026-11-01T00:00:00.000Z"}
    sai = client({"POST /v1/agents/message": (403, body)})
    with pytest.raises(SpendCapReachedError) as e:
        sai.sessions.resume("cs_1", machine="m_1").send("hello")
    assert isinstance(e.value, PermissionDeniedError)
    assert e.value.status == 403
    assert e.value.code == "spend_cap_reached"
    assert e.value.resets_at == "2026-11-01T00:00:00.000Z"


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


def test_handled_message_reads_reply() -> None:
    sai = client({"POST /v1/agents/message": {"handled": True, "reply": "Hi! What should I do?", "error": "old"}})
    turn = sai.sessions.resume("cs_1", "m_1").send("hello")
    assert turn.wait().text == "Hi! What should I do?"


def test_error_code_and_message_body() -> None:
    sai = client({"POST /v1/agents/abort": (404, {"error": "not_found", "message": "Session not found."})})
    with pytest.raises(NotFoundError) as e:
        sai.sessions.resume("cs_1", "m_1").abort()
    assert e.value.code == "not_found"
    assert e.value.message == "Session not found."


def test_retry_after_from_body_without_header() -> None:
    body = {"error": "rate_limited", "message": "Too many requests.", "retryAfterSeconds": 42}
    sai = client({"GET /v1/agents/machines": (429, body)})
    with pytest.raises(RateLimitError) as e:
        sai.machines.list()
    assert e.value.retry_after == 42


def test_machine_state() -> None:
    machines = {
        "machines": [
            {"machineId": "m_1", "kind": "cloud", "state": "asleep", "status": "hibernated"},
            {"machineId": "m_2", "kind": "own"},
        ]
    }
    got = client({"GET /v1/agents/machines": machines}).machines.list()
    assert [(m.state, m.status) for m in got] == [("asleep", "hibernated"), (None, None)]


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
    with sai.control.open("m_1") as lease:
        assert lease.shell("hostname")["stdout"].strip() == "HOST"
        assert lease.screenshot() == png
        r = lease.exec("throw new Error('boom')")
        assert not r.ok and r.error is not None and r.error.kind == "exception"
    assert calls[-1].method == "DELETE"
    first_exec = next(c for c in calls if c.url.path.endswith("/exec"))
    assert json.loads(first_exec.content)["code"] == 'await machine.exec({"command": "hostname"})'


def test_exec_result_keeps_screenshot_mime_type() -> None:
    jpeg = b"\xff\xd8\xff\xe0 fake"
    r = ExecResult.parse(
        {"observations": {"screenshot": {"base64": base64.b64encode(jpeg).decode(), "mimeType": "image/jpeg"}}}
    )
    assert (r.screenshot, r.screenshot_mime_type, r.screenshot_png) == (jpeg, "image/jpeg", jpeg)
    assert ExecResult.parse({}).screenshot_mime_type is None


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
    lease = sai.control.open("m_1")
    with pytest.raises(GoneError) as e:
        lease.exec("1")
    assert e.value.code == "control_closed"
    assert e.value.body["reason"] == "unresponsive"
    lease.close()


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
    assert calls[0].headers["content-type"] == "application/octet-stream"


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


def test_autonomous_goes_on_the_message_not_in_options() -> None:
    calls: list[httpx.Request] = []
    sai = client(
        {
            "POST /v1/agents/new-session": {"sessionId": "cs_1"},
            "POST /v1/agents/message": (202, {"sessionId": "cs_1", "machineId": "m_1", "turnId": "turn_4"}),
            "GET /v1/agents/events": {"sessionId": "cs_1", "status": "idle", "events": [], "text": "Done."},
        },
        calls,
    )
    session = sai.sessions.create("m_1")
    session.run("hello", autonomous=True)
    session.run("again")
    bodies = [json.loads(c.content) for c in calls if c.url.path == "/v1/agents/message"]
    assert bodies[0]["autonomous"] is True and "options" not in bodies[0]
    assert "autonomous" not in bodies[1]


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
    # The same result the live path returned: the answer, its usage, and ok.
    assert result.status == "idle" and result.ok
    assert result.text == '{"path":"C:\\\\Users\\\\me\\\\Desktop\\\\inv-1001.txt"}'
    assert result.usage is not None and result.usage.input_tokens == 120


def replay(record: dict[str, Any]) -> TurnResult:
    sai = client(
        {
            "POST /v1/agents/new-session": {"sessionId": "cs_1"},
            "POST /v1/agents/message": {**record, "idempotent_replay": True},
        }
    )
    return sai.sessions.create("m_1").send("x", idempotency_key="k").wait()


def test_replay_of_a_plain_turn_returns_its_answer() -> None:
    result = replay({**DONE, "output": "Saved it."})
    assert result.status == "idle" and result.text == "Saved it." and result.ok


def test_replay_of_a_broken_turn_is_an_error() -> None:
    result = replay(
        {
            **DONE,
            "status": "failed",
            "output": None,
            "reason_code": "agent_error",
            "raw_answer": "You are out of credits.",
            "error_code": "insufficient_credits",
        }
    )
    assert result.status == "error" and not result.ok and result.text == ""
    assert result.error == "You are out of credits." and result.error_code == "insufficient_credits"


def test_replay_of_a_turn_that_failed_its_checks_keeps_the_answer() -> None:
    result = replay({**DONE, "status": "failed", "output": None, "reason_code": "output_invalid", "raw_answer": "No path."})
    assert result.status == "idle" and not result.ok and result.text == "No path."
    assert result.record is not None and result.record.reason_code == "output_invalid"


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
    lease = sai.control.open("m_1")
    r = lease.run(LearnResult.parse(LEARNED), {"n": 3})
    assert r.result == "ok"
    assert json.loads(calls[1].content)["code"] == (
        f'{LEARNED["code"]}\nawait main({{"site": "https://news.ycombinator.com", "n": 3}})'
    )


TENANT = {
    "tenantId": "t_1",
    "name": "Riverside Clinic",
    "externalId": "clinic-4821",
    "metadata": {"plan": "pro"},
    "status": "active",
    "createdAt": 1790000000000,
    "disabledAt": None,
    "machineCount": 2,
}
TENANT_MACHINE = {
    "machineId": "tm_1",
    "name": "Front desk PC",
    "platform": "darwin",
    "status": "active",
    "online": True,
    "lastSeen": 1790003600000,
    "runtimeVersion": "1.2.0",
}


def test_tenants_map_to_the_tenant_routes() -> None:
    calls: list[httpx.Request] = []
    sai = client(
        {
            "POST /v1/tenants": (201, TENANT),
            "GET /v1/tenants": {"tenants": [TENANT], "nextCursor": "c_2"},
            "GET /v1/tenants/t_1": TENANT,
            "PATCH /v1/tenants/t_1": {**TENANT, "status": "disabled", "disabledAt": 1790000001000},
            "DELETE /v1/tenants/t_1": (204, None),
            "POST /v1/tenants/t_1/enrollments": (201, {"enrollmentToken": "senr_1", "expiresAt": 1790000900000}),
        },
        calls,
    )
    t = sai.tenants.create("Riverside Clinic", external_id="clinic-4821", metadata={"plan": "pro"})
    assert json.loads(calls[0].content) == {
        "name": "Riverside Clinic",
        "externalId": "clinic-4821",
        "metadata": {"plan": "pro"},
    }
    assert (t.id, t.external_id, t.metadata, t.machine_count) == ("t_1", "clinic-4821", {"plan": "pro"}, 2)

    page = sai.tenants.list(status="active", limit=10)
    assert dict(calls[1].url.params) == {"status": "active", "limit": "10"}
    assert ([x.id for x in page.tenants], page.next_cursor) == (["t_1"], "c_2")
    sai.tenants.list(external_id="clinic-4821")
    assert dict(calls[2].url.params) == {"externalId": "clinic-4821"}

    assert sai.tenants.get(t).name == "Riverside Clinic"
    disabled = sai.tenants.update("t_1", status="disabled")
    assert json.loads(calls[4].content) == {"status": "disabled"}
    assert (disabled.status, disabled.disabled_at) == ("disabled", 1790000001000)

    assert sai.tenants.delete(t) is None
    e = sai.tenants.create_enrollment(t)
    assert (e.token, e.expires_at) == ("senr_1", 1790000900000)
    assert [f"{c.method} {c.url.path}" for c in calls[5:]] == [
        "DELETE /v1/tenants/t_1",
        "POST /v1/tenants/t_1/enrollments",
    ]


def test_tenant_machines_list_get_and_revoke() -> None:
    calls: list[httpx.Request] = []
    sai = client(
        {
            "GET /v1/tenants/t_1/machines": {"machines": [TENANT_MACHINE]},
            "GET /v1/tenants/t_1/machines/tm_1": TENANT_MACHINE,
            "DELETE /v1/tenants/t_1/machines/tm_1": (204, None),
        },
        calls,
    )
    [m] = sai.tenant_machines.list("t_1")
    assert (m.id, m.platform, m.online, m.last_seen, m.runtime_version) == (
        "tm_1",
        "darwin",
        True,
        1790003600000,
        "1.2.0",
    )
    assert sai.tenant_machines.get("t_1", "tm_1").name == "Front desk PC"
    assert sai.tenant_machines.revoke("t_1", m) is None
    assert f"{calls[2].method} {calls[2].url.path}" == "DELETE /v1/tenants/t_1/machines/tm_1"


CLOUD_MACHINE = {
    "machineId": "cm_1",
    "kind": "cloud",
    "name": "intake-desk-3",
    "platform": "win32",
    "machineClass": "win32-4c8g",
    "state": "provisioning",
    "lastSeen": None,
    "runtimeVersion": None,
    "createdAt": 1790000000000,
}
ENROLLED_MACHINE = {
    "machineId": "tm_1",
    "kind": "enrolled",
    "name": "Front desk PC",
    "platform": "darwin",
    "state": "offline",
    "lastSeen": 1790003600000,
    "runtimeVersion": "1.2.0",
    "createdAt": 1789000000000,
}


def test_tenant_machines_parse_both_kinds_and_the_older_shape() -> None:
    sai = client(
        {
            "GET /v1/tenants/t_1/machines": {
                "machines": [ENROLLED_MACHINE, {**CLOUD_MACHINE, "state": "ready"}, TENANT_MACHINE]
            }
        }
    )
    enrolled, cloud, older = sai.tenant_machines.list("t_1")
    assert (enrolled.kind, enrolled.state, enrolled.online, enrolled.machine_class, enrolled.created_at) == (
        "enrolled",
        "offline",
        False,
        None,
        1789000000000,
    )
    assert (cloud.kind, cloud.state, cloud.online, cloud.machine_class, cloud.platform) == (
        "cloud",
        "ready",
        True,
        "win32-4c8g",
        "win32",
    )
    assert (older.kind, older.state, older.online, older.status, older.created_at) == (
        "enrolled",
        "online",
        True,
        "active",
        None,
    )


def test_tenant_machine_create_sends_the_body_and_returns_at_once() -> None:
    calls: list[httpx.Request] = []
    sai = client({"POST /v1/tenants/t_1/machines": (202, CLOUD_MACHINE)}, calls)
    m = sai.tenant_machines.create("t_1", os="windows", name="intake-desk-3", request_id="req_1")
    assert json.loads(calls[0].content) == {"os": "windows", "name": "intake-desk-3", "requestId": "req_1"}
    assert (m.id, m.kind, m.state, m.machine_class) == ("cm_1", "cloud", "provisioning", "win32-4c8g")

    sai.tenant_machines.create("t_1", os="linux")
    assert json.loads(calls[1].content) == {"os": "linux"}
    assert len(calls) == 2


def test_tenant_machine_create_waits_until_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr("sai.tenants.time.sleep", slept.append)
    calls: list[httpx.Request] = []
    sai = client(
        {
            "POST /v1/tenants/t_1/machines": (202, CLOUD_MACHINE),
            "GET /v1/tenants/t_1/machines/cm_1": [
                CLOUD_MACHINE,
                {**CLOUD_MACHINE, "state": "starting"},
                (429, {"error": "rate_limited", "message": "Slow down", "retryAfterSeconds": 7}),
                {**CLOUD_MACHINE, "state": "ready"},
            ],
        },
        calls,
    )
    m = sai.tenant_machines.create("t_1", os="windows", wait=True)
    assert (m.state, m.online) == ("ready", True)
    assert slept == [5, 5, 5, 7, 5]
    assert [f"{c.method} {c.url.path}" for c in calls] == ["POST /v1/tenants/t_1/machines"] + [
        "GET /v1/tenants/t_1/machines/cm_1"
    ] * 4


@pytest.mark.parametrize("state", ["failed", "deleting"])
def test_tenant_machine_create_wait_raises_when_it_cannot_become_ready(
    monkeypatch: pytest.MonkeyPatch, state: str
) -> None:
    from sai import SaiError

    monkeypatch.setattr("sai.tenants.time.sleep", lambda _: None)
    sai = client(
        {
            "POST /v1/tenants/t_1/machines": (202, CLOUD_MACHINE),
            "GET /v1/tenants/t_1/machines/cm_1": {**CLOUD_MACHINE, "state": state},
        }
    )
    with pytest.raises(SaiError, match=f"cm_1 is {state}") as e:
        sai.tenant_machines.create("t_1", os="windows", wait=True)
    assert e.value.body["state"] == state


def test_tenant_machine_create_wait_times_out() -> None:
    sai = client({"POST /v1/tenants/t_1/machines": (202, CLOUD_MACHINE)})
    with pytest.raises(TimeoutError, match="cm_1 still provisioning"):
        sai.tenant_machines.create("t_1", os="windows", wait=True, timeout=0)


def test_tenant_machine_delete_says_revoked_or_deleting() -> None:
    calls: list[httpx.Request] = []
    sai = client(
        {
            "DELETE /v1/tenants/t_1/machines/tm_1": (204, None),
            "DELETE /v1/tenants/t_1/machines/cm_1": (202, {"state": "deleting"}),
        },
        calls,
    )
    assert sai.tenant_machines.delete("t_1", "tm_1") == "revoked"
    assert sai.tenant_machines.delete("t_1", "cm_1") == "deleting"
    assert [f"{c.method} {c.url.path}" for c in calls] == [
        "DELETE /v1/tenants/t_1/machines/tm_1",
        "DELETE /v1/tenants/t_1/machines/cm_1",
    ]


def test_tenant_update_sets_or_clears_the_cloud_machine_limit_and_the_proxy() -> None:
    calls: list[httpx.Request] = []
    detail = {**TENANT, "cloudMachineLimit": 5, "residentialProxy": True, "cloudMachineCount": 2}
    sai = client({"PATCH /v1/tenants/t_1": detail, "GET /v1/tenants": {"tenants": [TENANT]}}, calls)
    t = sai.tenants.update("t_1", cloud_machine_limit=5, residential_proxy=True)
    assert json.loads(calls[0].content) == {"cloudMachineLimit": 5, "residentialProxy": True}
    assert (t.cloud_machine_limit, t.residential_proxy, t.cloud_machine_count) == (5, True, 2)

    sai.tenants.update("t_1", cloud_machine_limit=None)
    assert json.loads(calls[1].content) == {"cloudMachineLimit": None}
    sai.tenants.update("t_1", name="Riverside", residential_proxy=False)
    assert json.loads(calls[2].content) == {"name": "Riverside", "residentialProxy": False}

    [listed] = sai.tenants.list().tenants
    assert (listed.cloud_machine_limit, listed.residential_proxy, listed.cloud_machine_count) == (None, None, None)


@pytest.mark.parametrize(
    "status,body,cls",
    [
        (402, {"error": "insufficient_credits", "message": "No credit."}, "SaiError"),
        (
            403,
            {"error": "spend_cap_reached", "message": "Budget.", "scope": "tenant", "resetsAt": "2026-11-01T00:00:00Z"},
            "SpendCapReachedError",
        ),
        (409, {"error": "machine_limit_reached", "message": "Limit.", "limit": 5, "used": 5}, "ConflictError"),
        (409, {"error": "request_id_reused", "message": "Reused."}, "ConflictError"),
        (403, {"error": "tenant_disabled", "message": "Disabled."}, "PermissionDeniedError"),
        (404, {"error": "not_found", "message": "Tenant not found."}, "NotFoundError"),
        (503, {"error": "capacity_unavailable", "message": "No capacity."}, "ServiceUnavailableError"),
        (429, {"error": "rate_limited", "message": "Too many."}, "RateLimitError"),
        (500, {"error": "internal", "message": "Quote errorId.", "errorId": "e_1"}, "SaiError"),
    ],
)
def test_tenant_machine_create_errors(status: int, body: dict[str, Any], cls: str) -> None:
    import sai as sdk

    s = client({"POST /v1/tenants/t_1/machines": (status, body)})
    with pytest.raises(sdk.SaiError) as e:
        s.tenant_machines.create("t_1", os="windows")
    assert type(e.value) is getattr(sdk, cls)
    assert (e.value.status, e.value.code, e.value.message) == (status, body["error"], body["message"])
    assert e.value.body == body


def test_tenant_token_org_id_from_client_env_or_call(monkeypatch: pytest.MonkeyPatch) -> None:
    reply = {"token": "tt_1", "expiresAt": 1790003600000, "tenantId": "t_1"}
    routes = {
        "POST /v1/orgs/org_a/tenants/t_1/token": reply,
        "POST /v1/orgs/org_b/tenants/t_1/token": reply,
        "POST /v1/orgs/org_env/tenants/t_1/token": reply,
    }
    monkeypatch.delenv("SAI_ORG_ID", raising=False)
    with pytest.raises(ValueError, match="SAI_ORG_ID"):
        client(routes).tenants.token("t_1")

    sai = client(routes, org_id="org_a")
    tok = sai.tenants.token("t_1")
    assert (tok.token, tok.expires_at, tok.tenant_id) == ("tt_1", 1790003600000, "t_1")
    assert sai.tenants.token("t_1", org_id="org_b").token == "tt_1"

    monkeypatch.setenv("SAI_ORG_ID", "org_env")
    assert client(routes).tenants.token("t_1").token == "tt_1"


def test_tenant_client_acts_as_the_tenant_and_exchanges_before_expiry() -> None:
    import time

    now = int(time.time() * 1000)
    calls: list[httpx.Request] = []
    sai = client(
        {
            "POST /v1/orgs/org_a/tenants/t_1/token": [
                {"token": "tt_1", "expiresAt": now + 4 * 60 * 1000, "tenantId": "t_1"},
                {"token": "tt_2", "expiresAt": now + 60 * 60 * 1000, "tenantId": "t_1"},
            ],
            "GET /v1/agents/machines": MACHINES,
        },
        calls,
        org_id="org_a",
    )
    tenant = sai.tenants.client("t_1")
    assert [c.url.path for c in calls] == ["/v1/orgs/org_a/tenants/t_1/token"]
    assert calls[0].headers["authorization"] == "Bearer sapi_test"

    tenant.machines.list()  # tt_1 has under five minutes left
    tenant.machines.list()
    assert [c.url.path for c in calls[1:]] == [
        "/v1/orgs/org_a/tenants/t_1/token",
        "/v1/agents/machines",
        "/v1/agents/machines",
    ]
    assert [c.headers["authorization"] for c in calls[2:]] == ["Bearer tt_2", "Bearer tt_2"]
