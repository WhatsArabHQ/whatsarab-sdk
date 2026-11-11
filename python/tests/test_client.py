"""Behavioural tests for the Python client.

Every test drives a real httpx.MockTransport, so what is asserted is the request
the SDK actually built — the URL, the method, the key header, the body — plus
how it turns a response into a value or an exception. No mocking of our own
methods, which would only prove the test matches the test.
"""

import hashlib
import hmac
import json

import httpx
import pytest

from whatsarab import DEFAULT_BASE_URL, WhatsArab, WhatsArabError, verify_webhook_signature


def make_client(handler, **kwargs):
    transport = httpx.MockTransport(handler)
    return WhatsArab(api_key="whap_test_secret", transport=transport, **kwargs)


def envelope(data, status=200):
    return httpx.Response(status, json={"success": True, "data": data})


# ── requests ────────────────────────────────────────────────────────


def test_attaches_key_and_builds_url():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["method"] = request.method
        seen["key"] = request.headers.get("x-api-key")
        seen["body"] = json.loads(request.content)
        return envelope({"message_id": "wamid.X"})

    client = make_client(handler)
    client.messages.send(to="201234567890", text="مرحبا")

    assert seen["url"] == f"{DEFAULT_BASE_URL}/api/messages"
    assert seen["method"] == "POST"
    assert seen["key"] == "whap_test_secret"
    assert seen["body"] == {"to": "201234567890", "text": "مرحبا"}


def test_strips_trailing_slashes_from_base_url():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return envelope([])

    client = make_client(handler, base_url="https://staging.example.com///")
    client.templates.list()

    assert seen["url"] == "https://staging.example.com/api/templates"


def test_unwraps_the_envelope():
    client = make_client(lambda r: envelope({"request_id": "req_1", "expires_in": 300}))
    result = client.otp.send(to="201234567890", template="otp_login")
    assert result["request_id"] == "req_1"
    assert result["expires_in"] == 300


def test_error_envelope_becomes_whatsaraberror():
    def handler(request):
        return httpx.Response(
            400,
            json={
                "success": False,
                "request_id": "req_err",
                "error": {"code": "OUTSIDE_CSW", "message": "Outside the 24-hour window."},
            },
        )

    client = make_client(handler)
    with pytest.raises(WhatsArabError) as excinfo:
        client.messages.send(to="201234567890", text="hi")

    err = excinfo.value
    assert err.code == "OUTSIDE_CSW"
    assert err.status == 400
    assert err.request_id == "req_err"
    assert "24-hour" in str(err)


def test_200_with_success_false_is_still_a_failure():
    # The envelope is the authority, not the status line. A client that trusted
    # the status would return None here and call it a send.
    def handler(request):
        return httpx.Response(200, json={"success": False, "error": {"code": "OVER_QUOTA"}})

    client = make_client(handler)
    with pytest.raises(WhatsArabError) as excinfo:
        client.templates.list()
    assert excinfo.value.code == "OVER_QUOTA"


def test_transport_failure_is_the_same_error_type():
    def handler(request):
        raise httpx.ConnectError("connection refused")

    client = make_client(handler)
    with pytest.raises(WhatsArabError) as excinfo:
        client.events.list()
    assert excinfo.value.code == "NETWORK_ERROR"
    assert excinfo.value.status == 0


def test_timeout_is_reported_as_timeout():
    def handler(request):
        raise httpx.ReadTimeout("timed out")

    client = make_client(handler)
    with pytest.raises(WhatsArabError) as excinfo:
        client.events.list()
    assert excinfo.value.code == "TIMEOUT"


def test_non_json_error_body_still_raises_with_a_code():
    def handler(request):
        return httpx.Response(502, text="<html>bad gateway</html>")

    client = make_client(handler)
    with pytest.raises(WhatsArabError) as excinfo:
        client.templates.list()
    assert excinfo.value.code == "HTTP_502"
    assert excinfo.value.status == 502


# ── resources ───────────────────────────────────────────────────────


def test_send_requires_exactly_one_kind():
    client = make_client(lambda r: envelope({}))

    with pytest.raises(ValueError, match="exactly one"):
        client.messages.send(to="201234567890")
    with pytest.raises(ValueError, match="exactly one"):
        client.messages.send(to="201234567890", text="hi", template="order_shipped")


