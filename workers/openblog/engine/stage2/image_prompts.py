"""
Image Prompts - Simple, minimal prompts for Imagen generation.

Nano-banana style: short, direct, effective.
"""

import logging
import re
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)


def build_image_prompt(
    keyword: str,
    company_data: Optional[Dict[str, Any]],
    language: str = "en",
    position: str = "hero",
    visual_identity: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Build a simple image prompt.

    Args:
        keyword: Article keyword/topic
        company_data: Company info (can be None)
        language: Language code (reserved for future localization)
        position: hero, mid, or bottom
        visual_identity: Optional visual identity from Stage 1

    Returns:
        Simple prompt for Imagen
    """
    # Handle None company_data
    if company_data is None:
        company_data = {}

    # Get industry with fallback for empty string
    industry = company_data.get("industry", "") or "professional"

    # Clean keyword - remove common fluff words (only at word boundaries)
    topic = keyword
    # Remove only whole words, not partial matches
    # Note: Only remove "A" and "An" at the START to avoid breaking "A/B Testing"
    for word in ["Guide to", "Complete"]:
        topic = re.sub(rf'\b{re.escape(word)}\b\s*', '', topic, flags=re.IGNORECASE)
    # Remove articles only at the start of the string
    topic = re.sub(r'^(The|A|An)\s+', '', topic, flags=re.IGNORECASE)
    topic = topic.strip()
    if not topic:
        topic = keyword.strip() or "professional business"

    # Position-specific angle
    position_angle = {
        "hero": "wide establishing shot, overview",
        "mid": "close-up detail, hands-on action",
        "bottom": "forward-looking, success outcome",
    }.get(position, "wide shot")

    # Check if company wants text in images
    allow_text = False
    if visual_identity:
        # Only allow text if explicitly requested in company context
        # Handle None value (not just missing key)
        style_prompt = (visual_identity.get("image_style_prompt") or "").lower()
        allow_text = "with text" in style_prompt or "include text" in style_prompt

    no_text = "" if allow_text else "NO text, NO words, NO letters, NO logos, NO watermarks."

    # Build avoid elements string from visual identity
    avoid_elements = ""
    if visual_identity:
        avoid_list = visual_identity.get("avoid_in_images") or []
        # Filter out None/empty values and convert to strings
        avoid_list = [str(item) for item in avoid_list if item is not None and str(item).strip()]
        if avoid_list:
            avoid_elements = f"Avoid: {', '.join(avoid_list)}."

    # Build prompt parts and join to avoid double spaces
    def build_prompt(*parts: str) -> str:
        return " ".join(p for p in parts if p)

    # Use visual identity base prompt if available
    style_prompt = visual_identity.get("image_style_prompt") if visual_identity else None
    if style_prompt:
        # Avoid double period if base already ends with punctuation
        base = style_prompt.rstrip('.!?')
        return build_prompt(f"{base}.", f"Topic: {topic}.", f"Style: {position_angle}.", no_text, avoid_elements)

    # Simple industry-based prompt
    return build_prompt(
        f"Professional photo for {industry} blog.",
        f"Topic: {topic}.",
        f"Style: {position_angle}.",
        "Modern, clean, realistic.",
        no_text,
        avoid_elements,
        "16:9 ratio.",
    )
