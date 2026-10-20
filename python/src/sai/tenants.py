"""Tenants: your customers, under an Organisation. Every call here takes an Organisation Key.

Maps to `/v1/tenants` and `POST /v1/orgs/{orgId}/tenants/{tenantId}/token`.
"""

from __future__ import annotations

import enum
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Optional, Union

from ._errors import RateLimitError, SaiError

if TYPE_CHECKING:
    from ._client import Sai

TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
"""`tenants.client()` exchanges again when its token has less than this left."""

_MACHINE_POLL_INTERVAL = 5  # seconds between machine reads while `create(wait=True)` waits


class _Unset(enum.Enum):
    UNSET = 0


_UNSET = _Unset.UNSET


@dataclass
class Tenant:
    id: str
    name: str
    external_id: Optional[str]
    """Your id for the customer. Unique in the Organisation; set on create only."""
    metadata: dict[str, str]
    status: str
    """`active` or `disabled`."""
    created_at: int
    """Unix time in milliseconds."""
    disabled_at: Optional[int]
    machine_count: int
    """Enrolled machines."""
    cloud_machine_limit: Optional[int]
    """Most cloud machines the Tenant may have at once. None: no limit."""
    residential_proxy: Optional[bool]
    """The Tenant's residential proxy switch. It has no effect yet: traffic goes direct. Set by `get` and
    `update`; None from `list` and from servers before cloud machines."""
    cloud_machine_count: Optional[int]
    """Set by `get` and `update`; None from `list` and from servers before cloud machines."""
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> Tenant:
        return cls(
            id=d["tenantId"],
            name=d.get("name", ""),
            external_id=d.get("externalId"),
            metadata=dict(d.get("metadata") or {}),
            status=d.get("status", ""),
            created_at=int(d.get("createdAt") or 0),
            disabled_at=d.get("disabledAt"),
            machine_count=int(d.get("machineCount") or 0),
            cloud_machine_limit=d.get("cloudMachineLimit"),
            residential_proxy=d.get("residentialProxy"),
            cloud_machine_count=d.get("cloudMachineCount"),
            raw=d,
        )


@dataclass
class TenantPage:
    tenants: list[Tenant]
    next_cursor: Optional[str]
    """Pass as `cursor=` for the next page; None on the last page."""


@dataclass
class TenantMachine:
    id: str
    name: Optional[str]
    platform: Optional[str]
    status: str
    """Older servers only; empty on servers with cloud machines. Read `state`."""
    online: bool
    """True when an enrolled machine reported in the last 3 minutes, or a cloud machine is `ready`."""
    last_seen: Optional[int]
    runtime_version: Optional[str]
    kind: str
    """`enrolled` (the Tenant's own computer) or `cloud` (a computer Sai hosts for the Tenant)."""
    state: str
    """Enrolled: `online` or `offline`. Cloud: `provisioning`, `ready`, `starting`, `hibernated`,
    `deleting` or `failed`. A run starts without waiting only on `ready`; a hibernated machine
    wakes when a run is sent to it."""
    machine_class: Optional[str]
    """Cloud only: the billing class, e.g. `win32-4c8g`."""
    created_at: Optional[int]
    """Unix time in milliseconds. None from servers before cloud machines."""
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> TenantMachine:
        # Servers before cloud machines send `online` and `status` and no `kind` or `state`.
        state = d.get("state") or ("online" if d.get("online") else "offline")
        return cls(
            id=d["machineId"],
            name=d.get("name"),
            platform=d.get("platform"),
            status=d.get("status", ""),
            online=bool(d["online"]) if "online" in d else state in ("online", "ready"),
            last_seen=d.get("lastSeen"),
            runtime_version=d.get("runtimeVersion"),
            kind="cloud" if d.get("kind") == "cloud" else "enrolled",
            state=state,
            machine_class=d.get("machineClass"),
            created_at=d.get("createdAt"),
            raw=d,
        )


@dataclass
class Enrollment:
    token: str
    """Single use. Treat it as a secret until the Sai runtime redeems it."""
    expires_at: int
    """Unix time in milliseconds, 15 minutes after it was created."""
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> Enrollment:
        return cls(token=d["enrollmentToken"], expires_at=int(d.get("expiresAt") or 0), raw=d)


