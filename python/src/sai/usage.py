"""Who a key acts as, and what an Organisation is charged.

Maps to `GET /v1/agents/auth`, `GET /v1/orgs/{orgId}/usage` and `GET /v1/orgs/{orgId}/usage/sessions`.
"""

from __future__ import annotations

import urllib.parse
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Optional, Union

if TYPE_CHECKING:
    from ._client import Sai
    from .tenants import Tenant


@dataclass
class AuthInfo:
    """Who the key or token acts as."""

    user_id: str
    auth_type: str
    """`apiKey` for a key, `firebase` for a signed-in session or a Tenant token."""
    tenant_id: Optional[str]
    """Set when the credential is a Tenant token."""
    org_id: Optional[str]
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> AuthInfo:
        return cls(
            user_id=d.get("userId") or "",
            auth_type=d.get("authType") or "",
            tenant_id=d.get("tenantId"),
            org_id=d.get("orgId"),
            raw=d,
        )


@dataclass
class TenantUsage:
    """One Tenant's spend in an Organisation usage report."""

    tenant_id: str
    name: Optional[str]
    external_id: Optional[str]
    cost_cents: float
    by_category: dict[str, dict[str, float]]
    """By kind of spend, such as `token` for AI calls and `compute` for computer time: `{"token": {"cost_cents": 905}}`."""


@dataclass
class UsageBucket:
    """One period of an Organisation usage report, or the whole range (`totals`)."""

    bucket: Optional[str]
    """The period, e.g. `2026-10`; None on `totals`."""
    cost_cents: float
    by_tenant: dict[str, TenantUsage]
    """Keyed by Tenant id. Spend tied to no Tenant is in `cost_cents` only."""

    @classmethod
    def parse(cls, d: dict[str, Any]) -> UsageBucket:
        by_tenant = {}
        for key, t in (d.get("byTenant") or {}).items():
            by_tenant[key] = TenantUsage(
                tenant_id=t.get("tenantId") or key,
                name=t.get("name"),
                external_id=t.get("externalId"),
                cost_cents=t.get("costCents") or 0,
                by_category={
                    cat: {"cost_cents": (c or {}).get("costCents") or 0}
                    for cat, c in (t.get("byCategory") or {}).items()
                },
            )
        return cls(bucket=d.get("bucket"), cost_cents=d.get("costCents") or 0, by_tenant=by_tenant)


@dataclass
class OrgUsage:
    """What an Organisation is charged, per Tenant."""

    granularity: str
    from_: str
    to: str
    totals: UsageBucket
    buckets: list[UsageBucket]
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> OrgUsage:
        return cls(
            granularity=d.get("granularity") or "",
            from_=d.get("from") or "",
            to=d.get("to") or "",
            totals=UsageBucket.parse(d.get("totals") or {}),
            buckets=[UsageBucket.parse(b) for b in d.get("buckets") or []],
            raw=d,
        )


@dataclass
class SessionSpend:
    """What one of a Tenant's sessions spent on AI calls in a date range."""

    session_id: str
    title: Optional[str]
    cost_usd: float
    """In US dollars, not rounded to cents."""
    model_calls: int
    first_day: str
    """The UTC days (`YYYY-MM-DD`) the session's spend was first and last counted, over its whole life."""
    last_day: str


@dataclass
class SessionSpendPage:
    """One page of `sai.usage.sessions()`. A page can be empty and still have a `next_cursor`."""

    sessions: list[SessionSpend]
    next_cursor: Optional[str]
    """Pass as `cursor` for the next page; None on the last page."""
    data_through: Optional[str]
    """ISO 8601: the figures are complete up to this time. None when unknown."""
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def parse(cls, d: dict[str, Any]) -> SessionSpendPage:
        return cls(
            sessions=[
                SessionSpend(
                    session_id=s.get("sessionId") or "",
                    title=s.get("title") or None,
                    cost_usd=s.get("costUsd") or 0,
                    model_calls=s.get("modelCalls") or 0,
                    first_day=s.get("firstDay") or "",
                    last_day=s.get("lastDay") or "",
                )
                for s in d.get("sessions") or []
            ],
            next_cursor=d.get("nextCursor"),
            data_through=d.get("dataThrough"),
            raw=d,
        )


class Auth:
    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def check(self) -> AuthInfo:
        """Who the key or token acts as. Raises `AuthenticationError` for a missing or revoked key."""
        return AuthInfo.parse(self._sai._http.json("GET", "/v1/agents/auth"))


class Usage:
    """What an Organisation is charged, per Tenant and per session. Takes an Organisation Key."""

    def __init__(self, sai: Sai) -> None:
        self._sai = sai

    def get(
        self,
        *,
        granularity: Optional[str] = None,
        from_: Optional[str] = None,
        to: Optional[str] = None,
        org_id: Optional[str] = None,
    ) -> OrgUsage:
        """What the Organisation is charged, in total and per Tenant, per `granularity` (`hour`, `day`
        or `month`; default `day`) from `from_` to `to`: `2026-10` for a month, `2026-10-15` for a day,
        `2026-10-15T09` for an hour. Each defaults to a range that ends now."""
        params = {"granularity": granularity, "from": from_, "to": to}
        d = self._sai._http.json(
            "GET",
            f"/v1/orgs/{_q(self._org(org_id))}/usage",
            params={k: v for k, v in params.items() if v is not None},
        )
        return OrgUsage.parse(d)

    def sessions(
        self,
        tenant: Union[Tenant, str],
        *,
        from_: str,
        to: str,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        org_id: Optional[str] = None,
    ) -> SessionSpendPage:
        """One page of what each of a Tenant's sessions spent on AI calls, oldest first, for the UTC
        days `from_` to `to` (`YYYY-MM-DD`, both included, at most 93 days). Keep paging with
        `next_cursor` until it is None: a page can be empty and not be the last."""
        tenant_id = tenant if isinstance(tenant, str) else tenant.id
        params = {"tenantId": tenant_id, "from": from_, "to": to, "limit": limit, "cursor": cursor}
        d = self._sai._http.json(
            "GET",
            f"/v1/orgs/{_q(self._org(org_id))}/usage/sessions",
            params={k: v for k, v in params.items() if v is not None},
        )
        return SessionSpendPage.parse(d)

    def _org(self, org_id: Optional[str]) -> str:
        org = org_id or self._sai._org_id
        if not org:
            raise ValueError("No Organisation id: pass org_id= here or to Sai(), or set SAI_ORG_ID.")
        return org


def _q(s: str) -> str:
    return urllib.parse.quote(s, safe="")
