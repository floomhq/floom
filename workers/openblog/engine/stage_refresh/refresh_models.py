"""
Stage Refresh: Content Freshener Models

Pydantic models for refresh stage input/output.
"""

from typing import Dict, Any, List
from pydantic import BaseModel, Field


class RefreshFix(BaseModel):
    """A single content refresh fix."""
    field: str = Field(..., description="Field name to fix (e.g., section_01_content)")
    find: str = Field(..., description="Exact text to find and replace")
    replace: str = Field(..., description="Updated text with current information")
    reason: str = Field(default="", description="Source citation for the update")


class RefreshInput(BaseModel):
    """Input schema for Stage Refresh."""
    article: Dict[str, Any] = Field(..., description="Article dict to refresh (any JSON structure)")
    enabled: bool = Field(default=True, description="Whether to run refresh")


class RefreshOutput(BaseModel):
    """Output schema for Stage Refresh."""
    article: Dict[str, Any] = Field(..., description="Refreshed article dict")
    fixes_applied: int = Field(default=0, description="Number of fixes applied")
    fixes: List[RefreshFix] = Field(default_factory=list, description="List of applied fixes")
    ai_calls: int = Field(default=0, description="Number of Gemini API calls")
    skipped: bool = Field(default=False, description="True if stage was disabled")
