
"""Send optional course availability notifications to Discord."""

import logging
import os

import requests


logger = logging.getLogger(__name__)


def send_discord_notification(message: str) -> bool:
    """Send a Discord message if a webhook is configured."""
    webhook_url = os.getenv("DISCORD_WEBHOOK_URL", "").strip()

    if not webhook_url:
        return False

    try:
        response = requests.post(
            webhook_url,
            json={"content": message},
            timeout=10,
        )
        response.raise_for_status()
        return True

    except requests.RequestException as exc:
        logger.warning(
            "Discord notification failed: %s",
            type(exc).__name__,
        )
        return False