def test_send_by_recipient_sends_the_user_id_and_no_to():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return envelope({})

    client = make_client(handler)
    client.messages.send(recipient="EG.13491208655302741918", text="أهلًا")

    assert seen["body"] == {"recipient": "EG.13491208655302741918", "text": "أهلًا"}


def test_send_requires_exactly_one_address():
    client = make_client(lambda r: envelope({}))

    with pytest.raises(ValueError, match="to / recipient"):
        client.messages.send(text="hi")
    with pytest.raises(ValueError, match="to / recipient"):
        client.messages.send(to="201234567890", recipient="EG.13491208655302741918", text="hi")


def test_send_passes_optional_fields_through_and_omits_the_rest():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return envelope({})

    client = make_client(handler)
    client.messages.send(
        to="201234567890",
        template="order_shipped",
        language="ar",
        components=[{"type": "body", "parameters": [{"type": "text", "text": "10428"}]}],
        from_phone_number_id="113456789012345",
    )

    assert seen["body"]["template"] == "order_shipped"
    assert seen["body"]["language"] == "ar"
    assert seen["body"]["from_phone_number_id"] == "113456789012345"
    # Unset options must not be sent as nulls — the API rejects a null dry_run.
    assert "dry_run" not in seen["body"]
    assert "text" not in seen["body"]


def test_path_segments_are_url_encoded():
    # The case that matters is a RESERVED character, not a space: httpx encodes
    # spaces on its own, so asserting on one would pass with the encoding
    # removed. A slash does not get encoded for you — it silently becomes a
    # path separator and addresses a different resource.
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, content=b"x")

    client = make_client(handler)
    client.media.download("../../secrets")

    assert "%2F" in calls[0]
    assert calls[0].endswith("/api/media/..%2F..%2Fsecrets")


def test_templates_edit_is_patch_on_id_and_delete_is_on_name():
    calls = []

    def handler(request):
        calls.append((request.method, str(request.url)))
        return envelope({})

    client = make_client(handler)
    client.templates.edit("12345", category="UTILITY")
    client.templates.delete("order_confirmation")

    assert calls[0][0] == "PATCH"
    assert calls[0][1].endswith("/api/templates/12345")
    assert calls[1][0] == "DELETE"
    assert calls[1][1].endswith("/api/templates/order_confirmation")


def test_media_download_returns_raw_bytes():
    payload = b"\xff\xd8\xff\xe0jpeg-ish"

    def handler(request):
        return httpx.Response(200, content=payload)

    client = make_client(handler)
    assert client.media.download("media_1") == payload


def test_media_download_raises_on_an_error_body():
    def handler(request):
        return httpx.Response(404, json={"success": False, "error": {"code": "NOT_FOUND"}})

    client = make_client(handler)
    with pytest.raises(WhatsArabError) as excinfo:
        client.media.download("nope")
    assert excinfo.value.code == "NOT_FOUND"


def test_media_upload_is_multipart():
    seen = {}

    def handler(request):
        seen["content_type"] = request.headers.get("content-type", "")
        seen["body"] = request.content
        return envelope({"media_id": "m_1"})

    client = make_client(handler)
    result = client.media.upload(b"%PDF-1.4", filename="invoice.pdf", content_type="application/pdf")

    assert result["media_id"] == "m_1"
    assert seen["content_type"].startswith("multipart/form-data")
    assert b"invoice.pdf" in seen["body"]


def test_events_list_sends_the_limit_as_a_query_param():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return envelope([])

    client = make_client(handler)
    client.events.list(limit=5)

    assert "limit=5" in seen["url"]


def test_rejects_construction_without_a_key():
    with pytest.raises(ValueError, match="api_key is required"):
        WhatsArab(api_key="")


def test_works_as_a_context_manager():
    with make_client(lambda r: envelope([])) as client:
        assert client.templates.list() == []


# ── webhook signature ───────────────────────────────────────────────

SECRET = "whsec_test"
NOW = 1700000000.0


def sign(body, timestamp, secret=SECRET):
    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    signed = str(timestamp).encode("utf-8") + b"." + body_bytes
    digest = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return "sha256=" + digest


def test_accepts_a_correctly_signed_delivery():
    body = '{"event":"message.delivered"}'
    assert verify_webhook_signature(
        secret=SECRET,
        raw_body=body,
        signature_header=sign(body, "1700000000"),
        timestamp_header="1700000000",
        now=lambda: NOW,
    )


