"""Verification for outbound webhooks from WhatsArab."""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Callable, Optional, Union


def verify_webhook_signature(
    *,
    secret: str,
    raw_body: Union[str, bytes],
    signature_header: Optional[str],
    timestamp_header: Optional[str],
    tolerance_seconds: int = 300,
    now: Optional[Callable[[], float]] = None,
) -> bool:
    """Return True if a delivery genuinely came from WhatsArab.

    Deliveries carry ``X-Whatsarab-Timestamp`` and
    ``X-Whatsarab-Signature: sha256=<hex>``, computed over
    ``f"{timestamp}.{raw_body}"`` with the subscription's secret.

    Pass the RAW body — the exact bytes received. A body that has been parsed
    and re-serialized will not match, and that is the single commonest way this
    check is got wrong::

        @app.post("/webhooks/whatsarab")
        async def hook(request: Request):
            body = await request.body()
            ok = verify_webhook_signature(
                secret=os.environ["WHATSARAB_WEBHOOK_SECRET"],
                raw_body=body,
                signature_header=request.headers.get("x-whatsarab-signature"),
                timestamp_header=request.headers.get("x-whatsarab-timestamp"),
            )
            if not ok:
                raise HTTPException(401)

    Set ``tolerance_seconds=0`` to skip the freshness check (replay protection
    off). Returns False rather than raising on anything malformed, so a bad
    header cannot turn into a 500 on your webhook route.
    """
    if not secret or not signature_header or not timestamp_header:
        return False

    if tolerance_seconds > 0:
        try:
            sent_at = float(timestamp_header)
        except (TypeError, ValueError):
            return False
        current = now() if now is not None else time.time()
        if abs(current - sent_at) > tolerance_seconds:
            return False

    provided = signature_header
    if provided.startswith("sha256="):
        provided = provided[len("sha256=") :]

    body = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
    signed = timestamp_header.encode("utf-8") + b"." + body
    expected = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()

    return hmac.compare_digest(expected, provided)
