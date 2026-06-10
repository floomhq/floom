"""Channel integrations package (Slack, WhatsApp, shortlinks).

Import the routers here and include them in the main FastAPI app.
"""

from channels.slack import slack_router
from channels.shortlink import shortlink_router
from channels.whatsapp import whatsapp_router

__all__ = ["slack_router", "shortlink_router", "whatsapp_router"]
