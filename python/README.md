# whatsarab

Official Python client for the [WhatsArab](https://whatsarab.com) API — send WhatsApp messages on the official Meta Cloud API, upload media, manage templates, send and verify one-time codes, and verify signed webhooks.

```bash
pip install whatsarab
```

Python 3.9+.

## Quick start

```python
import os
from whatsarab import WhatsArab

wa = WhatsArab(api_key=os.environ["WHATSARAB_API_KEY"])

# Free-form text — only inside the 24-hour customer-service window
wa.messages.send(to="201234567890", text="أهلًا يا سارة! طلبك رقم ١٠٤٢٨ خرج للتوصيل.")

# An approved template — works any time
wa.messages.send(
    to="201234567890",
    template="order_shipped",
    language="ar",
    components=[{"type": "body", "parameters": [{"type": "text", "text": "10428"}]}],
)
```

Get an API key from **/app/integrations → API keys**. Keys are shown once, at creation.

## What this covers

The API-key surface: every operation under `/api` in the [OpenAPI document](https://whatsarab.com/public/openapi.json) except the legacy `/api/notify` (the dashboard's send-test, kept for integrations written before `/api/messages` — send templates with `messages.send()` instead) and `/api/salla/notifications` (called only by WhatsArab's own app inside Salla):

| | |
|---|---|
| `wa.numbers.list()` | your WhatsApp numbers — the ids every `from_` accepts |
| `wa.messages.send()` | text · template · interactive · media |
| `wa.media.upload()` / `.download()` | multipart up, raw bytes back |
| `wa.templates.list() / .create() / .edit() / .delete()` | Meta template management |
| `wa.templates.availability()` / `.copy()` | which numbers can send a template · copy one to another number's account |
| `wa.templates.upload_sample()` | the sample a media-header template needs for review |
| `wa.otp.send()` / `.verify()` | one-time codes over WhatsApp |
| `wa.events.list()` | recent webhook events, filterable by type and number |
| `wa.contacts.upsert()` / `.get()` | create or update a contact by phone (merge; opt-out one-way) · read one |
| `wa.contacts.add_tag()` / `.remove_tag()` | tag exactly as the inbox does — tag rules and tag-triggered automations included |
| `wa.webhooks.list()` / `.create()` / `.delete()` | outbound webhook subscriptions (REST hooks for n8n / Zapier / Make triggers) |
| `verify_webhook_signature()` | HMAC check for deliveries to you |

**Not covered, deliberately:** the contact list, the inbox and broadcasts are session-authenticated — they belong to a signed-in dashboard user, not to a server-side key — so there is no endpoint for this client to call. If that changes, it changes in the OpenAPI document first.

## Sending

Exactly one of `template`, `text`, `interactive` or `media` per call — checked locally, so a mistake is a `ValueError` on your machine rather than a 400 from production.

```python
# Media: upload once, then send by id
with open("invoice.pdf", "rb") as fh:
    uploaded = wa.media.upload(fh, filename="invoice.pdf", content_type="application/pdf")

wa.messages.send(
    to="201234567890",
    media={"id": uploaded["media_id"], "kind": "document", "filename": "invoice.pdf"},
)

# Interactive buttons
wa.messages.send(
    to="201234567890",
    interactive={
        "type": "button",
        "body": {"text": "تحب نأكد الطلب؟"},
        "action": {"buttons": [{"type": "reply", "reply": {"id": "yes", "title": "أكيد"}}]},
    },
)

# Multi-number workspace: pick the sender explicitly (see «Numbers» below)
wa.messages.send(to="201234567890", text="hi", from_="+201012345678")

# Check the call without spending a message
wa.messages.send(to="201234567890", template="order_shipped", dry_run=True)

# A customer who wrote with a WhatsApp username and no phone: reply to the
# user id from the webhook (`fromUserId`; `from` is an empty string then)
wa.messages.send(recipient="EG.13491208655302741918", text="أهلًا! تحت أمرك.")
```

`text`, `interactive` and `media` don't count against your WhatsArab monthly quota. Meta bills them to your WhatsApp Business Account: the first 1,000 service messages per business phone number per month are free, then the market's utility rate. They are only deliverable inside the recipient's 24-hour customer-service window. Outside it the call fails with `OUTSIDE_CSW` and you need an approved template.

The response is a `202`: Meta accepted the message. Delivery arrives later on the webhook bus, matched by `message_id` (the wamid). It also says which of your numbers sent: `from` is `{"number_id": "…", "phone_number_id": "…", "display_number": "…"}`.

## Numbers

A workspace can run several WhatsApp numbers. `wa.numbers.list()` returns them — `id`, Meta `phone_number_id`, `display_number`, `label`, `is_default`, `status`, `color` — and every send-side call takes `from_` (`from` is a Python keyword) to pick the sender, in any of three spellings you already hold:

```python
numbers = wa.numbers.list()
support = next(n for n in numbers if n["label"] == "Support")

wa.messages.send(to="201234567890", text="hi", from_=support["id"])               # our id
wa.messages.send(to="201234567890", text="hi", from_=support["phone_number_id"])  # Meta's id
wa.messages.send(to="201234567890", text="hi", from_="+201012345678")             # the phone, E.164

# Media ids belong to the number that uploaded them — upload and send from the same one
with open("invoice.pdf", "rb") as fh:
    uploaded = wa.media.upload(fh, filename="invoice.pdf", content_type="application/pdf", from_=support["id"])
wa.messages.send(to="201234567890", media={"id": uploaded["media_id"], "kind": "document"}, from_=support["id"])

# Templates live on a WhatsApp Business Account; from_ says whose
wa.templates.list(from_=support["id"])

# One-time codes too
wa.otp.send(to="201234567890", template="otp_login", from_=support["id"])
```

Omit `from_` and the platform uses the workspace default (for sends, preferring the number of the recipient's latest conversation). A value that is not one of your numbers fails with `INVALID_FROM_NUMBER`. `from_phone_number_id` — the pre-Oct-2026 spelling — still works; if both are given `from_` wins.

**Keys restricted to numbers.** An API key can be limited to specific numbers (Dashboard → Integrations → API keys). Such a key sees only those in `numbers.list()`, gets `NUMBER_NOT_ALLOWED` (403) for a `from_` outside its list, sends from the **first** number on its list when `from_` is omitted, and reads only those numbers' events.

## Media-header templates

A template whose header is an image, a video or a PDF is reviewed with a sample of that header. Upload it first, from the number the template will live on, and put the handle in the header:

```python
with open("weekend.jpg", "rb") as fh:
    sample = wa.templates.upload_sample(fh, format="IMAGE", filename="weekend.jpg", content_type="image/jpeg", from_=support["id"])
wa.templates.create(
    name="weekend_offer",
    language="ar",
    category="MARKETING",
    from_=support["id"],
    components=[
        {"type": "HEADER", "format": "IMAGE", "example": {"header_handle": [sample["handle"]]}},
        {"type": "BODY", "text": "عرض نهاية الأسبوع"},
    ],
)
```

`format` is `IMAGE` (JPEG/PNG), `VIDEO` (MP4) or `DOCUMENT` (PDF), checked against the file's bytes (`UNSUPPORTED_SAMPLE`, 415, otherwise); 16MB max; `full` scope. The handle is for review only — the real header media is chosen on each send.

## Templates across numbers

A template is approved on one WhatsApp Business Account; numbers on another account do not have it. Ask before you send from a number you have not used it with, and copy it over when one is missing:

```python
row = wa.templates.availability(names=["order_confirmation"], language="ar")[0]
# row["verdict"]: "available" | "not_approved" (+ status) | "language_missing" (+ languages) | "missing" | "unknown"
# row["availableOn"]: number ids that can send it · row["lackingOn"]: [{id, label, displayNumber, verdict, ...}]

if row["verdict"] != "available":
    target = next((n for n in row["lackingOn"] if n["verdict"] == "missing"), None)
    if target:
        copy = wa.templates.copy(name="order_confirmation", language="ar", from_=row["availableOn"][0], to=target["id"])
        # copy["status"] == "PENDING" — Meta reviews the copy like any new template
```

`names` takes `name` or `name:language` (up to 300 per call; a comma-separated string works too); `scope` is `"all"` (default) or a list of your number ids. A number whose account Meta could not be asked about lands in neither list, so an outage never reads as «missing». `copy` needs the `full` scope and is refused with `SAME_ACCOUNT`, `TEMPLATE_EXISTS`, `TEMPLATE_NOT_FOUND`, or `TEMPLATE_COPY_NEEDS_MEDIA` (a media header or carousel needs a fresh sample, so create that one on the target with `templates.create`).

## One-time codes

```python
sent = wa.otp.send(to="201234567890", template="otp_login", language="ar")
result = wa.otp.verify(request_id=sent["request_id"], code="123456")

if result["verified"]:
    ...
```

The code is generated, hashed and checked on our side — it is never returned to you.

## Events

```python
recent = wa.events.list()                                   # newest 50
inbound = wa.events.list(100, type="inbound")
of_support = wa.events.list(number_id="+201012345678")      # one number's events
```

Every event carries `ts`, `type`, `meta_message_id`, the flattened webhook payload (`from`, `text`, `status`, `recipient_id`…) and `number` — the workspace number it belongs to (the one that received an inbound, or sent the message a status reports on), or `None` when none can be attributed. `number_id` takes the same three forms as `from_`.

## Contacts

```python
c = wa.contacts.upsert(
    phone="+201000000001",
    name="Sara",
    custom_fields={"city": "Cairo"},   # merged; None removes a key
    tags=["lead"],                     # added, never replacing
)
c["created"]                           # True when the phone was new

wa.contacts.add_tag("+201000000001", "vip")     # contact + conversation, automations included
wa.contacts.remove_tag("+201000000001", "vip")
again = wa.contacts.get("+201000000001")
```

`upsert`, `add_tag` and `remove_tag` need a `send` key (a tag can start a tag-triggered flow); `get` works with a `read` key. `opted_in=True` records consent only on a contact that is not opted out — nothing in the API lifts an opt-out.

## Webhook subscriptions

```python
sub = wa.webhooks.create(
    label="n8n: new leads",
    url="https://hooks.example.com/whatsarab",
    events=["message.received", "tag.added"],
)
# sub["secret"] is returned only here — keep it for verify_webhook_signature()
wa.webhooks.delete(sub["id"])
```

Needs a `full` key. The URL must be public https (private and metadata IP addresses are refused).

## Errors

Every failure — including a refused connection or a timeout — is a `WhatsArabError`, so one `except` covers the lot. Branch on `.code`, which is stable; the message is for humans and may be reworded.

```python
from whatsarab import WhatsArabError

try:
    wa.messages.send(to="201234567890", text="hi")
except WhatsArabError as err:
    if err.code == "OUTSIDE_CSW":
        send_template_instead()
    elif err.code == "OVER_QUOTA":
        queue_for_next_month()
    elif err.code == "NUMBER_NOT_ALLOWED":
        use_allowed_number()          # key restricted to other numbers
    elif err.code == "SEND_OUTCOME_UNKNOWN":
        # Meta never answered: the message may have gone out. Never resend
        # automatically — check the message.sent webhook / GET /api/events first.
        check_status_before_resending()
    elif err.code in ("TIMEOUT", "NETWORK_ERROR"):
        retry_later()
    else:
        raise
```

`err.request_id` is worth logging — quote it in a support ticket and we can find the exact request.

## Verifying webhooks

Deliveries to your endpoint carry `X-Whatsarab-Timestamp` and `X-Whatsarab-Signature: sha256=<hex>`, computed over `f"{timestamp}.{raw_body}"` with your subscription secret.

```python
from fastapi import FastAPI, HTTPException, Request
from whatsarab import verify_webhook_signature

app = FastAPI()

@app.post("/webhooks/whatsarab")
async def hook(request: Request):
    body = await request.body()          # the raw bytes
    ok = verify_webhook_signature(
        secret=os.environ["WHATSARAB_WEBHOOK_SECRET"],
        raw_body=body,
        signature_header=request.headers.get("x-whatsarab-signature"),
        timestamp_header=request.headers.get("x-whatsarab-timestamp"),
    )
    if not ok:
        raise HTTPException(status_code=401)
    ...
```

**Pass the raw body.** A body that has been parsed and re-serialized will not match — that is the single commonest way this check is got wrong. The comparison is constant-time, and deliveries more than five minutes old are rejected (`tolerance_seconds=0` turns that off).

## Options

```python
WhatsArab(
    api_key="…",                       # required
    base_url="https://whatsarab.com",  # override for staging or self-hosted
    timeout=30.0,                      # seconds; None disables
)
```

The client holds an `httpx.Client`. Close it when you are done, or use it as a context manager:

```python
with WhatsArab(api_key="…") as wa:
    wa.messages.send(to="201234567890", text="hi")
```

## Changelog

**0.7.0** — For integrations that connect and poll: `me()` (who the key is — workspace, scope, number list, and the plan's webhook slots; the connection test), `contacts.list()` (newest first, cursor pages, `since=`), `tags.list()` (every tag in use, most used first) and `webhooks.samples(event)` (up to 3 recent real events in the delivery envelope, for trigger set-up). `me()`, `contacts.list()` and `tags.list()` take a `read` or `send` key; `webhooks.samples()` a `full` key. Nothing else changes.

**0.6.0** — Contacts and webhook subscriptions for integrations (n8n, Zapier, Make, your own backend): `contacts.upsert()` (create or update by phone — merges, opt-out one-way) / `.get()` / `.add_tag()` / `.remove_tag()` (tagging exactly as the inbox does, tag rules and tag-triggered automations included), and `webhooks.list() / .create() / .delete()` (REST-hook subscriptions; the signing secret is returned once, by `create`). Contact writes need a `send` key, `contacts.get()` a `read` or `send` key, webhooks a `full` key. Nothing else changes.

**0.5.0** — `templates.upload_sample()`: the header sample a media-header template needs, so image / video / PDF templates can be created through the SDK end to end. Nothing else changes.

**0.4.0** — `templates.availability()` (which of your numbers can send each template, and why not) and `templates.copy()` (submit a template to another number's account). Nothing else changes.

**0.3.0** — `numbers.list()`; `from_` on `messages.send`, `otp.send`, `media.upload`, `templates.list/create/edit/delete`; `from` echoed on send, OTP and upload results; `events.list()` takes `type=` and `number_id=` and every event carries `number`. Nothing that worked stops working.

**0.2.0** — `messages.send` takes `recipient` (a WhatsApp user id) as the alternative to `to`.

## Links

- [Docs](https://whatsarab.com/docs) · [OpenAPI](https://whatsarab.com/public/openapi.json) · [Guides](https://whatsarab.com/how-to) · [Support](https://whatsarab.com/support)

MIT.
