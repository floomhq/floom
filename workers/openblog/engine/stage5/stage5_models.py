"""
Stage 5: Internal Links - Data Models

Pydantic models for input/output.
"""

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field


class LinkCandidate(BaseModel):
    """A candidate URL for internal linking."""
    url: str = Field(..., description="Full URL")
    title: str = Field(..., description="Page title or extracted from slug")
    source: str = Field(default="sitemap", description="sitemap | sibling")


class LinkEmbedding(BaseModel):
    """A single link embedding instruction from Gemini."""
    field: str = Field(..., description="Field name (e.g., section_02_content)")
    find: str = Field(..., description="Exact text to find")
    replace: str = Field(..., description="Replacement with <a> tag")


class Stage5Input(BaseModel):
    """
    Input for Stage 5: Internal Links.

    Combines Stage 1 sitemap + Stage 4 article.
    """
    # From Stage 1
    sitemap_blog_urls: List[str] = Field(default_factory=list, description="Blog URLs from sitemap")
    sitemap_resource_urls: List[str] = Field(default_factory=list, description="Resource URLs from sitemap")
    sitemap_tool_urls: List[str] = Field(default_factory=list, description="Tool/calculator URLs from sitemap")
    sitemap_product_urls: List[str] = Field(default_factory=list, description="Product URLs from sitemap")
    sitemap_service_urls: List[str] = Field(default_factory=list, description="Service URLs from sitemap")
    batch_siblings: List[Dict[str, str]] = Field(default_factory=list, description="Other articles in batch [{keyword, slug, href}]")
    company_url: str = Field(default="", description="Base company URL")

    # From Stage 4
    article: Dict[str, Any] = Field(..., description="Article content from Stage 4")
    current_href: str = Field(default="", description="Current article's href to exclude")


class Stage5Output(BaseModel):
    """
    Output from Stage 5: Internal Links.
    """
    article: Dict[str, Any] = Field(..., description="Article with internal links embedded")
    links_added: int = Field(default=0, description="Number of links added")
    links_report: Dict[str, Any] = Field(default_factory=dict, description="Detailed report")
