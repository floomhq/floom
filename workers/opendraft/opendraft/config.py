"""Configuration management for OpenDraft v2."""

import os
from dataclasses import dataclass, field
from typing import Optional
from dotenv import load_dotenv

load_dotenv()


@dataclass
class Config:
    """Application configuration loaded from environment."""

    # API Keys
    google_api_key: str = field(default_factory=lambda: os.getenv("GOOGLE_API_KEY", ""))

    # Model
    gemini_model: str = field(default_factory=lambda: os.getenv("GEMINI_MODEL", "gemini-3-pro-preview"))

    # Citation settings
    citation_style: str = field(default_factory=lambda: os.getenv("CITATION_STYLE", "apa").upper())
    draft_language: str = field(default_factory=lambda: os.getenv("DRAFT_LANGUAGE", "english"))

    # Optional API keys
    semantic_scholar_api_key: str = field(default_factory=lambda: os.getenv("SEMANTIC_SCHOLAR_API_KEY", ""))

    # Logging
    log_level: str = field(default_factory=lambda: os.getenv("LOG_LEVEL", "INFO"))

    # Citation verification (V3 feature)
    enable_citation_verification: bool = field(
        default_factory=lambda: os.getenv("ENABLE_CITATION_VERIFICATION", "true").lower() == "true"
    )

    @property
    def citation_style_full(self) -> str:
        mapping = {"APA": "APA 7th", "IEEE": "IEEE", "CHICAGO": "Chicago", "MLA": "MLA"}
        return mapping.get(self.citation_style, "APA 7th")

    def validate(self) -> None:
        if not self.google_api_key:
            raise ValueError("GOOGLE_API_KEY is required. Set it in .env or environment.")


# Singleton
_config: Optional[Config] = None


def get_config() -> Config:
    global _config
    if _config is None:
        _config = Config()
    return _config