def test_rejects_a_body_that_changed_by_one_character():
    assert not verify_webhook_signature(
        secret=SECRET,
        raw_body='{"amount":99}',
        signature_header=sign('{"amount":10}', "1700000000"),
        timestamp_header="1700000000",
        now=lambda: NOW,
    )


def test_rejects_a_signature_from_a_different_secret():
    body = '{"a":1}'
    assert not verify_webhook_signature(
        secret=SECRET,
        raw_body=body,
        signature_header=sign(body, "1700000000", secret="other_secret"),
        timestamp_header="1700000000",
        now=lambda: NOW,
    )


def test_rejects_a_replay_outside_the_tolerance_but_allows_it_when_disabled():
    body = '{"a":1}'
    args = dict(
        secret=SECRET,
        raw_body=body,
        signature_header=sign(body, "1700000000"),
        timestamp_header="1700000000",
    )
    # The bytes stay valid forever; only the clock moves.
    assert not verify_webhook_signature(**args, now=lambda: NOW + 3600)
    assert verify_webhook_signature(**args, tolerance_seconds=0, now=lambda: NOW + 3600)


def test_rejects_missing_or_malformed_headers_without_raising():
    base = dict(secret=SECRET, raw_body="{}", now=lambda: NOW)
    assert not verify_webhook_signature(**base, signature_header=None, timestamp_header="1700000000")
    assert not verify_webhook_signature(**base, signature_header="sha256=aa", timestamp_header=None)
    assert not verify_webhook_signature(**base, signature_header="sha256=aa", timestamp_header="not-a-number")
    assert not verify_webhook_signature(**base, signature_header="sha256=short", timestamp_header="1700000000")


def test_accepts_the_signature_with_or_without_the_prefix():
    body = '{"a":1}'
    with_prefix = sign(body, "1700000000")
    base = dict(secret=SECRET, raw_body=body, timestamp_header="1700000000", now=lambda: NOW)
    assert verify_webhook_signature(**base, signature_header=with_prefix)
    assert verify_webhook_signature(**base, signature_header=with_prefix[len("sha256=") :])


def test_bytes_and_str_bodies_agree():
    body = '{"ar":"أهلًا"}'
    signature = sign(body, "1700000000")
    base = dict(secret=SECRET, signature_header=signature, timestamp_header="1700000000", now=lambda: NOW)
    assert verify_webhook_signature(**base, raw_body=body)
    assert verify_webhook_signature(**base, raw_body=body.encode("utf-8"))


# ── numbers + from_ (0.3.0) ─────────────────────────────────────────


def test_numbers_list_is_a_get_on_api_numbers():
    rows = [{"id": "7d0d8b2e-4c3a-4f0e-9c6b-2b1f9a8e5d10", "phone_number_id": "113456789012345", "is_default": True}]
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["method"] = request.method
        return envelope(rows)

    client = make_client(handler)
    assert client.numbers.list() == rows
    assert seen["url"] == f"{DEFAULT_BASE_URL}/api/numbers"
    assert seen["method"] == "GET"


def test_from_travels_in_the_body_of_send_and_otp():
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return envelope({"message_id": "wamid.Z", "request_id": "r", "expires_in": 300, "from": {"number_id": "n"}})

    client = make_client(handler)
    sent = client.messages.send(to="201234567890", text="hi", from_="+201012345678")
    client.otp.send(to="201234567890", template="otp_login", from_="113456789012345")
    client.messages.send(to="201234567890", text="hi", from_phone_number_id="113456789012345")

    assert bodies[0] == {"to": "201234567890", "text": "hi", "from": "+201012345678"}
    assert bodies[1] == {"to": "201234567890", "template": "otp_login", "from": "113456789012345"}
    assert bodies[2] == {"to": "201234567890", "text": "hi", "from_phone_number_id": "113456789012345"}
    assert sent["from"] == {"number_id": "n"}

    # Both given: from_ wins on the client already — the legacy key is not sent.
    client.messages.send(to="201234567890", text="hi", from_="+201012345678", from_phone_number_id="999")
    client.otp.send(to="201234567890", template="otp_login", from_="+201012345678", from_phone_number_id="999")
    assert bodies[3] == {"to": "201234567890", "text": "hi", "from": "+201012345678"}
    assert bodies[4] == {"to": "201234567890", "template": "otp_login", "from": "+201012345678"}


