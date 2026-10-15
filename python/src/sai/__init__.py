"""Python SDK for the Sai API.

- `sai.sessions`: give Sai a task on a computer and get the answer back.
- `sai.learn`, `sai.judge`: turn recorded turns into Simulang code, repair it, judge turns.
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
    SpendCapReachedError,
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
    CriterionResult,
    Evaluation,
    Event,
    Evidence,
    ExecError,
    ExecResult,
    Judgement,
    LearnParameter,
    LearnResult,
    LiveView,
    Model,
    TurnRecord,
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
    "CriterionResult",
    "Evaluation",
    "Event",
    "Evidence",
    "ExecError",
    "ExecResult",
    "Judgement",
    "LearnParameter",
    "LearnResult",
    "LiveView",
    "Model",
    "TurnRecord",
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
    "SpendCapReachedError",
    "__version__",
]