@dataclass
class TenantToken:
    token: str
    """Pass as `Sai(api_key=...)` to act as the Tenant on sessions, machines and turns."""
    expires_at: int
    """Unix time in milliseconds, an hour after the exchange. There is no refresh: exchange again."""
    tenant_id: str
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> TenantToken:
        return cls(
            token=d["token"], expires_at=int(d.get("expiresAt") or 0), tenant_id=d.get("tenantId", ""), raw=d
        )


TenantRef = Union[Tenant, str]
TenantMachineRef = Union[TenantMachine, str]


def _q(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def _tenant_id(tenant: TenantRef) -> str:
    return tenant.id if isinstance(tenant, Tenant) else tenant


class Tenants:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def create(
        self,
        name: str,
        *,
        external_id: Optional[str] = None,
        metadata: Optional[dict[str, str]] = None,
    ) -> Tenant:
        """`external_id` is your id for the customer, unique in the Organisation, and cannot change later."""
        body: dict[str, Any] = {"name": name}
        if external_id is not None:
            body["externalId"] = external_id
        if metadata is not None:
            body["metadata"] = metadata
        return Tenant.parse(self._sai._http.json("POST", "/v1/tenants", json=body))

    def list(
        self,
        *,
        status: Optional[str] = None,
        external_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> TenantPage:
        """One page, newest first. `external_id` finds the Tenant with that id (zero or one) and
        cannot be combined with `status`."""
        params = {"status": status, "externalId": external_id, "limit": limit, "cursor": cursor}
        d = self._sai._http.json("GET", "/v1/tenants", params={k: v for k, v in params.items() if v is not None})
        return TenantPage(
            tenants=[Tenant.parse(t) for t in d.get("tenants") or []], next_cursor=d.get("nextCursor")
        )

    def get(self, tenant: TenantRef) -> Tenant:
        return Tenant.parse(self._sai._http.json("GET", f"/v1/tenants/{_q(_tenant_id(tenant))}"))

    def update(
        self,
        tenant: TenantRef,
        *,
        name: Optional[str] = None,
        metadata: Optional[dict[str, str]] = None,
        status: Optional[str] = None,
        cloud_machine_limit: Union[int, None, _Unset] = _UNSET,
        residential_proxy: Optional[bool] = None,
    ) -> Tenant:
        """`metadata` replaces the whole map. `status="disabled"` stops the Tenant's tokens and machines;
        `status="active"` brings it back.

        `cloud_machine_limit` (0 to 1000) caps the Tenant's cloud machines; `None` removes the cap.
        Lowering it deletes nothing: creates are refused until the count fits.
        `residential_proxy` is the Tenant's residential proxy switch; it has no effect yet, and
        traffic goes direct. Only the Organisation Key or an owner may set these two."""
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if metadata is not None:
            body["metadata"] = metadata
        if status is not None:
            body["status"] = status
        if cloud_machine_limit is not _UNSET:
            body["cloudMachineLimit"] = cloud_machine_limit
        if residential_proxy is not None:
            body["residentialProxy"] = residential_proxy
        return Tenant.parse(self._sai._http.json("PATCH", f"/v1/tenants/{_q(_tenant_id(tenant))}", json=body))

    def delete(self, tenant: TenantRef) -> None:
        """Disables the Tenant and revokes every enrolled machine. Cloud machines stay and hibernate:
        delete them with `tenant_machines.delete`. Its data is kept: erase it from the console."""
        self._sai._http.json("DELETE", f"/v1/tenants/{_q(_tenant_id(tenant))}")

    def create_enrollment(self, tenant: TenantRef) -> Enrollment:
        """A single-use code that enrolls one computer into the Tenant. It expires in 15 minutes."""
        return Enrollment.parse(
            self._sai._http.json("POST", f"/v1/tenants/{_q(_tenant_id(tenant))}/enrollments")
        )

    def token(self, tenant: TenantRef, *, org_id: Optional[str] = None) -> TenantToken:
        """Exchange the Organisation Key for a one-hour token that acts as the Tenant.
        `org_id` defaults to the client's `org_id` (`SAI_ORG_ID`)."""
        org = org_id or self._sai._org_id
        if not org:
            raise ValueError("No Organisation id: pass org_id= here or to Sai(), or set SAI_ORG_ID.")
        d = self._sai._http.json("POST", f"/v1/orgs/{_q(org)}/tenants/{_q(_tenant_id(tenant))}/token")
        return TenantToken.parse(d)

    def client(self, tenant: TenantRef, *, org_id: Optional[str] = None) -> Sai:
        """A client that acts as the Tenant. It exchanges a token now, and again before a request
        when the token has less than five minutes left. Uses this client's Organisation Key, so keep
        this client open while the Tenant's is in use."""
        return self._sai._with_token(_TenantTokens(self, tenant, org_id))


class _TenantTokens:
    def __init__(self, tenants: Tenants, tenant: TenantRef, org_id: Optional[str]) -> None:
        self._tenants = tenants
        self._tenant = tenant
        self._org_id = org_id
        self._lock = threading.Lock()
        self._current = tenants.token(tenant, org_id=org_id)

    def __call__(self) -> str:
        with self._lock:
            if self._current.expires_at - time.time() * 1000 < TOKEN_REFRESH_MARGIN_MS:
                self._current = self._tenants.token(self._tenant, org_id=self._org_id)
            return self._current.token


class TenantMachines:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def create(
        self,
        tenant: TenantRef,
        *,
        os: str,
        name: Optional[str] = None,
        request_id: Optional[str] = None,
        wait: bool = False,
        timeout: float = 600,
    ) -> TenantMachine:
        """Create a cloud machine for the Tenant. `os` is `windows` or `linux`; the size follows it.
        `name` (up to 64 characters) is a label you show your users.

        `request_id` (letters, digits, `_` and `-`, up to 128) makes a retry safe: the same id and
        body return the first machine, and the same id with another body raises `ConflictError`
        (`request_id_reused`). Without one, every call creates a machine.

        Returns at once with `state="provisioning"`. `wait=True` reads the machine until it is
        `ready`; it raises `SaiError` if the machine fails or is deleted, and `TimeoutError` after
        `timeout` seconds."""
        body: dict[str, Any] = {"os": os}
        if name is not None:
            body["name"] = name
        if request_id is not None:
            body["requestId"] = request_id
        tenant_id = _tenant_id(tenant)
        machine = TenantMachine.parse(
            self._sai._http.json("POST", f"/v1/tenants/{_q(tenant_id)}/machines", json=body)
        )
        if not wait:
            return machine
        deadline = time.monotonic() + timeout
        while machine.state != "ready":
            if machine.state in ("failed", "deleting"):
                raise SaiError(
                    f"Cloud machine {machine.id} is {machine.state} and will not become ready.",
                    body=machine.raw,
                )
            if time.monotonic() + _MACHINE_POLL_INTERVAL > deadline:
                raise TimeoutError(f"Cloud machine {machine.id} still {machine.state}.")
            time.sleep(_MACHINE_POLL_INTERVAL)
            try:
                machine = self.get(tenant_id, machine.id)
            except RateLimitError as e:
                time.sleep(e.retry_after or 30)
        return machine

    def list(self, tenant: TenantRef) -> list[TenantMachine]:
        """Both kinds, enrolled and cloud. A cloud machine is listed from the moment it is created."""
        d = self._sai._http.json("GET", f"/v1/tenants/{_q(_tenant_id(tenant))}/machines")
        return [TenantMachine.parse(m) for m in d.get("machines") or []]

    def get(self, tenant: TenantRef, machine_id: str) -> TenantMachine:
        return TenantMachine.parse(
            self._sai._http.json("GET", f"/v1/tenants/{_q(_tenant_id(tenant))}/machines/{_q(machine_id)}")
        )

    def delete(self, tenant: TenantRef, machine: TenantMachineRef) -> Literal["revoked", "deleting"]:
        """An enrolled machine is signed out at once (`"revoked"`); enroll it again with a new code to
        bring it back. A cloud machine is deleted with its disk (`"deleting"`), which cannot be undone;
        it leaves the list when the deletion finishes."""
        machine_id = machine.id if isinstance(machine, TenantMachine) else machine
        res = self._sai._http.request(
            "DELETE", f"/v1/tenants/{_q(_tenant_id(tenant))}/machines/{_q(machine_id)}"
        )
        return "deleting" if res.status_code == 202 else "revoked"

    def revoke(self, tenant: TenantRef, machine: TenantMachineRef) -> None:
        """`delete` without its answer. On a cloud machine it deletes the machine: use `delete`."""
        self.delete(tenant, machine)