def test_media_upload_passes_from_as_a_query_param_only_when_given():
    urls = []

    def handler(request):
        urls.append(str(request.url))
        return envelope({"media_id": "1", "from": None})

    client = make_client(handler)
    client.media.upload(b"x", filename="a.txt")
    client.media.upload(b"x", filename="a.txt", from_="7d0d8b2e-4c3a-4f0e-9c6b-2b1f9a8e5d10")

    assert urls[0] == f"{DEFAULT_BASE_URL}/api/media"
    assert urls[1] == f"{DEFAULT_BASE_URL}/api/media?from=7d0d8b2e-4c3a-4f0e-9c6b-2b1f9a8e5d10"


def test_templates_take_from_on_the_query_string_or_in_the_body():
    seen = []

    def handler(request):
        seen.append((request.method, str(request.url), json.loads(request.content) if request.content else None))
        return envelope([])

    client = make_client(handler)
    client.templates.list()
    client.templates.list(from_="113456789012345")
    client.templates.edit("123", from_="113456789012345", category="UTILITY")
    client.templates.delete("order_shipped", from_="113456789012345")
    client.templates.create(name="n", language="ar", category="UTILITY", components=[], from_="113456789012345")

    assert seen[0][1] == f"{DEFAULT_BASE_URL}/api/templates"
    assert seen[1][1] == f"{DEFAULT_BASE_URL}/api/templates?from=113456789012345"
    assert seen[2] == ("PATCH", f"{DEFAULT_BASE_URL}/api/templates/123?from=113456789012345", {"category": "UTILITY"})
    assert seen[3][:2] == ("DELETE", f"{DEFAULT_BASE_URL}/api/templates/order_shipped?from=113456789012345")
    assert seen[4][2]["from"] == "113456789012345"


def test_events_list_adds_type_and_number_id_filters():
    urls = []

    def handler(request):
        urls.append(str(request.url))
        return envelope([])

    client = make_client(handler)
    client.events.list()
    client.events.list(20)
    client.events.list(10, type="inbound", number_id="+201012345678")

    assert urls[0] == f"{DEFAULT_BASE_URL}/api/events?limit=50"
    assert urls[1] == f"{DEFAULT_BASE_URL}/api/events?limit=20"
    assert urls[2] == f"{DEFAULT_BASE_URL}/api/events?limit=10&type=inbound&number_id=%2B201012345678"

    # The documented 1–500 bound is applied client-side too.
    client.events.list(9000)
    client.events.list(0)
    assert urls[3] == f"{DEFAULT_BASE_URL}/api/events?limit=500"
    assert urls[4] == f"{DEFAULT_BASE_URL}/api/events?limit=1"


def test_number_not_allowed_surfaces_with_code_and_403():
    def handler(request):
        return httpx.Response(403, json={"success": False, "error": {"code": "NUMBER_NOT_ALLOWED", "message": "restricted"}})

    client = make_client(handler)
    with pytest.raises(WhatsArabError) as excinfo:
        client.messages.send(to="201234567890", text="hi", from_="113456789012345")
    assert excinfo.value.code == "NUMBER_NOT_ALLOWED"
    assert excinfo.value.status == 403


# ── templates.availability + templates.copy (0.4.0) ─────────────────


def test_templates_availability_is_a_get_with_names_language_and_scope():
    rows = [
        {"name": "order_confirmation", "language": "ar", "availableOn": ["n1"], "lackingOn": [
            {"id": "n2", "label": "Branch", "displayNumber": "+20 10 0000 0002", "verdict": "language_missing", "languages": ["en"]},
        ], "verdict": "language_missing", "languages": ["en"]},
    ]
    seen = {}

    def handler(request):
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["params"] = dict(request.url.params)
        return envelope(rows)

    client = make_client(handler)
    got = client.templates.availability(names=["order_confirmation", "welcome:en_US"], language="ar", scope=["n1", "n2"])

    assert seen["method"] == "GET"
    assert seen["path"] == "/api/templates/availability"
    assert seen["params"] == {"names": "order_confirmation,welcome:en_US", "language": "ar", "scope": "n1,n2"}
    assert got == rows


