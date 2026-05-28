"""ElevenLabs text-to-speech integration for digest audio."""

import os
import logging
from pathlib import Path
from typing import Optional

import requests

logger = logging.getLogger(__name__)

# Default voice IDs (ElevenLabs public voices)
VOICES = {
    "rachel": "21m00Tcm4TlvDq8ikWAM",  # Rachel - warm, clear female
    "adam": "pNInz6obpgDQGcFmaJgB",  # Adam - clear male
    "josh": "TxGEqnHWrfWFTfGW9XjX",  # Josh - deep male
    "elli": "MF3mGyEYCl7XYWbV9V6O",  # Elli - young female
    "bella": "EXAVITQu4vr4xnSDxMaL",  # Bella - warm female
}

DEFAULT_VOICE = "rachel"


class ElevenLabsClient:
    """Client for ElevenLabs text-to-speech API."""

    BASE_URL = "https://api.elevenlabs.io/v1"

    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize ElevenLabs client.

        Args:
            api_key: ElevenLabs API key. If not provided, reads from
                     ELEVENLABS_API_KEY environment variable.
        """
        self.api_key = api_key or os.environ.get("ELEVENLABS_API_KEY")
        if not self.api_key:
            raise ValueError(
                "ElevenLabs API key required. Set ELEVENLABS_API_KEY environment "
                "variable or pass api_key parameter."
            )

    def text_to_speech(
        self,
        text: str,
        output_path: Path,
        voice: str = DEFAULT_VOICE,
        model: str = "eleven_multilingual_v2",
        stability: float = 0.5,
        similarity_boost: float = 0.75,
    ) -> Path:
        """
        Convert text to speech and save as MP3.

        Args:
            text: Text to convert (max ~5000 characters recommended)
            output_path: Path to save MP3 file
            voice: Voice name (rachel, adam, josh, elli, bella) or voice ID
            model: ElevenLabs model ID
            stability: Voice stability (0-1)
            similarity_boost: Voice similarity boost (0-1)

        Returns:
            Path to saved MP3 file
        """
        # Resolve voice name to ID
        voice_id = VOICES.get(voice.lower(), voice)

        url = f"{self.BASE_URL}/text-to-speech/{voice_id}"

        headers = {
            "Accept": "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": self.api_key,
        }

        payload = {
            "text": text,
            "model_id": model,
            "voice_settings": {
                "stability": stability,
                "similarity_boost": similarity_boost,
            },
        }

        logger.info("Generating audio with ElevenLabs (%s chars)", len(text))

        response = requests.post(url, json=payload, headers=headers, timeout=120)

        if response.status_code != 200:
            error_msg = response.text[:500]
            logger.error("ElevenLabs API error: %s - %s", response.status_code, error_msg)
            raise RuntimeError(f"ElevenLabs API error: {response.status_code}")

        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(response.content)

        logger.info("Audio saved: %s", output_path)
        return output_path

    def get_voices(self) -> list[dict]:
        """Get list of available voices."""
        url = f"{self.BASE_URL}/voices"
        headers = {"xi-api-key": self.api_key}

        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()

        data = response.json()
        return data.get("voices", [])

    def get_usage(self) -> dict:
        """Get current usage/subscription info."""
        url = f"{self.BASE_URL}/user/subscription"
        headers = {"xi-api-key": self.api_key}

        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()

        return response.json()


def generate_audio(
    text: str,
    output_path: Path,
    voice: str = DEFAULT_VOICE,
    api_key: Optional[str] = None,
) -> Path:
    """
    Convenience function to generate audio from text.

    Args:
        text: Text to convert to speech
        output_path: Path to save MP3
        voice: Voice name or ID
        api_key: Optional API key (uses env var if not provided)

    Returns:
        Path to generated MP3 file
    """
    client = ElevenLabsClient(api_key=api_key)
    return client.text_to_speech(text, output_path, voice=voice)
