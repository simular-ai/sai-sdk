from __future__ import annotations

import base64
import json
from typing import Any, Callable

import httpx
import pytest

from sai import (
    AuthenticationError,
    BadRequestError,
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
    assert json.loads(msg.content) == {"message": "type hello", "wait": False, "machineId": "m_1", "model": "auto"}
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
