from typing import Any, Dict, List, Optional
from pydantic import BaseModel
from enum import Enum


class WorkerInput(BaseModel):
    name: str
    label: str
    type: str
    required: bool = False
    placeholder: Optional[str] = None
    options: Optional[List[str]] = None
    default: Optional[Any] = None


class WorkerOutput(BaseModel):
    name: str
    label: str
    type: str


class WorkerTrigger(BaseModel):
    type: str
    cron: Optional[str] = None
    every: Optional[str] = None
    at: Optional[str] = None


class WorkerRuntime(BaseModel):
    type: str
    entrypoint: str
    runner: str = "local"


class WorkerApprovalConfig(BaseModel):
    required: bool = False
    label: Optional[str] = None


class WorkerConfig(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    trigger: WorkerTrigger
    runtime: WorkerRuntime
    inputs: List[WorkerInput] = []
    secrets: List[str] = []
    outputs: List[WorkerOutput] = []
    approvals: WorkerApprovalConfig = WorkerApprovalConfig()


class RunCreate(BaseModel):
    inputs: Dict[str, Any]
    trigger_source: str = "manual"


class RunResponse(BaseModel):
    run_id: str
    status: str


class ApproveRequest(BaseModel):
    pass


class RejectRequest(BaseModel):
    reason: Optional[str] = None


class SecretStatus(str, Enum):
    SET = "set"
    MISSING = "missing"
