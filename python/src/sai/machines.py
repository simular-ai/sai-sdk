"""Machines: the computers Sai works on. Cloud computers, or the customer's own PC with the Sai app."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Optional, Union

from ._errors import BadRequestError, NotFoundError
from .types import LiveView, MachineCapabilities

if TYPE_CHECKING:
    from ._client import Sai


@dataclass
class Machine:
    id: str
    name: Optional[str]
    kind: str
    """`cloud` (hosted by Simular) or `own` (a desktop with the Sai app)."""
    online: bool
    """True when a message can reach it now (a hibernated cloud computer wakes on the first message)."""
    status: Optional[str]
    """Deprecated: the server's internal lifecycle value; it may gain values at any time. Use `state`."""
    can_wake: bool
    raw: dict[str, Any] = field(repr=False)
    state: Optional[str] = None
    """`running`, `starting`, `asleep`, `creating` or `unknown`; None on servers that do not send it yet."""
    os: Optional[str] = None
    """`windows`, `linux`, `macOS` or `android`; None when the server does not know it or does not send it yet."""
    capabilities: Optional[MachineCapabilities] = None
    """What stands in the way of driving it. None for a cloud machine, before the runtime has
    reported, from a runtime older than 0.1.3, when its check failed, and from older servers."""

    @classmethod
    def parse(cls, d: dict[str, Any]) -> Machine:
        return cls(
            id=d["machineId"],
            name=d.get("name"),
            kind=d.get("kind", ""),
            online=bool(d.get("online")),
            status=d.get("status"),
            can_wake=bool(d.get("canWake")),
            raw=d,
            state=d.get("state"),
            os=d.get("os"),
            capabilities=MachineCapabilities.parse(d.get("capabilities")),
        )


class Machines:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def list(self) -> list[Machine]:
        d = self._sai._http.json("GET", "/v1/agents/machines")
        return [Machine.parse(m) for m in d.get("machines") or []]

    def get(self, machine_id: str) -> Machine:
        for m in self.list():
            if m.id == machine_id:
                return m
        raise NotFoundError(f"Machine {machine_id} not found on this account.", status=404)

    def live(self, machine: Union[Machine, str]) -> LiveView:
        """The live screen: `live_url`, a page a person can open without a Simular sign-in, and a
        Guacamole tunnel for a viewer of your own. The machine must be running."""
        machine_id = machine.id if isinstance(machine, Machine) else machine
        d = self._sai._http.json("POST", f"/v1/agents/machines/{machine_id}/live")
        live_url = d.get("liveUrl")
        expires_at = d.get("expiresAt")
        return LiveView(
            machine_id=d.get("machineId", machine_id),
            websocket_url=d["websocketUrl"],
            width=int(d.get("width", 0)),
            height=int(d.get("height", 0)),
            live_url=live_url if isinstance(live_url, str) else None,
            expires_at=int(expires_at) if isinstance(expires_at, (int, float)) else None,
        )

    def revoke_live(self, machine: Union[Machine, str]) -> int:
        """Revokes every `live_url` handed out for the machine; returns how many. A page already showing
        the screen keeps its connection until it closes, but stops taking input within seconds."""
        machine_id = machine.id if isinstance(machine, Machine) else machine
        d = self._sai._http.json("DELETE", f"/v1/agents/machines/{machine_id}/live") or {}
        return int(d.get("revoked") or 0)

    def _resolve_id(self, machine: Union[Machine, str, None]) -> str:
        if isinstance(machine, Machine):
            return machine.id
        if machine:
            return machine
        machines = self.list()
        if len(machines) == 1:
            return machines[0].id
        if not machines:
            raise BadRequestError(
                "No computer on this account. Create one in the Sai app or the portal.", status=400
            )
        names = ", ".join(f"{m.id} ({m.name})" if m.name else m.id for m in machines)
        raise BadRequestError(f"Several computers on this account; pass machine=. Candidates: {names}", status=400)
