"""Python SDK for the Sai API.

- `sai.sessions`: give Sai a task on a computer and get the answer back.
- `sai.control`: drive a cloud computer yourself with Simulang.
- `sai.machines`, `sai.models`, `sai.files`, `sai.account`.
"""

from ._client import Sai
from ._errors import (
    AuthenticationError,
    BadRequestError,
    BlockError,
    ConflictError,
    ConnectionError,
    GoneError,
    LinkOnlyApprovalError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    SaiError,
    ServiceUnavailableError,
)
from ._version import __version__
from .control import ControlLease
from .machines import Machine
from .sessions import Session, Turn
from .types import (
    Account,
    Approval,
    Attachment,
    Check,
    Event,
    Evidence,
    ExecError,
    ExecResult,
    LiveView,
    Model,
    Run,
    TrajectoryStep,
    TurnResult,
    Usage,
)

__all__ = [
    "Sai",
    "Session",
    "Turn",
    "ControlLease",
    "Machine",
    "Account",
    "Approval",
    "Attachment",
    "Check",
    "Event",
    "Evidence",
    "ExecError",
    "ExecResult",
    "LiveView",
    "Model",
    "Run",
    "TrajectoryStep",
    "TurnResult",
    "Usage",
    "SaiError",
    "AuthenticationError",
    "BadRequestError",
    "BlockError",
    "ConflictError",
    "ConnectionError",
    "GoneError",
    "LinkOnlyApprovalError",
    "NotFoundError",
    "PermissionDeniedError",
    "RateLimitError",
    "ServiceUnavailableError",
    "__version__",
]