def test_templates_availability_takes_a_string_whole_and_sends_only_what_it_was_given():
    seen = []

    def handler(request):
        seen.append(dict(request.url.params))
        return envelope([])

    client = make_client(handler)
    client.templates.availability(names="a:ar,b:en")
    client.templates.availability(names="welcome", language="ar", scope="all")

    # A bare string is one value, not a list of characters.
    assert seen[0] == {"names": "a:ar,b:en"}
    assert seen[1] == {"names": "welcome", "language": "ar", "scope": "all"}


def test_templates_copy_posts_both_sides_and_returns_them():
    data = {
        "name": "order_confirmation", "language": "ar", "category": "UTILITY", "status": "PENDING", "id": "1234567890123456",
        "sourceWabaId": "222000222000", "targetWabaId": "333000333000",
        "from": {"number_id": "n1", "phone_number_id": "111000111000", "display_number": "+20 10 0000 0001"},
        "to": {"number_id": "n2", "phone_number_id": "444000444000", "display_number": "+20 10 0000 0002"},
    }
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["method"] = request.method
        seen["body"] = json.loads(request.content)
        return envelope(data, status=201)

    client = make_client(handler)
    got = client.templates.copy(name="order_confirmation", language="ar", from_="n1", to="+201000000002")

    assert seen["url"] == f"{DEFAULT_BASE_URL}/api/templates/copy"
    assert seen["method"] == "POST"
    assert seen["body"] == {"name": "order_confirmation", "language": "ar", "from": "n1", "to": "+201000000002"}
    assert got == data


def test_a_refused_copy_raises_with_the_platform_code():
    def handler(request):
        return httpx.Response(409, json={"success": False, "error": {"code": "TEMPLATE_EXISTS", "message": "The target already has it."}})

    client = make_client(handler)
    with pytest.raises(WhatsArabError) as exc:
        client.templates.copy(name="x", language="ar", from_="n1", to="n2")
    assert exc.value.code == "TEMPLATE_EXISTS"
    assert exc.value.status == 409


# ── templates.upload_sample (0.5.0) ─────────────────────────────────


def test_templates_upload_sample_posts_multipart_with_format_and_from():
    seen = {}

    def handler(request):
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["params"] = dict(request.url.params)
        seen["content_type"] = request.headers.get("content-type", "")
        seen["body"] = request.content
        return envelope({"handle": "4::h", "mime": "image/jpeg"})

    client = make_client(handler)
    got = client.templates.upload_sample(b"\xff\xd8\xff", format="IMAGE", filename="promo.jpg", content_type="image/jpeg", from_="n1")

    assert seen["method"] == "POST"
    assert seen["path"] == "/api/templates/sample-upload"
    assert seen["params"] == {"format": "IMAGE", "from": "n1"}
    assert seen["content_type"].startswith("multipart/form-data")
    assert b'name="file"; filename="promo.jpg"' in seen["body"]
    assert got == {"handle": "4::h", "mime": "image/jpeg"}


def test_templates_upload_sample_refusal_raises_with_code():
    seen = {}

    def handler(request):
        seen["params"] = dict(request.url.params)
        return httpx.Response(415, json={"success": False, "error": {"code": "UNSUPPORTED_SAMPLE", "message": "A VIDEO header sample must be video/mp4."}})

    client = make_client(handler)
    with pytest.raises(WhatsArabError) as exc:
        client.templates.upload_sample(b"x", format="VIDEO")
    assert exc.value.code == "UNSUPPORTED_SAMPLE"
    assert exc.value.status == 415
    assert seen["params"] == {"format": "VIDEO"}


# ── contacts + webhooks (0.6.0) ──────────────────────────


def test_contacts_upsert_posts_only_what_it_was_given():
    seen = []

    def handler(request):
        seen.append({"method": request.method, "url": str(request.url), "body": json.loads(request.content)})
        return envelope({"id": "c1", "phone": "201000000001", "created": True}, status=201)

    client = make_client(handler)
    got = client.contacts.upsert(phone="+201000000001", name="Sara", custom_fields={"city": "Cairo", "old": None}, tags=["lead"], from_="n1")
    client.contacts.upsert(phone="201000000001")

    assert seen[0]["method"] == "POST"
    assert seen[0]["url"] == f"{DEFAULT_BASE_URL}/api/contacts"
    assert seen[0]["body"] == {"phone": "+201000000001", "name": "Sara", "custom_fields": {"city": "Cairo", "old": None}, "tags": ["lead"], "from": "n1"}
    assert seen[1]["body"] == {"phone": "201000000001"}
    assert got["created"] is True


