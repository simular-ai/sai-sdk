"""Direct control: drive a cloud computer with Simulang. No agent.

Maps to `/v1/machines/{id}/control`, a lease on the machine: at most one per
machine, so the machine id is the handle. Research preview: the account needs
direct control enabled.
"""

from __future__ import annotations

import json
from urllib.parse import quote
from typing import TYPE_CHECKING, Any, Optional, Union

from ._errors import BlockError, GoneError
from .types import ExecResult

if TYPE_CHECKING:
    from ._client import Sai
    from .machines import Machine



def _control_path(machine_id: str) -> str:
    return f"/v1/machines/{quote(machine_id, safe='')}/control"


class Control:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def open(self, machine: Union[Machine, str]) -> ControlLease:
        """Take a cloud computer. Returns once the lease holds it, up to ~3 minutes
        when a Sai task holds it or it has to start; at once if the lease is already
        open. Use as a context manager so it is always released: Sai's tasks on that
        computer wait until then."""
        machine_id = machine if isinstance(machine, str) else machine.id
        d = self._sai._http.json("POST", _control_path(machine_id), timeout=240)
        return ControlLease(self._sai, machine_id, int(d.get("expiresAfterIdleSec", 0)))


class ControlLease:
    def __init__(self, sai: Sai, machine_id: str, idle_timeout_sec: int) -> None:
        self._sai = sai
        self.machine_id = machine_id
        self._path = _control_path(machine_id)
        self.idle_timeout_sec = idle_timeout_sec
        self._closed = False

    def __repr__(self) -> str:
        return f"ControlLease(machine_id={self.machine_id!r})"

    def __enter__(self) -> ControlLease:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def exec(self, code: str, *, timeout_ms: Optional[int] = None) -> ExecResult:
        """Run one Simulang (JavaScript) block. Use `var` for anything the next block needs.

        A block that throws, times out or is interrupted still returns: check
        `result.error`. Raises `GoneError` once the lease has ended (closed, idle,
        taken by a Sai task, or the computer stopped answering): open again.
        """
        body: dict[str, Any] = {"code": code}
        if timeout_ms is not None:
            body["timeoutMs"] = timeout_ms
        d = self._sai._http.json(
            "POST", f"{self._path}/exec", json=body, timeout=(timeout_ms or 120_000) / 1000 + 45
        )
        return ExecResult.parse(d)

    def shell(self, command: str, *, cwd: Optional[str] = None, timeout_ms: Optional[int] = None) -> dict[str, Any]:
        """Run a shell command: `{stdout, stderr, exitCode, timedOut}`."""
        args: dict[str, Any] = {"command": command}
        if cwd:
            args["cwd"] = cwd
        r = self.exec(f"await machine.exec({json.dumps(args)})", timeout_ms=timeout_ms)
        _raise_on_block_error(r)
        return r.result

    def read_file(self, path: str) -> str:
        r = self.exec(f"await machine.readFile({json.dumps({'path': path})})")
        _raise_on_block_error(r)
        return r.result

    def write_file(self, path: str, text: str) -> None:
        r = self.exec(f"await machine.writeToFile({json.dumps({'path': path, 'text': text, 'overwrite': True})})")
        _raise_on_block_error(r)

    def screenshot(self) -> bytes:
        """The whole screen as PNG bytes. Needs the computer's screen-capture service;
        raises `BlockError` where it is off (a page or app snapshot still carries an image)."""
        r = self.exec("var __sai_page = await machine.pageContent(); null")
        _raise_on_block_error(r)
        if r.screenshot_png is None:
            raise BlockError("exception", "screenshot too large to return" if r.screenshot_omitted else "no screenshot")
        return r.screenshot_png

    def interrupt(self) -> bool:
        """Stop the running block at its next step. False if nothing was running."""
        d = self._sai._http.json("POST", f"{self._path}/interrupt")
        return bool(d and d.get("interrupted"))

    def get(self) -> dict[str, Any]:
        """`{status: open|closed, closedReason?, lastExecAt, ...}`."""
        return self._sai._http.json("GET", self._path)

    def close(self) -> None:
        """Clear the REPL and release the computer. Safe to call twice."""
        if self._closed:
            return
        try:
            self._sai._http.request("DELETE", self._path)
        except GoneError:
            pass
        self._closed = True


def _raise_on_block_error(r: ExecResult) -> None:
    if r.error:
        raise BlockError(r.error.kind, r.error.message)
