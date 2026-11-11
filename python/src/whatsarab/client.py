"""HTTP client and resources.

httpx rather than requests: it gives us HTTP/2, a real timeout object, and the
same call shape for a future async client without a second implementation.
"""

from __future__ import annotations

from typing import Any, BinaryIO, Dict, List, Mapping, Optional, Sequence, Union
from urllib.parse import quote

import httpx

DEFAULT_BASE_URL = "https://whatsarab.com"
DEFAULT_TIMEOUT = 30.0

MediaKind = str  # "image" | "video" | "audio" | "document" | "sticker"
TemplateCategory = str  # "AUTHENTICATION" | "MARKETING" | "UTILITY" | "SERVICE"


class WhatsArabError(Exception):
    """Every failure, transport included, so a caller writes one except clause.

    Branch on ``code`` — it is the platform's stable error code
    (``OUTSIDE_CSW``, ``OVER_QUOTA``, ``INVALID_PHONE``…). ``args[0]`` /
    ``str(err)`` is the human message and may be reworded between releases.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int,
        code: str,
        request_id: Optional[str] = None,
        meta_error: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id
        self.meta_error = meta_error

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"WhatsArabError(code={self.code!r}, status={self.status}, message={str(self)!r})"


class WhatsArab:
    """Client for the WhatsArab API.

    Args:
        api_key: your key (``whap_<prefix>_<secret>``), from /app/integrations.
        base_url: backend origin. Defaults to the hosted platform.
        timeout: seconds before a request is abandoned. ``None`` disables.
        transport: an ``httpx`` transport, for tests or a custom proxy.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: Optional[float] = DEFAULT_TIMEOUT,
        transport: Optional[httpx.BaseTransport] = None,
        client: Optional[httpx.Client] = None,
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required")

        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.Client(
            base_url=self.base_url,
            timeout=timeout,
            transport=transport,
            headers={"X-API-Key": api_key},
        )
        # A caller-supplied client may not carry the key; set it either way so
        # the header is never silently missing.
        self._client.headers["X-API-Key"] = api_key

        self.numbers = _Numbers(self)
        self.messages = _Messages(self)
        self.media = _Media(self)
        self.templates = _Templates(self)
        self.otp = _Otp(self)
        self.events = _Events(self)
        self.contacts = _Contacts(self)
        self.tags = _Tags(self)
        self.webhooks = _Webhooks(self)

    def me(self) -> Dict[str, Any]:
        """Who this key is: ``workspace``, ``plan``, ``key`` (prefix, name,
        scope, number_ids) and ``webhooks`` (``used`` / ``limit``; a ``None``
        limit is unlimited). Use it as an integration's connection test — it
        says before a trigger fails that it needs a ``full`` key or a free
        webhook slot."""
        return self.request("GET", "/api/me")

    # ── plumbing ────────────────────────────────────────────────────

    def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        files: Any = None,
        params: Optional[Mapping[str, Any]] = None,
        raw: bool = False,
        envelope_wanted: bool = False,
    ) -> Any:
        try:
            response = self._client.request(method, path, json=json, files=files, params=params)
        except httpx.TimeoutException as exc:
            raise WhatsArabError(
                str(exc) or f"Timed out talking to {self.base_url}",
                status=0,
                code="TIMEOUT",
            ) from exc
        except httpx.HTTPError as exc:
            raise WhatsArabError(
                str(exc) or f"Could not reach {self.base_url}",
                status=0,
                code="NETWORK_ERROR",
            ) from exc

        if raw:
            if response.status_code >= 400:
                raise self._error_from(response)
            return response.content

        try:
            envelope = response.json()
        except ValueError:
            envelope = None

        # The envelope is the authority, not the status line: the platform can
        # answer 200 with success=false, and a client that trusted the status
        # would hand back None and call it a send.
        if response.status_code >= 400 or not isinstance(envelope, dict) or not envelope.get("success"):
            raise self._error_from(response, envelope)
        # A paged list carries its cursor beside ``data``.
        if envelope_wanted:
            return envelope
        return envelope.get("data")

    @staticmethod
    def _error_from(response: httpx.Response, envelope: Any = None) -> WhatsArabError:
        if envelope is None:
            try:
                envelope = response.json()
            except ValueError:
                envelope = None
        error = envelope.get("error") if isinstance(envelope, dict) else None
        error = error if isinstance(error, dict) else {}
        return WhatsArabError(
            error.get("message") or response.reason_phrase or "Request failed",
            status=response.status_code,
            code=error.get("code") or f"HTTP_{response.status_code}",
            request_id=envelope.get("request_id") if isinstance(envelope, dict) else None,
            meta_error=error.get("meta_error"),
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "WhatsArab":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()


def _from_params(from_: Optional[str]) -> Optional[Dict[str, str]]:
    return {"from": from_} if from_ is not None else None


class _Numbers:
    def __init__(self, client: WhatsArab) -> None:
        self._client = client

    def list(self) -> List[Dict[str, Any]]:
        """Your workspace's WhatsApp numbers — the ids every ``from_`` accepts.

        Each row: ``id``, ``phone_number_id``, ``display_number``, ``label``,
        ``is_default``, ``status``, ``color``. Never credentials. Read it once
        to learn them; the same objects come back as ``from`` on every send
        response and as ``number`` on every event. An API key restricted to
        specific numbers sees only those — this list is exactly what that key
        may send from.
        """
        return self._client.request("GET", "/api/numbers")


class _Messages:
    def __init__(self, client: WhatsArab) -> None:
        self._client = client

    def send(
        self,
        *,
        to: Optional[str] = None,
        recipient: Optional[str] = None,
        template: Optional[str] = None,
        text: Optional[str] = None,
        interactive: Optional[Mapping[str, Any]] = None,
        media: Optional[Mapping[str, Any]] = None,
        language: Optional[str] = None,
        components: Optional[Sequence[Mapping[str, Any]]] = None,
        from_: Optional[str] = None,
        from_phone_number_id: Optional[str] = None,
        dry_run: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Send one message. Returns the 202 body, including the wamid and
        ``from`` — the number that actually sent.

        Exactly one of ``template`` / ``text`` / ``interactive`` / ``media``.
        Python cannot express that in the signature the way a TypeScript union
        can, so it is checked here — a local ValueError beats a round trip that
        comes back 400.

        ``text``, ``interactive`` and ``media`` don't count against your
        WhatsArab quota; Meta bills them to your WhatsApp Business Account (the
        first 1,000 service messages per business phone number per month are
        free, then the market's utility rate). They are deliverable only inside
        the recipient's 24-hour customer-service window; outside it the call
        fails with ``OUTSIDE_CSW``.

        Address the customer with exactly one of ``to`` (their phone) or
        ``recipient`` (their WhatsApp user id — the ``fromUserId`` of a
        ``message.received`` webhook, for a customer who writes with a username
        and whose phone Meta has not shared; ``from`` is then an empty string).

        ``from_`` picks the sending number on a multi-number workspace: the
        number ``id`` from ``numbers.list()``, its Meta ``phone_number_id``, or
        its phone in E.164. Omitted → the workspace default (preferring the
        number of the recipient's latest conversation). An API key restricted
        to specific numbers gets ``NUMBER_NOT_ALLOWED`` for a number outside
        its list and, with ``from_`` omitted, sends from the first number on
        it. ``from_phone_number_id`` is the pre-Oct-2026 spelling (Meta id
        only) and still works; if both are given, ``from_`` wins.
        """
        if (to is None) == (recipient is None):
            raise ValueError("exactly one of to / recipient is required")
        kinds = {
            "template": template,
            "text": text,
            "interactive": interactive,
            "media": media,
        }
        present = [name for name, value in kinds.items() if value is not None]
        if len(present) != 1:
            raise ValueError(
                "exactly one of template / text / interactive / media is required, got: "
                + (", ".join(present) if present else "none")
            )

        payload: Dict[str, Any] = {"to": to} if to is not None else {"recipient": recipient}
        payload[present[0]] = kinds[present[0]]
        if language is not None:
            payload["language"] = language
        if components is not None:
            payload["components"] = list(components)
        # ``from_`` wins over the legacy spelling — resolved here, so the
        # documented precedence does not rest on the server alone.
        if from_ is not None:
            payload["from"] = from_
        elif from_phone_number_id is not None:
            payload["from_phone_number_id"] = from_phone_number_id
        if dry_run is not None:
            payload["dry_run"] = dry_run
        return self._client.request("POST", "/api/messages", json=payload)


class _Media:
    def __init__(self, client: WhatsArab) -> None:
        self._client = client

    def upload(
        self,
        file: Union[bytes, BinaryIO],
        *,
        filename: Optional[str] = None,
        content_type: Optional[str] = None,
        from_: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Upload a file and get back a ``media_id`` for ``messages.send``.

        Meta ties a media id to the number that uploaded it, so pass the same
        ``from_`` here as on the send that will use it. The response says
        which number it went through (``from``).
        """
        return self._client.request(
            "POST",
            "/api/media",
            files={"file": (filename, file, content_type)},
            params=_from_params(from_),
        )

    def download(self, media_id: str) -> bytes:
        """Download a media file by id. Returns the raw bytes."""
        return self._client.request("GET", f"/api/media/{quote(str(media_id), safe='')}", raw=True)


class _Templates:
    def __init__(self, client: WhatsArab) -> None:
        self._client = client

    def list(self, *, from_: Optional[str] = None) -> List[Any]:
        """Templates of one account. Templates live on a WhatsApp Business
        Account and a workspace's numbers may sit on different accounts —
        ``from_`` names a number on the account you mean; omitted, the default.
        """
        return self._client.request("GET", "/api/templates", params=_from_params(from_))

    def create(
        self,
        *,
        name: str,
        language: str,
        category: TemplateCategory,
        components: Sequence[Mapping[str, Any]],
        from_: Optional[str] = None,
    ) -> Any:
        payload: Dict[str, Any] = {
            "name": name,
            "language": language,
            "category": category,
            "components": list(components),
        }
        if from_ is not None:
            payload["from"] = from_
        return self._client.request("POST", "/api/templates", json=payload)

    def edit(self, template_id: str, *, from_: Optional[str] = None, **fields: Any) -> Any:
        """Edit by Meta template id — note that create/delete key off the NAME."""
        return self._client.request(
            "PATCH",
            f"/api/templates/{quote(str(template_id), safe='')}",
            json=fields,
            params=_from_params(from_),
        )

    def delete(self, name: str, *, from_: Optional[str] = None) -> Any:
        return self._client.request(
            "DELETE", f"/api/templates/{quote(str(name), safe='')}", params=_from_params(from_)
        )

    def availability(
        self,
        *,
        names: Union[str, Sequence[str]],
        language: Optional[str] = None,
        scope: Union[str, Sequence[str], None] = None,
    ) -> List[Dict[str, Any]]:
        """Which of your numbers can send each named template — one row per
        name, in the order asked. ``read`` scope.

        ``names``: each ``name`` or ``name:language`` (at most 300); a
        comma-separated string works too. ``language`` is the default for bare
        names. ``scope``: ``"all"`` (the default: every active number) or your
        number ids from ``numbers.list()``.

        Each row: ``name``, ``language``, ``availableOn`` (number ids),
        ``lackingOn`` (``{id, label, displayNumber, verdict, status?,
        languages?}``) and the row's ``verdict``: ``available``,
        ``not_approved`` (with ``status``), ``language_missing`` (with
        ``languages``), ``missing``, or ``unknown`` when an account could not be
        asked — such a number is in neither list.
        """
        # A bare string is ONE value — ",".join("abc") would send "a,b,c".
        params: Dict[str, str] = {"names": names if isinstance(names, str) else ",".join(names)}
        if language is not None:
            params["language"] = language
        if scope is not None:
            params["scope"] = scope if isinstance(scope, str) else ",".join(scope)
        return self._client.request("GET", "/api/templates/availability", params=params)

    def upload_sample(
        self,
        file: Union[bytes, BinaryIO],
        *,
        format: str,
        filename: Optional[str] = None,
        content_type: Optional[str] = None,
        from_: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Upload the sample a media-header template needs for Meta's review.

        ``format`` is the header format: ``"IMAGE"`` (JPEG/PNG), ``"VIDEO"``
        (MP4) or ``"DOCUMENT"`` (PDF). Returns ``{"handle", "mime"}``; put the
        handle in the header of ``templates.create``::

            sample = wa.templates.upload_sample(open("promo.jpg", "rb"), format="IMAGE")
            wa.templates.create(name="promo", language="ar", category="MARKETING", components=[
                {"type": "HEADER", "format": "IMAGE", "example": {"header_handle": [sample["handle"]]}},
                {"type": "BODY", "text": "عرض اليوم"},
            ])

        Upload from the same number (``from_``) the template will be created
        on. ``full`` scope.
        """
        params: Dict[str, str] = {"format": format}
        if from_ is not None:
            params["from"] = from_
        return self._client.request(
            "POST",
            "/api/templates/sample-upload",
            files={"file": (filename, file, content_type)},
            params=params,
        )

    def copy(self, *, name: str, language: str, from_: str, to: str) -> Dict[str, Any]:
        """Copy a template from one number's account to another's. Both sides
        take the same forms as ``from_`` (number id, Meta phone_number_id, or
        E.164). Meta reviews the copy, so it comes back ``PENDING``; refused
        with ``SAME_ACCOUNT``, ``TEMPLATE_EXISTS``, ``TEMPLATE_NOT_FOUND`` or
        ``TEMPLATE_COPY_NEEDS_MEDIA``. ``full`` scope.
        """
        return self._client.request(
            "POST",
            "/api/templates/copy",
            json={"name": name, "language": language, "from": from_, "to": to},
        )


class _Otp:
    def __init__(self, client: WhatsArab) -> None:
        self._client = client

    def send(
        self,
        *,
        to: str,
        template: str,
        language: Optional[str] = None,
        code_length: Optional[int] = None,
        ttl_seconds: Optional[int] = None,
        max_attempts: Optional[int] = None,
        from_: Optional[str] = None,
        from_phone_number_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send a one-time code. ``from_`` picks the sending number (see
        ``messages.send``); the response's ``from`` says which one sent.

        ``code_length`` 4–8 digits, ``ttl_seconds`` 60–5400, ``max_attempts``
        1–10. A value outside its range is clamped by the server, not
        rejected; ``expires_in`` in the response is the TTL actually used."""
        payload: Dict[str, Any] = {"to": to, "template": template}
        for key, value in (
            ("language", language),
            ("code_length", code_length),
            ("ttl_seconds", ttl_seconds),
            ("max_attempts", max_attempts),
        ):
            if value is not None:
                payload[key] = value
        # Same precedence as messages.send: ``from_`` wins over the legacy name.
        if from_ is not None:
            payload["from"] = from_
        elif from_phone_number_id is not None:
            payload["from_phone_number_id"] = from_phone_number_id
        return self._client.request("POST", "/api/otp/send", json=payload)

    def verify(self, *, request_id: str, code: str) -> Dict[str, Any]:
        return self._client.request(
            "POST", "/api/otp/verify", json={"request_id": request_id, "code": code}
        )


class _Events:
    def __init__(self, client: WhatsArab) -> None:
        self._client = client

    def list(
        self,
        limit: int = 50,
        *,
        type: Optional[str] = None,
        number_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Recent webhook events, newest first.

        Every event carries ``number`` — the workspace number it belongs to
        (``{number_id, phone_number_id, display_number}``, or ``None`` when
        none can be attributed). ``number_id`` keeps only one number's events
        (the number ``id``, its Meta ``phone_number_id`` or its E.164 phone —
        the same forms ``from_`` takes); ``type`` is one of ``status``,
        ``inbound``, ``value_error``, ``template_status_update``,
        ``inbound_unhandled``.
        """
        # The documented 1–500 bound, applied here as the server does.
        params: Dict[str, Any] = {"limit": min(500, max(1, int(limit)))}
        if type is not None:
            params["type"] = type
        if number_id is not None:
            params["number_id"] = number_id
        return self._client.request("GET", "/api/events", params=params)


class _Contacts:
    def __init__(self, client: WhatsArab) -> None:
        self._client = client

    def upsert(
        self,
        *,
        phone: str,
        name: Optional[str] = None,
        custom_fields: Optional[Mapping[str, Any]] = None,
        tags: Optional[Sequence[str]] = None,
        opted_in: Optional[bool] = None,
        from_: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create the contact if ``phone`` is new, otherwise update it.

        An update MERGES: an argument you leave out keeps its value,
        ``custom_fields`` merge key by key (a ``None`` value removes that key),
        and ``tags`` are added, never replacing — each one applied exactly like
        ``add_tag``. Opt-out is one-way: ``opted_in=False`` opts the contact
        out; ``opted_in=True`` records consent only on a contact that is not
        opted out and never lifts a block. ``from_`` names the number whose
        audience the contact joins. The result carries ``created`` (``True``
        when the phone was new). Needs a ``send`` key.
        """
        payload: Dict[str, Any] = {"phone": phone}
        if name is not None:
            payload["name"] = name
        if custom_fields is not None:
            payload["custom_fields"] = dict(custom_fields)
        if tags is not None:
            payload["tags"] = list(tags)
        if opted_in is not None:
            payload["opted_in"] = opted_in
        if from_ is not None:
            payload["from"] = from_
        return self._client.request("POST", "/api/contacts", json=payload)

    def list(
        self,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        since: Optional[str] = None,
    ) -> Dict[str, Any]:
        """One page of contacts, newest first: ``{"contacts": [...],
        "next_cursor": str | None}``. Pass ``next_cursor`` back as ``cursor``
        until it is ``None``; a contact created while you page never shifts or
        repeats a row. ``since`` (ISO-8601 with an offset) keeps only contacts
        created at or after it. ``limit`` is 1–100, default 50."""
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = int(limit)
        if cursor is not None:
            params["cursor"] = cursor
        if since is not None:
            params["since"] = since
        env = self._client.request("GET", "/api/contacts", params=params, envelope_wanted=True)
        return {"contacts": env.get("data") or [], "next_cursor": env.get("next_cursor")}

    def get(self, phone: str) -> Dict[str, Any]:
        """One contact by phone (E.164, with or without «+»). Raises
        ``WhatsArabError`` with ``code == "NOT_FOUND"`` when unknown."""
        return self._client.request("GET", f"/api/contacts/{quote(str(phone), safe='')}")

    def add_tag(self, phone: str, tag: str, *, from_: Optional[str] = None) -> Dict[str, Any]:
        """Tag a contact exactly as an agent would in the inbox.

        The tag lands on the contact and on the customer's conversation (the
        one on ``from_``, else their latest), where the ad-signal rule, the
        ``tag.added`` webhook and tag-triggered sequences and flows run.
        If the contact has no matching conversation, the response's
        ``conversation_id`` is ``None`` and the tag is saved on the contact
        only. Safe to repeat. Needs a ``send`` key.
        """
        payload: Dict[str, Any] = {"tag": tag}
        if from_ is not None:
            payload["from"] = from_
        return self._client.request("POST", f"/api/contacts/{quote(str(phone), safe='')}/tags", json=payload)

    def remove_tag(self, phone: str, tag: str) -> Dict[str, Any]:
        """Remove a tag from the contact and its conversations. Idempotent.
        Needs a ``send`` key."""
        return self._client.request(
            "DELETE", f"/api/contacts/{quote(str(phone), safe='')}/tags/{quote(str(tag), safe='')}"
        )


class _Tags:
    def __init__(self, client: WhatsArab) -> None:
        self._client = client

    def list(self) -> List[Dict[str, Any]]:
        """Every tag in use (on contacts or conversations), most used first:
        ``[{"tag": ..., "count": ...}]`` — for tag pickers."""
        return self._client.request("GET", "/api/tags")


class _Webhooks:
    def __init__(self, client: WhatsArab) -> None:
        self._client = client

    def samples(self, event: str, *, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """Up to 3 recent real events of one type, in the delivery envelope
        (``event``, ``deliveryId``, ``webhookId`` = ``None``, ``timestamp``,
        ``data``) — sample data for setting up a trigger. Empty when none
        happened in 30 days. Needs a ``full`` key. ``limit`` is 1–3 (default
        3); any other value falls back to 3 on the server, without an error."""
        params: Dict[str, Any] = {"event": event}
        if limit is not None:
            params["limit"] = int(limit)
        return self._client.request("GET", "/api/webhooks/samples", params=params)

    def list(self) -> List[Dict[str, Any]]:
        """Your outbound webhook subscriptions — never their secrets. Needs a
        ``full`` key."""
        return self._client.request("GET", "/api/webhooks")

    def create(
        self,
        *,
        label: str,
        url: str,
        events: Sequence[str],
        number_ids: Optional[Sequence[str]] = None,
    ) -> Dict[str, Any]:
        """Subscribe — the REST-hook «subscribe» step of an n8n / Zapier / Make
        trigger. ``url`` must be public https. The result's ``secret``
        (``whsec_…``) is returned only here: store it and check deliveries with
        ``verify_webhook_signature``. ``number_ids`` limits deliveries to those
        numbers (omitted = every number; a key restricted to numbers defaults
        to its own). Needs a ``full`` key.
        """
        payload: Dict[str, Any] = {"label": label, "url": url, "events": list(events)}
        if number_ids is not None:
            payload["number_ids"] = list(number_ids)
        return self._client.request("POST", "/api/webhooks", json=payload)

    def delete(self, webhook_id: str) -> Dict[str, Any]:
        """Unsubscribe. Raises ``WhatsArabError`` (``NOT_FOUND``) for an
        unknown id. Needs a ``full`` key."""
        return self._client.request("DELETE", f"/api/webhooks/{quote(str(webhook_id), safe='')}")
