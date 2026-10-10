"""Parity with surface.json, the contract every language's SDK implements (AGENTS.md)."""

from __future__ import annotations

import inspect
import json
from pathlib import Path

import pytest

import sai as sdk
from sai import ControlSession, Sai, Session, Turn
from sai.types import _KINDS, RUN_STATUSES

SURFACE = json.loads((Path(__file__).resolve().parents[2] / "surface.json").read_text())


def public_methods(cls: type) -> list[str]:
    return sorted(
        n for n, v in vars(cls).items() if not n.startswith("_") and callable(v) and not isinstance(v, property)
    )


client = Sai("sapi_test")


def test_client_resources() -> None:
    attrs = sorted(n for n in vars(client) if not n.startswith("_"))
    assert attrs == sorted(SURFACE["resources"]["client"])


@pytest.mark.parametrize("resource", [r for r in SURFACE["resources"] if r != "client"])
def test_resource_methods(resource: str) -> None:
    assert public_methods(type(getattr(client, resource))) == sorted(SURFACE["resources"][resource])


@pytest.mark.parametrize("name,cls", [("Session", Session), ("Turn", Turn), ("ControlSession", ControlSession)])
def test_object_methods(name: str, cls: type) -> None:
    assert public_methods(cls) == sorted(SURFACE["objects"][name])


def test_errors() -> None:
    exported = sorted(
        n for n in sdk.__all__ if inspect.isclass(getattr(sdk, n)) and issubclass(getattr(sdk, n), sdk.SaiError)
    )
    assert exported == sorted(SURFACE["errors"])


def test_event_kinds() -> None:
    assert sorted(set(_KINDS.values()) | {"other"}) == sorted(SURFACE["event_kinds"])


def test_run_statuses() -> None:
    assert list(RUN_STATUSES) == SURFACE["run_statuses"]
