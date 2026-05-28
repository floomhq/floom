"""
Shared Gemini Client for openblog-neo pipeline.

Unified client using Gemini 3 with:
- URL Context (fetch and analyze web pages)
- Google Search (grounded search results)
- Structured JSON output
- Automatic retry with exponential backoff

All stages use this client for consistency.
"""

import asyncio
import json
import logging
import os
import re
import random
from typing import Dict, Any, Optional, Union, List, Tuple
from pathlib import Path

import httpx

from dotenv import load_dotenv

from .constants import GEMINI_MODEL, GEMINI_TIMEOUT_GROUNDING, GEMINI_TIMEOUT_DEFAULT

# Default retry configuration
DEFAULT_MAX_RETRIES = 4  # Increased for grounding operations that may take longer
DEFAULT_BASE_DELAY = 1.0  # seconds
DEFAULT_MAX_DELAY = 30.0  # seconds

# Load .env from openblog-neo root (override=True ensures .env takes precedence over shell env vars)
load_dotenv(Path(__file__).parent.parent / ".env", override=True)

logger = logging.getLogger(__name__)


class GeminiClient:
    """
    Shared Gemini client with URL Context + Google Search + JSON output.

    Usage:
        client = GeminiClient()

        # With grounding (URL Context + Google Search)
        result = await client.generate(
            prompt="Analyze https://example.com and tell me about the company",
            use_url_context=True,
            use_google_search=True,
            json_output=True,
        )

        # Without grounding (faster, for surgical operations)
        result = await client.generate(
            prompt="Fix this JSON...",
            use_url_context=False,
            use_google_search=False,
            json_output=True,
        )
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        base_delay: float = DEFAULT_BASE_DELAY,
        max_delay: float = DEFAULT_MAX_DELAY,
    ):
        """
        Initialize Gemini client.

        Args:
            api_key: Gemini API key. Falls back to GEMINI_API_KEY env var.
            max_retries: Maximum number of retries for transient failures (default: 3)
            base_delay: Base delay in seconds for exponential backoff (default: 1.0)
            max_delay: Maximum delay between retries in seconds (default: 30.0)
        """
        self.api_key = api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not self.api_key:
            raise ValueError(
                "No Gemini API key provided. Set GEMINI_API_KEY environment variable "
                "or pass api_key parameter."
            )

        self.max_retries = max_retries
        self.base_delay = base_delay
        self.max_delay = max_delay

        self._client = None
        self._types = None
        self._initialized = False

    def _ensure_initialized(self):
        """Lazy initialization of google-genai client."""
        if self._initialized:
            return

        try:
            from google import genai
            from google.genai import types
            self._genai = genai
            self._types = types
            self._client = genai.Client(api_key=self.api_key)
            self._initialized = True
            logger.debug(f"GeminiClient initialized with model: {GEMINI_MODEL}")
        except ImportError:
            raise ImportError("google-genai not installed. Run: pip install google-genai")

    async def generate(
        self,
        prompt: str,
        system_instruction: Optional[str] = None,
        use_url_context: bool = True,
        use_google_search: bool = True,
        json_output: bool = True,
        extract_sources: bool = False,
        temperature: float = 0.3,
        max_tokens: int = 8192,
        timeout: Optional[int] = None,
    ) -> Union[Dict[str, Any], str]:
        """
        Generate content using Gemini 3.

        Args:
            prompt: The prompt to send to Gemini
            system_instruction: Optional system instruction (persistent context, role definition)
            use_url_context: Enable URL Context tool for fetching web pages
            use_google_search: Enable Google Search tool for grounding
            json_output: Request structured JSON output
            extract_sources: Extract real URLs from grounding metadata and add to result
            temperature: Generation temperature (0-1)
            max_tokens: Maximum output tokens
            timeout: Request timeout in seconds (auto-selected based on grounding tools if None)

        Returns:
            Dict if json_output=True, otherwise raw string.
            If extract_sources=True and json_output=True, adds "_grounding_sources" key.
        """
        self._ensure_initialized()

        # Build tools list
        tools = []
        if use_url_context:
            tools.append(self._types.Tool(url_context=self._types.UrlContext()))
        if use_google_search:
            tools.append(self._types.Tool(google_search=self._types.GoogleSearch()))

        # Auto-select timeout based on grounding tools (AFC makes external calls)
        if timeout is None:
            timeout = GEMINI_TIMEOUT_GROUNDING if tools else GEMINI_TIMEOUT_DEFAULT
            logger.debug(f"Auto-selected timeout: {timeout}s (grounding={bool(tools)})")

        # Build config
        config = self._types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=temperature,
            max_output_tokens=max_tokens,
            tools=tools if tools else None,
            response_mime_type="application/json" if json_output else None,
        )

        logger.debug(f"Generating with model={GEMINI_MODEL}, tools={len(tools)}, json={json_output}")

        last_error = None
        for attempt in range(self.max_retries + 1):
            try:
                # Run in thread pool for async
                response = await asyncio.wait_for(
                    asyncio.to_thread(
                        self._client.models.generate_content,
                        model=GEMINI_MODEL,
                        contents=prompt,
                        config=config,
                    ),
                    timeout=timeout,
                )

                text = response.text.strip()

                if json_output:
                    result = self._parse_json(text)

                    # Extract real sources from grounding metadata
                    if extract_sources and use_google_search:
                        grounding_sources = await self._extract_grounding_sources(response)
                        if grounding_sources:
                            result["_grounding_sources"] = grounding_sources
                            logger.info(f"Extracted {len(grounding_sources)} verified sources from grounding")

                    return result
                else:
                    return text

            except asyncio.TimeoutError:
                last_error = asyncio.TimeoutError(f"Request timed out after {timeout}s")
                logger.warning(f"Gemini request timed out (attempt {attempt + 1}/{self.max_retries + 1})")
            except Exception as e:
                last_error = e
                # Check if error is retryable (rate limit, server errors, transient network issues)
                error_str = str(e).lower()
                is_retryable = any(x in error_str for x in [
                    'rate limit', '429', '500', '502', '503', '504',
                    'overloaded', 'quota', 'temporarily unavailable',
                    'connection', 'timeout', 'resource exhausted'
                ])

                if not is_retryable or attempt >= self.max_retries:
                    logger.error(f"Gemini generation failed: {e}")
                    raise

                logger.warning(f"Gemini request failed (attempt {attempt + 1}/{self.max_retries + 1}): {e}")

            # Exponential backoff with jitter
            if attempt < self.max_retries:
                delay = min(self.base_delay * (2 ** attempt), self.max_delay)
                jitter = random.uniform(0, delay * 0.1)
                await asyncio.sleep(delay + jitter)
                logger.info(f"Retrying in {delay + jitter:.1f}s...")

        # All retries exhausted
        logger.error(f"Gemini request failed after {self.max_retries + 1} attempts")
        raise last_error

    def _parse_json(self, text: str) -> Dict[str, Any]:
        """
        Parse JSON from Gemini response, handling markdown code blocks.

        Args:
            text: Raw response text

        Returns:
            Parsed JSON dictionary

        Raises:
            ValueError: If JSON cannot be parsed
        """
        # Extract JSON from markdown if present
        if "```json" in text:
            parts = text.split("```json")
            if len(parts) > 1:
                inner_parts = parts[1].split("```")
                text = inner_parts[0].strip()
            # else: no valid ```json block, continue with original text
        elif "```" in text:
            parts = text.split("```")
            if len(parts) > 1:
                text = parts[1].split("```")[0].strip()
            # else: no valid ``` block, continue with original text

        # Find JSON object start
        if not text.startswith("{"):
            match = re.search(r'\{', text)
            if match:
                text = text[match.start():]
            else:
                raise ValueError(f"Could not find JSON in response: {text[:200]}")

        # Try parsing directly first - handles strings with braces correctly
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        # Fallback: Extract balanced JSON object (may have trailing content)
        # Note: This simple brace counting can break on strings containing braces,
        # but we've already tried the full parse above which handles that correctly
        brace_count = 0
        end_idx = 0
        in_string = False
        escape_next = False

        for i, char in enumerate(text):
            if escape_next:
                escape_next = False
                continue
            if char == '\\' and in_string:
                escape_next = True
                continue
            if char == '"' and not escape_next:
                in_string = not in_string
                continue
            if in_string:
                continue

            if char == '{':
                brace_count += 1
            elif char == '}':
                brace_count -= 1
                if brace_count == 0:
                    end_idx = i + 1
                    break

        if end_idx > 0:
            text = text[:end_idx]

        return json.loads(text)

    async def _extract_grounding_sources(self, response) -> List[Dict[str, str]]:
        """
        Extract real URLs from Gemini grounding metadata.

        Follows Vertex AI redirect URLs to get actual source URLs.
        Validates each URL returns HTTP 200-299 before including.

        Args:
            response: Gemini API response object

        Returns:
            List of dicts with 'url' and 'title' keys (only validated URLs)
        """
        try:
            if not hasattr(response, 'candidates') or not response.candidates:
                logger.debug("No candidates in response")
                return []

            candidate = response.candidates[0]
            if not hasattr(candidate, 'grounding_metadata') or not candidate.grounding_metadata:
                logger.debug("No grounding_metadata in candidate")
                return []

            gm = candidate.grounding_metadata
            if not hasattr(gm, 'grounding_chunks') or not gm.grounding_chunks:
                logger.debug("No grounding_chunks in metadata")
                return []

            total_chunks = len(gm.grounding_chunks)
            logger.debug(f"Found {total_chunks} grounding chunks")

            sources = []
            seen_urls = set()
            skipped_invalid = 0

            async with httpx.AsyncClient(
                timeout=10.0,
                follow_redirects=True,
                limits=httpx.Limits(max_connections=10, max_keepalive_connections=5)
            ) as client:
                for chunk in gm.grounding_chunks[:10]:  # Check up to 10 to get 5 valid
                    if not hasattr(chunk, 'web') or not chunk.web or not chunk.web.uri:
                        continue

                    redirect_url = chunk.web.uri
                    title = chunk.web.title if hasattr(chunk.web, 'title') and chunk.web.title else ""

                    # Follow redirect to get real URL and validate status
                    try:
                        resp = await client.get(redirect_url)
                        real_url = str(resp.url)

                        # Only include URLs that return 200-299 (success)
                        if resp.status_code < 200 or resp.status_code >= 300:
                            logger.debug(f"Skipping grounding source (HTTP {resp.status_code}): {real_url[:60]}...")
                            skipped_invalid += 1
                            continue

                    except Exception as e:
                        # If request fails, skip this source
                        logger.debug(f"Skipping grounding source (request failed): {redirect_url[:60]}... - {e}")
                        skipped_invalid += 1
                        continue

                    # Skip duplicates and Vertex redirect URLs (shouldn't happen now)
                    if real_url in seen_urls:
                        continue
                    if 'vertexaisearch.cloud.google.com' in real_url:
                        continue

                    seen_urls.add(real_url)
                    sources.append({
                        "url": real_url,
                        "title": title or self._extract_domain(real_url),
                    })

                    # Stop after 5 valid sources
                    if len(sources) >= 5:
                        break

            if skipped_invalid > 0:
                logger.info(f"Grounding sources: {len(sources)} valid, {skipped_invalid} skipped (invalid HTTP status)")

            return sources

        except Exception as e:
            logger.warning(f"Failed to extract grounding sources: {e}")
            return []

    def _extract_domain(self, url: str) -> str:
        """Extract domain from URL for fallback title."""
        try:
            from urllib.parse import urlparse
            parsed = urlparse(url)
            return parsed.netloc.replace('www.', '')
        except Exception:
            return "Source"

    def format_sources(self, sources: List[Dict[str, str]]) -> str:
        """
        Format extracted sources as a string for article Sources field.

        Args:
            sources: List of dicts with 'url' and 'title' keys

        Returns:
            Formatted string like "[1]: URL - title\n[2]: URL - title"
        """
        if not sources:
            return ""

        lines = []
        for i, source in enumerate(sources, 1):
            lines.append(f"[{i}]: {source['url']} - {source['title']}")
        return "\n".join(lines)

    async def generate_with_schema(
        self,
        prompt: str,
        response_schema: Any,
        use_url_context: bool = True,
        use_google_search: bool = True,
        extract_sources: bool = False,
        temperature: float = 0.3,
        timeout: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Generate content with a specific response schema.

        Args:
            prompt: The prompt to send
            response_schema: Pydantic model or dict schema for response
            use_url_context: Enable URL Context tool
            use_google_search: Enable Google Search tool
            extract_sources: Extract real URLs from grounding metadata
            temperature: Generation temperature
            timeout: Request timeout in seconds (auto-selected based on grounding tools if None)

        Returns:
            Dict matching the response schema.
            If extract_sources=True, adds "_grounding_sources" key with real URLs.
        """
        self._ensure_initialized()

        # Build tools
        tools = []
        if use_url_context:
            tools.append(self._types.Tool(url_context=self._types.UrlContext()))
        if use_google_search:
            tools.append(self._types.Tool(google_search=self._types.GoogleSearch()))

        # Auto-select timeout based on grounding tools (AFC makes external calls)
        if timeout is None:
            timeout = GEMINI_TIMEOUT_GROUNDING if tools else GEMINI_TIMEOUT_DEFAULT
            logger.debug(f"Auto-selected timeout: {timeout}s (grounding={bool(tools)})")

        config = self._types.GenerateContentConfig(
            temperature=temperature,
            max_output_tokens=8192,
            tools=tools if tools else None,
            response_mime_type="application/json",
            response_schema=response_schema,
        )

        last_error = None
        for attempt in range(self.max_retries + 1):
            try:
                response = await asyncio.wait_for(
                    asyncio.to_thread(
                        self._client.models.generate_content,
                        model=GEMINI_MODEL,
                        contents=prompt,
                        config=config,
                    ),
                    timeout=timeout,
                )

                result = self._parse_json(response.text.strip())

                # Extract real sources from grounding metadata
                if extract_sources and use_google_search:
                    grounding_sources = await self._extract_grounding_sources(response)
                    if grounding_sources:
                        result["_grounding_sources"] = grounding_sources
                        logger.info(f"Extracted {len(grounding_sources)} verified sources from grounding")

                return result

            except json.JSONDecodeError as e:
                # Schema doesn't guarantee valid JSON - let caller handle gracefully
                logger.debug(f"Gemini schema response parse issue: {e}")
                raise
            except asyncio.TimeoutError:
                last_error = asyncio.TimeoutError(f"Request timed out after {timeout}s")
                logger.warning(f"Gemini schema request timed out (attempt {attempt + 1}/{self.max_retries + 1})")
            except Exception as e:
                last_error = e
                # Check if error is retryable
                error_str = str(e).lower()
                is_retryable = any(x in error_str for x in [
                    'rate limit', '429', '500', '502', '503', '504',
                    'overloaded', 'quota', 'temporarily unavailable',
                    'connection', 'timeout', 'resource exhausted'
                ])

                if not is_retryable or attempt >= self.max_retries:
                    logger.error(f"Gemini schema generation failed: {e}")
                    raise

                logger.warning(f"Gemini schema request failed (attempt {attempt + 1}/{self.max_retries + 1}): {e}")

            # Exponential backoff with jitter
            if attempt < self.max_retries:
                delay = min(self.base_delay * (2 ** attempt), self.max_delay)
                jitter = random.uniform(0, delay * 0.1)
                await asyncio.sleep(delay + jitter)

        # All retries exhausted
        logger.error(f"Gemini schema request failed after {self.max_retries + 1} attempts")
        raise last_error

    def __repr__(self) -> str:
        return f"GeminiClient(model={GEMINI_MODEL}, initialized={self._initialized})"
