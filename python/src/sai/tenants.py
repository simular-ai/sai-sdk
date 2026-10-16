"""Tenants: your customers, under an Organisation. Every call here takes an Organisation Key.

Maps to `/v1/tenants` and `POST /v1/orgs/{orgId}/tenants/{tenantId}/token`.
"""

from __future__ import annotations

import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Optional, Union

if TYPE_CHECKING:
    from ._client import Sai

TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
"""`tenants.client()` exchanges again when its token has less than this left."""


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
    online: bool
    """True when the machine reported in the last 3 minutes."""
    last_seen: Optional[int]
    runtime_version: Optional[str]
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> TenantMachine:
        return cls(
            id=d["machineId"],
            name=d.get("name"),
            platform=d.get("platform"),
            status=d.get("status", ""),
            online=bool(d.get("online")),
            last_seen=d.get("lastSeen"),
            runtime_version=d.get("runtimeVersion"),
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
    ) -> Tenant:
        """`metadata` replaces the whole map. `status="disabled"` stops the Tenant's tokens and machines;
        `status="active"` brings it back."""
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if metadata is not None:
            body["metadata"] = metadata
        if status is not None:
            body["status"] = status
        return Tenant.parse(self._sai._http.json("PATCH", f"/v1/tenants/{_q(_tenant_id(tenant))}", json=body))

    def delete(self, tenant: TenantRef) -> None:
        """Disables the Tenant and revokes every machine. Its data is kept: erase it from the console."""
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

    def list(self, tenant: TenantRef) -> list[TenantMachine]:
        d = self._sai._http.json("GET", f"/v1/tenants/{_q(_tenant_id(tenant))}/machines")
        return [TenantMachine.parse(m) for m in d.get("machines") or []]

    def get(self, tenant: TenantRef, machine_id: str) -> TenantMachine:
        return TenantMachine.parse(
            self._sai._http.json("GET", f"/v1/tenants/{_q(_tenant_id(tenant))}/machines/{_q(machine_id)}")
        )

    def revoke(self, tenant: TenantRef, machine: TenantMachineRef) -> None:
        """Signs the machine out at once. To bring it back, enroll it again with a new code."""
        machine_id = machine.id if isinstance(machine, TenantMachine) else machine
        self._sai._http.json("DELETE", f"/v1/tenants/{_q(_tenant_id(tenant))}/machines/{_q(machine_id)}")