def test_contacts_get_add_and_remove_tag_encode_phone_and_tag():
    seen = []

    def handler(request):
        seen.append({"method": request.method, "path": request.url.raw_path.decode(), "body": request.content})
        return envelope({})

    client = make_client(handler)
    client.contacts.get("+201000000001")
    client.contacts.add_tag("+201000000001", "عميل مهم")
    client.contacts.add_tag("201000000001", "vip", from_="n2")
    client.contacts.remove_tag("+201000000001", "عميل مهم")

    assert seen[0]["method"] == "GET"
    assert seen[0]["path"] == "/api/contacts/%2B201000000001"
    assert seen[1]["method"] == "POST"
    assert seen[1]["path"] == "/api/contacts/%2B201000000001/tags"
    assert json.loads(seen[1]["body"]) == {"tag": "عميل مهم"}
    assert json.loads(seen[2]["body"]) == {"tag": "vip", "from": "n2"}
    assert seen[3]["method"] == "DELETE"
    assert seen[3]["path"] == "/api/contacts/%2B201000000001/tags/%D8%B9%D9%85%D9%8A%D9%84%20%D9%85%D9%87%D9%85"


def test_unknown_contact_raises_not_found():
    client = make_client(lambda r: httpx.Response(404, json={"success": False, "error": {"code": "NOT_FOUND", "message": "No contact."}}))
    with pytest.raises(WhatsArabError) as exc:
        client.contacts.get("201000000099")
    assert exc.value.code == "NOT_FOUND"
    assert exc.value.status == 404


def test_webhooks_list_create_delete():
    seen = []

    def handler(request):
        seen.append({"method": request.method, "path": request.url.path, "body": request.content})
        if request.method == "POST":
            return envelope({"id": "w1", "secret": "whsec_abc"}, status=201)
        if request.method == "DELETE":
            return envelope({"id": "w1", "deleted": True})
        return envelope([])

    client = make_client(handler)
    sub = client.webhooks.create(label="n8n", url="https://hooks.example.com/x", events=["message.received"])
    assert client.webhooks.list() == []
    assert client.webhooks.delete("w1") == {"id": "w1", "deleted": True}

    assert seen[0]["method"] == "POST"
    assert seen[0]["path"] == "/api/webhooks"
    assert json.loads(seen[0]["body"]) == {"label": "n8n", "url": "https://hooks.example.com/x", "events": ["message.received"]}
    assert sub["secret"] == "whsec_abc"
    assert seen[1]["method"] == "GET"
    assert seen[2]["method"] == "DELETE"
    assert seen[2]["path"] == "/api/webhooks/w1"


# ── me, contact list, tags, event samples (0.7.0) ────────


def test_me_gets_api_me():
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return envelope({"workspace": {"id": "t1", "name": "Nile Store"}, "webhooks": {"used": 1, "limit": 5}})

    client = make_client(handler)
    got = client.me()
    assert seen[0] == f"{DEFAULT_BASE_URL}/api/me"
    assert got["webhooks"] == {"used": 1, "limit": 5}


def test_contacts_list_keeps_the_cursor_and_sends_only_given_params():
    seen = []

    def handler(request):
        seen.append(dict(request.url.params))
        return httpx.Response(200, json={"success": True, "data": [{"id": "c1"}], "next_cursor": "abc"})

    client = make_client(handler)
    first = client.contacts.list()
    client.contacts.list(limit=2, cursor="abc", since="2026-10-29T00:00:00Z")

    assert seen[0] == {}
    assert seen[1] == {"limit": "2", "cursor": "abc", "since": "2026-10-29T00:00:00Z"}
    assert first == {"contacts": [{"id": "c1"}], "next_cursor": "abc"}


def test_tags_list_and_webhook_samples_hit_their_paths():
    seen = []

    def handler(request):
        seen.append((request.url.path, dict(request.url.params)))
        return envelope([])

    client = make_client(handler)
    client.tags.list()
    client.webhooks.samples("message.received", limit=1)

    assert seen[0] == ("/api/tags", {})
    assert seen[1] == ("/api/webhooks/samples", {"event": "message.received", "limit": "1"})
