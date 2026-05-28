"""Data fetching module for Phase 4.

Provides functions to fetch datasets from:
- SDMX providers (Eurostat, UN, IMF, World Bank, etc.)
- Our World in Data (OWID)
"""

from .fetch import DataFetcher

__all__ = ["DataFetcher"]
