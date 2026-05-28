"""
Shared constants for openblog-neo pipeline.
"""

import os

# Gemini model with URL Context + Google Search + JSON output support
# Can be overridden via GEMINI_MODEL environment variable
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")

# Sitemap crawler limit
MAX_SITEMAP_URLS = int(os.getenv("MAX_SITEMAP_URLS", "10000"))

# Gemini timeout settings (in seconds)
# Longer timeout for operations with URL Context/Google Search (AFC can make up to 10 external calls)
GEMINI_TIMEOUT_GROUNDING = int(os.getenv("GEMINI_TIMEOUT_GROUNDING", "300"))  # 5 minutes for grounded calls
GEMINI_TIMEOUT_DEFAULT = int(os.getenv("GEMINI_TIMEOUT_DEFAULT", "120"))  # 2 minutes for simple calls
# Extra long timeout for voice enhancement (fetches multiple blog URLs and does deep analysis)
GEMINI_TIMEOUT_VOICE_ENHANCEMENT = int(os.getenv("GEMINI_TIMEOUT_VOICE_ENHANCEMENT", "420"))  # 7 minutes
