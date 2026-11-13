"""Python SDK for the Sai API.

- `sai.sessions`: give Sai a task on a computer and get the answer back.
- `sai.learn`, `sai.judge`: turn recorded turns into Simulang code, repair it, judge turns.
- `sai.control`: drive a computer yourself with Simulang.
- `sai.machines`, `sai.models`, `sai.files`, `sai.account`, `sai.auth`.
- `sai.tenants`, `sai.tenant_machines`: your customers under an Organisation (an Organisation Key).
- `sai.usage`: what the Organisation is charged, per Tenant and per session (an Organisation Key).
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
from .tenants import Enrollment, Tenant, TenantMachine, TenantPage, TenantToken
from .usage import AuthInfo, OrgUsage, SessionSpend, SessionSpendPage, TenantUsage, UsageBucket
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
    LearnIteration,
    LearnParameter,
    LearnReset,
    LearnResult,
    LearnRollout,
    LearnRun,
    LearnTestResult,
    LiveView,
    Model,
    SessionSummary,
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
    "Tenant",
    "TenantPage",
    "TenantMachine",
    "Enrollment",
    "TenantToken",
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
    "LearnIteration",
    "LearnParameter",
    "LearnReset",
    "LearnResult",
    "LearnRollout",
    "LearnRun",
    "LearnTestResult",
    "LiveView",
    "Model",
    "SessionSummary",
    "AuthInfo",
    "OrgUsage",
    "SessionSpend",
    "SessionSpendPage",
    "TenantUsage",
    "UsageBucket",
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
