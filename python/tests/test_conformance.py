"""The shared conformance suite (../../conformance/README.md): each case's steps become calls on
this SDK, against the mock server, which checks the requests and the outcomes."""

from __future__ import annotations

import base64
import dataclasses
import json
import subprocess
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from sai import (
    BlockError,
    Check,
    ControlLease,
    Evaluation,
    LinkOnlyApprovalError,
    Sai,
    SaiError,
    Session,
    SpendCapReachedError,
    Turn,
)

CONFORMANCE = Path(__file__).resolve().parents[2] / "conformance"
CASES = [c for f in sorted((CONFORMANCE / "cases").glob("*.json")) for c in json.loads(f.read_text())["cases"]]


@pytest.fixture(scope="module")
def mock_url() -> Iterator[str]:
    proc = subprocess.Popen(
        ["node", str(CONFORMANCE / "server.mjs")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
    )
    assert proc.stdout is not None
    line = proc.stdout.readline()
    if not line.startswith("SAI_MOCK_URL="):
        proc.kill()
        pytest.fail(f"mock server did not start: {line!r}")
    yield line.strip().removeprefix("SAI_MOCK_URL=")
    proc.kill()
    proc.wait()


def control(mock_url: str, path: str, body: Any) -> Any:
    return httpx.post(f"{mock_url}/__mock/{path}", json=body).json()


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_conformance(case: dict[str, Any], mock_url: str) -> None:
    control(mock_url, "start", {"case": case["id"]})
    opts = case.get("client") or {}
    sai = Sai(
        opts.get("api_key", "sapi_test"),
        base_url=mock_url,
        org_id=opts.get("org_id", ""),
        version_tag=opts.get("version_tag"),
    )
    saved: dict[str, Any] = {"client": sai}
    for index, step in enumerate(case["steps"]):
        try:
            value = invoke(saved, step)
            outcome: dict[str, Any] = {"result": project(value)}
            if "save" in step:
                saved[step["save"]] = pick(value, step["pick"]) if "pick" in step else value
        except Exception as err:  # noqa: BLE001 - every failure is reported to the server
            outcome = {"error": project_error(err)}
        control(mock_url, "step", {"index": index, **outcome})
    assert control(mock_url, "finish", {})["failures"] == []


# ─── Calls ─────────────────────────────────────────────────────────────────────


def invoke(saved: dict[str, Any], step: dict[str, Any]) -> Any:
    parts = step["call"].split(".")
    if parts[0] in saved and parts[0] != "client":
        target, method = saved[parts[0]], ".".join(parts[1:])
    else:
        target, method = saved["client"], step["call"]
    a = resolve(saved, step.get("args") or {})
    if isinstance(target, Sai):
        return call_client(target, method, a)
    if isinstance(target, Session):
        return call_session(target, method, a)
    if isinstance(target, Turn):
        return call_turn(target, method, a)
    if isinstance(target, ControlLease):
        return call_lease(target, method, a)
    raise AssertionError(f"no target for {step['call']}")


def resolve(saved: dict[str, Any], v: Any) -> Any:
    if isinstance(v, list):
        return [resolve(saved, x) for x in v]
    if isinstance(v, dict):
        if isinstance(v.get("$ref"), str):
            return saved[v["$ref"]]
        return {k: resolve(saved, x) for k, x in v.items()}
    return v


def pick(value: Any, path: str) -> Any:
    for part in path.split("."):
        value = value[int(part)] if isinstance(value, list) else getattr(value, part)
    return value


def checks(v: Any) -> Any:
    return v if isinstance(v, str) else [Check(**c) for c in v]


def send_kwargs(a: dict[str, Any]) -> dict[str, Any]:
    keys = ("model", "attachments", "inputs", "output_schema", "idempotency_key", "record_trajectory")
    kw = {k: a[k] for k in (*keys, "thinking_level", "autonomous") if k in a}
    if "success_criteria" in a:
        kw["success_criteria"] = checks(a["success_criteria"])
    return kw


def wait_kwargs(a: dict[str, Any]) -> dict[str, Any]:
    kw = {k: a[k] for k in ("poll_wait",) if k in a}
    if "on_approval" in a:
        answers = list(a["on_approval"]["answers"])

        def handler(_approval: Any) -> Any:
            if not answers:
                return None
            answer = answers.pop(0)
            return tuple(answer) if isinstance(answer, list) else answer

        kw["on_approval"] = handler
    return kw


def only(a: dict[str, Any], *keys: str) -> dict[str, Any]:
    return {k: a[k] for k in keys if k in a}


def call_client(sai: Sai, method: str, a: dict[str, Any]) -> Any:
    if method == "files.upload":
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / a["name"]
            path.write_bytes(base64.b64decode(a["data_base64"]))
            return sai.files.upload(path)
    if method == "learn.create":
        kw = dict(a)
        turns = kw.pop("turns")
        if "criteria" in kw:
            kw["criteria"] = checks(kw["criteria"])
        if "evaluations" in kw:
            kw["evaluations"] = [Evaluation(**e) for e in kw["evaluations"]]
        return sai.learn.create(turns, **kw)
    if method == "judge.create":
        return sai.judge.create(a["turns"], checks(a["criteria"]), **only(a, "task", "idempotency_key"))
    if method in ("usage.get", "usage.sessions"):
        kw = {("from_" if k == "from" else k): v for k, v in a.items()}
        return getattr(sai.usage, method.split(".")[1])(**kw)
    if method == "learn.wait":
        kw = {"poll_interval": a["poll_ms"] / 1000} if "poll_ms" in a else {}
        return sai.learn.wait(a["job"], **kw)
    if method == "control.open":
        return sai.control.open(a["machine"])
    resource, name = method.split(".")
    # Every other call's arguments are the Python SDK's own parameter names.
    return getattr(getattr(sai, resource), name)(**a)


def call_session(s: Session, method: str, a: dict[str, Any]) -> Any:
    if method == "send":
        return s.send(a["message"], **send_kwargs(a))
    if method == "run":
        return s.run(a["message"], **send_kwargs(a), **wait_kwargs(a))
    if method == "abort":
        return s.abort()
    if method == "respond":
        return s.respond(**a)
    raise AssertionError(f"unknown call Session.{method}")


def call_turn(t: Turn, method: str, a: dict[str, Any]) -> Any:
    if method == "events":
        return list(t.events(**a))
    if method == "wait":
        return t.wait(**wait_kwargs(a))
    if method == "respond":
        return t.respond(**a)
    if method == "abort":
        return t.abort()
    raise AssertionError(f"unknown call Turn.{method}")


def call_lease(lease: ControlLease, method: str, a: dict[str, Any]) -> Any:
    if method == "get":
        return Opaque(lease.get())
    if method == "shell":
        # The shell result is the block's JSON: {stdout, stderr, exitCode, timedOut}.
        return {_snake(k): v for k, v in lease.shell(**a).items()}
    return getattr(lease, method)(**a)


# ─── Projection ────────────────────────────────────────────────────────────────


@dataclasses.dataclass
class Opaque:
    """A call that returns free-form JSON: projected as is."""

    value: Any


# Free-form JSON from the API, passed through with its keys as they are.
OPAQUE = {"output", "result", "inputs", "metadata", "variables", "questions", "run", "judgement", "by_model", "output_schema"}
# Computed properties the projection includes.
PROPERTIES = ("ok", "done")


def project(v: Any) -> Any:
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, Opaque):
        return v.value
    if isinstance(v, bytes):
        return {"$base64": base64.b64encode(v).decode()}
    if isinstance(v, Sai):
        return {}
    if isinstance(v, Session):
        return {"id": v.id, "machine_id": v.machine_id}
    if isinstance(v, Turn):
        return {"id": v.id, "queued": v.queued, "status": v.status}
    if isinstance(v, ControlLease):
        return {"machine_id": v.machine_id, "idle_timeout_sec": v.idle_timeout_sec}
    if isinstance(v, (list, tuple)):
        return [project(x) for x in v]
    if isinstance(v, dict):
        return {k: project(x) for k, x in v.items()}
    if dataclasses.is_dataclass(v):
        out: dict[str, Any] = {}
        for f in dataclasses.fields(v):
            if f.name == "raw":
                continue
            x = getattr(v, f.name)
            name = f.name.rstrip("_")
            out[name] = x if f.name in OPAQUE and not isinstance(x, bytes) else project(x)
        for p in PROPERTIES:
            if isinstance(getattr(type(v), p, None), property):
                out[p] = getattr(v, p)
        return out
    raise AssertionError(f"cannot project {type(v).__name__}")


def project_error(err: Exception) -> dict[str, Any]:
    if not isinstance(err, SaiError):
        return {"class": type(err).__name__, "message": str(err)}
    out: dict[str, Any] = {
        "class": type(err).__name__,
        "status": err.status,
        "code": err.code,
        "message": err.message,
        "retry_after": err.retry_after,
        "body": err.body,
    }
    if isinstance(err, LinkOnlyApprovalError):
        out["approval_url"] = err.approval_url
    if isinstance(err, SpendCapReachedError):
        out["resets_at"] = err.resets_at
    if isinstance(err, BlockError):
        out["kind"] = err.kind
    return out


def _snake(s: str) -> str:
    return "".join(f"_{c.lower()}" if c.isupper() else c for c in s)
