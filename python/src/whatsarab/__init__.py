"""whatsarab — the official Python client for the WhatsArab API.

    from whatsarab import WhatsArab

    wa = WhatsArab(api_key=os.environ["WHATSARAB_API_KEY"])
    wa.messages.send(to="201234567890", text="أهلًا! طلبك في الطريق.")

    sent = wa.otp.send(to="201234567890", template="otp_login")
    wa.otp.verify(request_id=sent["request_id"], code="123456")

SCOPE: this client covers the API-KEY surface and nothing else — every
operation under /api in the published OpenAPI document except the legacy
``/api/notify`` (the dashboard's own send-test, kept for integrations written
before ``/api/messages``; new code sends templates through ``messages.send``)
and ``/api/salla/notifications`` (called only by WhatsArab's own app inside
Salla). tests/unit/sdk-parity.test.ts in the main repository keeps this list
in sync with the API catalog.
Contacts are covered as far as an API key reaches: upsert by phone, read one,
add / remove a tag (``contacts``), plus outbound webhook subscriptions
(``webhooks``) for REST-hook triggers. The contact LIST, the inbox and
broadcasts stay session-authenticated (they belong to the dashboard, not to a
server-side key), so an SDK cannot offer them without inventing endpoints.
"""

from .client import (
    DEFAULT_BASE_URL,
    WhatsArab,
    WhatsArabError,
)
from .webhooks import verify_webhook_signature

__all__ = [
    "WhatsArab",
    "WhatsArabError",
    "verify_webhook_signature",
    "DEFAULT_BASE_URL",
    "__version__",
]

__version__ = "0.7.0"
