'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');

const { WhatsArab, WhatsArabError, verifyWebhookSignature, DEFAULT_BASE_URL } = require('../dist/index.js');

/**
 * The SDK is a thin shell over fetch, so the things worth pinning are the ones
 * a caller cannot see and would only discover in production: which URL and
 * method a call turns into, that the key is attached, that every failure —
 * transport included — arrives as one error type carrying the platform's code,
 * and that the webhook helper rejects what it should.
 *
 * Each test injects its own fetch and asserts on what the SDK tried to do.
 */

function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('attaches the key and builds the URL off the default host', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: { message_id: 'wamid.X' } }));
  const wa = new WhatsArab({ apiKey: 'whap_test_secret', fetch: impl });

  await wa.messages.send({ to: '201234567890', text: 'مرحبا' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/api/messages`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-API-Key'], 'whap_test_secret');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { to: '201234567890', text: 'مرحبا' });
});

test('a send addressed by user id carries recipient and no to', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: { message_id: 'wamid.Y' } }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await wa.messages.send({ recipient: 'EG.13491208655302741918', text: 'أهلًا' });

  assert.deepEqual(JSON.parse(calls[0].init.body), { recipient: 'EG.13491208655302741918', text: 'أهلًا' });
});

test('strips trailing slashes from a custom base URL', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: [] }));
  const wa = new WhatsArab({ apiKey: 'k', baseUrl: 'https://staging.example.com///', fetch: impl });

  await wa.templates.list();

  assert.equal(calls[0].url, 'https://staging.example.com/api/templates');
});

test('unwraps the envelope and returns data', async () => {
  const { impl } = stubFetch(() => jsonResponse({ success: true, data: { request_id: 'req_1', expires_in: 300 } }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  const result = await wa.otp.send({ to: '201234567890', template: 'otp_login' });

  assert.equal(result.request_id, 'req_1');
  assert.equal(result.expires_in, 300);
});

test('turns an error envelope into WhatsArabError carrying the platform code', async () => {
  const { impl } = stubFetch(() =>
    jsonResponse(
      {
        success: false,
        request_id: 'req_err',
        error: { code: 'OUTSIDE_CSW', message: 'Outside the 24-hour window.' },
      },
      400,
    ),
  );
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await assert.rejects(
    () => wa.messages.send({ to: '201234567890', text: 'hi' }),
    (err) => {
      assert.ok(err instanceof WhatsArabError);
      assert.equal(err.code, 'OUTSIDE_CSW');
      assert.equal(err.status, 400);
      assert.equal(err.requestId, 'req_err');
      return true;
    },
  );
});

test('a 200 with success:false is still a failure', async () => {
  // The platform envelope is the authority, not the HTTP status — an SDK that
  // trusted res.ok would hand the caller `undefined` and call it a send.
  const { impl } = stubFetch(() => jsonResponse({ success: false, error: { code: 'OVER_QUOTA' } }, 200));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await assert.rejects(() => wa.templates.list(), (err) => err.code === 'OVER_QUOTA');
});

test('a transport failure arrives as the same error type', async () => {
  const { impl } = stubFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await assert.rejects(
    () => wa.events.list(),
    (err) => {
      assert.ok(err instanceof WhatsArabError);
      assert.equal(err.code, 'NETWORK_ERROR');
      assert.equal(err.status, 0);
      return true;
    },
  );
});

test('a timeout is reported as TIMEOUT, not as a generic network error', async () => {
  const { impl } = stubFetch(() => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  });
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl, timeoutMs: 5 });

  await assert.rejects(() => wa.events.list(), (err) => err.code === 'TIMEOUT');
});

test('templates.edit is a PATCH on the id, delete is a DELETE on the name', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: {} }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await wa.templates.edit('12345', { category: 'UTILITY' });
  await wa.templates.delete('order confirmation');

  assert.equal(calls[0].init.method, 'PATCH');
  assert.ok(calls[0].url.endsWith('/api/templates/12345'));
  assert.equal(calls[1].init.method, 'DELETE');
  // Encoded, or a name with a space silently becomes a different path.
  assert.ok(calls[1].url.endsWith('/api/templates/order%20confirmation'));
});

test('media.download returns raw bytes rather than trying to parse JSON', async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const { impl } = stubFetch(() => new Response(bytes, { status: 200 }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  const out = await wa.media.download('media_1');

  assert.deepEqual(new Uint8Array(out), bytes);
});

test('media.download surfaces an error body instead of returning it as bytes', async () => {
  const { impl } = stubFetch(() => jsonResponse({ success: false, error: { code: 'NOT_FOUND' } }, 404));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await assert.rejects(() => wa.media.download('nope'), (err) => err.code === 'NOT_FOUND');
});

test('media.upload posts multipart without forcing a JSON content type', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: { media_id: 'm_1' } }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  const result = await wa.media.upload(new Blob([new Uint8Array([1, 2, 3])]), 'receipt.pdf');

  assert.equal(result.media_id, 'm_1');
  // Setting Content-Type by hand here would drop the multipart boundary and
  // every upload would fail at the server.
  assert.equal(calls[0].init.headers['Content-Type'], undefined);
  assert.ok(calls[0].init.body instanceof FormData);
});

test('rejects construction without a key', () => {
  assert.throws(() => new WhatsArab({ apiKey: '' }), /apiKey is required/);
});

// ── webhook signature ────────────────────────────────────────────────

const SECRET = 'whsec_test';

function sign(body, timestamp, secret = SECRET) {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

test('accepts a correctly signed delivery', () => {
  const body = '{"event":"message.delivered"}';
  const ts = '1700000000';
  assert.equal(
    verifyWebhookSignature({
      secret: SECRET,
      rawBody: body,
      signatureHeader: sign(body, ts),
      timestampHeader: ts,
      now: () => 1700000000_000,
    }),
    true,
  );
});

test('rejects a body that changed by one character', () => {
  const ts = '1700000000';
  const signature = sign('{"amount":10}', ts);
  assert.equal(
    verifyWebhookSignature({
      secret: SECRET,
      rawBody: '{"amount":99}',
      signatureHeader: signature,
      timestampHeader: ts,
      now: () => 1700000000_000,
    }),
    false,
  );
});

test('rejects a signature made with a different secret', () => {
  const body = '{"a":1}';
  const ts = '1700000000';
  assert.equal(
    verifyWebhookSignature({
      secret: SECRET,
      rawBody: body,
      signatureHeader: sign(body, ts, 'other_secret'),
      timestampHeader: ts,
      now: () => 1700000000_000,
    }),
    false,
  );
});

test('rejects a replayed delivery outside the tolerance', () => {
  const body = '{"a":1}';
  const ts = '1700000000';
  const args = {
    secret: SECRET,
    rawBody: body,
    signatureHeader: sign(body, ts),
    timestampHeader: ts,
  };
  // Signature is valid; only the clock moved. An hour later, still valid bytes.
  assert.equal(verifyWebhookSignature({ ...args, now: () => 1700003600_000 }), false);
  // And the check can be turned off deliberately.
  assert.equal(
    verifyWebhookSignature({ ...args, toleranceSeconds: 0, now: () => 1700003600_000 }),
    true,
  );
});

test('rejects missing headers rather than throwing', () => {
  const base = { secret: SECRET, rawBody: '{}', now: () => 1700000000_000 };
  assert.equal(verifyWebhookSignature({ ...base, signatureHeader: null, timestampHeader: '1700000000' }), false);
  assert.equal(verifyWebhookSignature({ ...base, signatureHeader: 'sha256=aa', timestampHeader: null }), false);
  assert.equal(verifyWebhookSignature({ ...base, signatureHeader: 'sha256=aa', timestampHeader: 'not-a-number' }), false);
});

test('accepts the signature with or without the sha256= prefix', () => {
  const body = '{"a":1}';
  const ts = '1700000000';
  const withPrefix = sign(body, ts);
  const bare = withPrefix.slice('sha256='.length);
  const base = { secret: SECRET, rawBody: body, timestampHeader: ts, now: () => 1700000000_000 };
  assert.equal(verifyWebhookSignature({ ...base, signatureHeader: withPrefix }), true);
  assert.equal(verifyWebhookSignature({ ...base, signatureHeader: bare }), true);
});

test('accepts a raw Buffer body, byte-identical to the string form', () => {
  const body = '{"ar":"أهلًا"}';
  const ts = '1700000000';
  assert.equal(
    verifyWebhookSignature({
      secret: SECRET,
      rawBody: Buffer.from(body, 'utf8'),
      signatureHeader: sign(body, ts),
      timestampHeader: ts,
      now: () => 1700000000_000,
    }),
    true,
  );
});

test('a length mismatch returns false instead of throwing', () => {
  // timingSafeEqual throws on differing lengths; an unguarded call would turn a
  // malformed header into a 500 on the caller's webhook route.
  assert.equal(
    verifyWebhookSignature({
      secret: SECRET,
      rawBody: '{}',
      signatureHeader: 'sha256=short',
      timestampHeader: '1700000000',
      now: () => 1700000000_000,
    }),
    false,
  );
});

// ── numbers + `from` (0.3.0) ────────────────────────────────────────

test('numbers.list is a GET on /api/numbers and returns the rows', async () => {
  const rows = [{ id: '7d0d8b2e-4c3a-4f0e-9c6b-2b1f9a8e5d10', phone_number_id: '113456789012345', display_number: '+20 10 1234 5678', label: 'Sales', is_default: true, status: 'active', color: 'emerald' }];
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: rows, total: 1 }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  const got = await wa.numbers.list();

  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/api/numbers`);
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(got, rows);
});

test('`from` travels in the body of a send and an OTP, and both echo the sender', async () => {
  const from = { number_id: '7d0d8b2e-4c3a-4f0e-9c6b-2b1f9a8e5d10', phone_number_id: '113456789012345', display_number: '+20 10 1234 5678' };
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: { message_id: 'wamid.Z', request_id: 'req_2', expires_in: 300, from } }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  const sent = await wa.messages.send({ to: '201234567890', text: 'hi', from: '+201012345678' });
  assert.deepEqual(JSON.parse(calls[0].init.body), { to: '201234567890', text: 'hi', from: '+201012345678' });
  assert.deepEqual(sent.from, from);

  const otp = await wa.otp.send({ to: '201234567890', template: 'otp_login', from: '113456789012345' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { to: '201234567890', template: 'otp_login', from: '113456789012345' });
  assert.deepEqual(otp.from, from);

  // The legacy spelling still goes through untouched…
  await wa.messages.send({ to: '201234567890', text: 'hi', from_phone_number_id: '113456789012345' });
  assert.deepEqual(JSON.parse(calls[2].init.body), { to: '201234567890', text: 'hi', from_phone_number_id: '113456789012345' });
  // …and when both are given, `from` wins on the client already.
  await wa.messages.send({ to: '201234567890', text: 'hi', from: '+201012345678', from_phone_number_id: '999' });
  assert.deepEqual(JSON.parse(calls[3].init.body), { to: '201234567890', text: 'hi', from: '+201012345678' });
  await wa.otp.send({ to: '201234567890', template: 'otp_login', from: '+201012345678', from_phone_number_id: '999' });
  assert.deepEqual(JSON.parse(calls[4].init.body), { to: '201234567890', template: 'otp_login', from: '+201012345678' });
});

test('an explicitly empty selector is still sent, so the server can refuse it', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: [] }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await wa.templates.list({ from: '' });
  await wa.media.upload(new Blob(['x']), 'a.txt', { from: '' });
  await wa.events.list({ number_id: '' });

  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/api/templates?from=`);
  assert.equal(calls[1].init.body.get('from'), '');
  assert.equal(calls[2].url, `${DEFAULT_BASE_URL}/api/events?limit=50&number_id=`);
});

test('media.upload appends `from` as a multipart field only when given', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: { media_id: '1', from: null } }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await wa.media.upload(new Blob(['x']), 'a.txt');
  assert.equal(calls[0].init.body.get('from'), null);

  await wa.media.upload(new Blob(['x']), 'a.txt', { from: '7d0d8b2e-4c3a-4f0e-9c6b-2b1f9a8e5d10' });
  assert.equal(calls[1].init.body.get('from'), '7d0d8b2e-4c3a-4f0e-9c6b-2b1f9a8e5d10');
  assert.ok(calls[1].init.body.get('file') instanceof Blob);
});

test('templates take `from` on the query string (list/edit/delete) or in the body (create)', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: [] }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await wa.templates.list();
  await wa.templates.list({ from: '+20 10 1234 5678' });
  await wa.templates.edit('123', { category: 'UTILITY' }, { from: '113456789012345' });
  await wa.templates.delete('order_shipped', { from: '113456789012345' });
  await wa.templates.create({ name: 'n', language: 'ar', category: 'UTILITY', components: [], from: '113456789012345' });

  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/api/templates`);
  assert.equal(calls[1].url, `${DEFAULT_BASE_URL}/api/templates?from=%2B20%2010%201234%205678`);
  assert.equal(calls[2].url, `${DEFAULT_BASE_URL}/api/templates/123?from=113456789012345`);
  assert.equal(calls[3].url, `${DEFAULT_BASE_URL}/api/templates/order_shipped?from=113456789012345`);
  assert.equal(JSON.parse(calls[4].init.body).from, '113456789012345');
});

test('events.list keeps the bare-limit form and adds type / number_id filters', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: [], total: 0, next_cursor: null }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await wa.events.list();
  await wa.events.list(20);
  await wa.events.list({ limit: 10, type: 'inbound', number_id: '+201012345678' });

  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/api/events?limit=50`);
  assert.equal(calls[1].url, `${DEFAULT_BASE_URL}/api/events?limit=20`);
  assert.equal(calls[2].url, `${DEFAULT_BASE_URL}/api/events?limit=10&type=inbound&number_id=%2B201012345678`);

  // The documented 1–500 bound is applied client-side too.
  await wa.events.list(9000);
  await wa.events.list({ limit: 0 });
  assert.equal(calls[3].url, `${DEFAULT_BASE_URL}/api/events?limit=500`);
  assert.equal(calls[4].url, `${DEFAULT_BASE_URL}/api/events?limit=1`);
});

test('a NUMBER_NOT_ALLOWED refusal surfaces with its code and 403', async () => {
  const { impl } = stubFetch(() =>
    jsonResponse({ success: false, error: { code: 'NUMBER_NOT_ALLOWED', message: 'This API key is restricted to specific WhatsApp numbers.' } }, 403),
  );
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await assert.rejects(
    () => wa.messages.send({ to: '201234567890', text: 'hi', from: '113456789012345' }),
    (err) => err instanceof WhatsArabError && err.code === 'NUMBER_NOT_ALLOWED' && err.status === 403,
  );
});

// ── templates.availability + templates.copy (0.4.0) ─────────────────

test('templates.availability is a GET with names, language and scope on the query string', async () => {
  const rows = [
    { name: 'order_confirmation', language: 'ar', availableOn: ['n1'], lackingOn: [{ id: 'n2', label: 'Branch', displayNumber: '+20 10 0000 0002', verdict: 'language_missing', languages: ['en'] }], verdict: 'language_missing', languages: ['en'] },
    { name: 'welcome', language: 'en_US', availableOn: ['n1', 'n2'], lackingOn: [], verdict: 'available' },
  ];
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: rows }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  const got = await wa.templates.availability({ names: ['order_confirmation', 'welcome:en_US'], language: 'ar', scope: ['n1', 'n2'] });

  const url = new URL(calls[0].url);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(url.pathname, '/api/templates/availability');
  assert.equal(url.searchParams.get('names'), 'order_confirmation,welcome:en_US');
  assert.equal(url.searchParams.get('language'), 'ar');
  assert.equal(url.searchParams.get('scope'), 'n1,n2');
  assert.deepEqual(got, rows);
});

test('templates.availability sends only what it was given — a string of names passes through', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: [] }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await wa.templates.availability({ names: 'a:ar,b:en' });
  let url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('names'), 'a:ar,b:en');
  assert.equal(url.searchParams.has('language'), false);
  assert.equal(url.searchParams.has('scope'), false);

  await wa.templates.availability({ names: ['a'], language: 'ar', scope: 'all' });
  url = new URL(calls[1].url);
  assert.equal(url.searchParams.get('scope'), 'all');
});

test('templates.copy POSTs name, language, from and to, and returns both sides', async () => {
  const data = {
    name: 'order_confirmation', language: 'ar', category: 'UTILITY', status: 'PENDING', id: '1234567890123456',
    sourceWabaId: '222000222000', targetWabaId: '333000333000',
    from: { number_id: 'n1', phone_number_id: '111000111000', display_number: '+20 10 0000 0001' },
    to: { number_id: 'n2', phone_number_id: '444000444000', display_number: '+20 10 0000 0002' },
  };
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data }, 201));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  const got = await wa.templates.copy({ name: 'order_confirmation', language: 'ar', from: 'n1', to: '+201000000002' });

  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/api/templates/copy`);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'order_confirmation', language: 'ar', from: 'n1', to: '+201000000002' });
  assert.deepEqual(got, data);
});

test('a refused copy arrives as WhatsArabError with the platform code', async () => {
  const { impl } = stubFetch(() => jsonResponse({ success: false, error: { code: 'SAME_ACCOUNT', message: 'Both numbers share one WhatsApp Business account.' } }, 409));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await assert.rejects(
    wa.templates.copy({ name: 'x', language: 'ar', from: 'n1', to: 'n2' }),
    (err) => err instanceof WhatsArabError && err.code === 'SAME_ACCOUNT' && err.status === 409,
  );
});

// ── templates.uploadSample (0.5.0) ──────────────────────────────────

test('templates.uploadSample posts the file as multipart with format and from on the query string', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: { handle: '4::h', mime: 'image/jpeg' } }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  const got = await wa.templates.uploadSample(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), { format: 'IMAGE', from: 'n1', filename: 'promo.jpg' });

  const url = new URL(calls[0].url);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(url.pathname, '/api/templates/sample-upload');
  assert.equal(url.searchParams.get('format'), 'IMAGE');
  assert.equal(url.searchParams.get('from'), 'n1');
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get('file').name, 'promo.jpg');
  assert.equal(calls[0].init.headers['Content-Type'], undefined, 'multipart must set its own boundary');
  assert.deepEqual(got, { handle: '4::h', mime: 'image/jpeg' });
});

test('templates.uploadSample without from sends only the format, and a 415 arrives with its code', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: false, error: { code: 'UNSUPPORTED_SAMPLE', message: 'A VIDEO header sample must be video/mp4.' } }, 415));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await assert.rejects(
    wa.templates.uploadSample(new Blob(['x']), { format: 'VIDEO' }),
    (err) => err instanceof WhatsArabError && err.code === 'UNSUPPORTED_SAMPLE' && err.status === 415,
  );
  assert.equal(new URL(calls[0].url).search, '?format=VIDEO');
});

// ── contacts + webhooks (0.6.0) ──────────────────────────

test('contacts.upsert POSTs the body as given and returns the contact with `created`', async () => {
  const data = { id: 'c1', phone: '201000000001', name: 'Sara', tags: ['lead'], custom_fields: { city: 'Cairo' }, created: true };
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data }, 201));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  const got = await wa.contacts.upsert({ phone: '+201000000001', name: 'Sara', custom_fields: { city: 'Cairo', old: null }, tags: ['lead'], from: 'n1' });

  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/api/contacts`);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { phone: '+201000000001', name: 'Sara', custom_fields: { city: 'Cairo', old: null }, tags: ['lead'], from: 'n1' });
  assert.deepEqual(got, data);
});

test('contacts.get / addTag / removeTag encode the phone and the tag into the path', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: {} }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await wa.contacts.get('+201000000001');
  await wa.contacts.addTag('+201000000001', 'عميل مهم');
  await wa.contacts.addTag('201000000001', 'vip', { from: 'n2' });
  await wa.contacts.removeTag('+201000000001', 'عميل مهم');

  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/api/contacts/%2B201000000001`);
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].url, `${DEFAULT_BASE_URL}/api/contacts/%2B201000000001/tags`);
  assert.deepEqual(JSON.parse(calls[1].init.body), { tag: 'عميل مهم' });
  assert.deepEqual(JSON.parse(calls[2].init.body), { tag: 'vip', from: 'n2' });
  assert.equal(calls[3].init.method, 'DELETE');
  assert.equal(calls[3].url, `${DEFAULT_BASE_URL}/api/contacts/%2B201000000001/tags/${encodeURIComponent('عميل مهم')}`);
});

test('a contact the workspace does not have arrives as NOT_FOUND / 404', async () => {
  const { impl } = stubFetch(() => jsonResponse({ success: false, error: { code: 'NOT_FOUND', message: 'No contact with this phone on this workspace.' } }, 404));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await assert.rejects(
    wa.contacts.get('201000000099'),
    (err) => err instanceof WhatsArabError && err.code === 'NOT_FOUND' && err.status === 404,
  );
});

test('webhooks.list / create / delete hit /api/webhooks and return the secret only from create', async () => {
  const created = { id: 'w1', label: 'n8n', url: 'https://hooks.example.com/x', events: ['message.received'], number_ids: null, active: true, secret: 'whsec_abc' };
  const { impl, calls } = stubFetch((url, init) => {
    if (init.method === 'POST') return jsonResponse({ success: true, data: created }, 201);
    if (init.method === 'DELETE') return jsonResponse({ success: true, data: { id: 'w1', deleted: true } });
    return jsonResponse({ success: true, data: [] });
  });
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  const sub = await wa.webhooks.create({ label: 'n8n', url: 'https://hooks.example.com/x', events: ['message.received'] });
  const list = await wa.webhooks.list();
  const del = await wa.webhooks.delete('w1');

  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/api/webhooks`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { label: 'n8n', url: 'https://hooks.example.com/x', events: ['message.received'] });
  assert.equal(sub.secret, 'whsec_abc');
  assert.equal(calls[1].init.method, 'GET');
  assert.deepEqual(list, []);
  assert.equal(calls[2].url, `${DEFAULT_BASE_URL}/api/webhooks/w1`);
  assert.equal(calls[2].init.method, 'DELETE');
  assert.deepEqual(del, { id: 'w1', deleted: true });
});

// ── me, contact list, tags, event samples (0.7.0) ────────

test('me() GETs /api/me and returns the data', async () => {
  const data = { workspace: { id: 't1', name: 'Nile Store' }, plan: { slug: 'starter', name: 'Starter' }, key: { prefix: 'a1b2c3d4', name: 'Zapier', scope: 'full', number_ids: null }, webhooks: { used: 1, limit: 5 } };
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  assert.deepEqual(await wa.me(), data);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/api/me`);
});

test('contacts.list sends only the options given and keeps the cursor from beside `data`', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: [{ id: 'c1' }], next_cursor: 'abc' }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  const first = await wa.contacts.list();
  const second = await wa.contacts.list({ limit: 2, cursor: 'abc', since: '2026-10-29T00:00:00Z' });

  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/api/contacts`);
  assert.deepEqual(first, { contacts: [{ id: 'c1' }], next_cursor: 'abc' });
  const q = new URL(calls[1].url).searchParams;
  assert.equal(q.get('limit'), '2');
  assert.equal(q.get('cursor'), 'abc');
  assert.equal(q.get('since'), '2026-10-29T00:00:00Z');
  assert.deepEqual(second.contacts, [{ id: 'c1' }]);
});

test('tags.list and webhooks.samples hit their paths', async () => {
  const { impl, calls } = stubFetch(() => jsonResponse({ success: true, data: [] }));
  const wa = new WhatsArab({ apiKey: 'k', fetch: impl });

  await wa.tags.list();
  await wa.webhooks.samples('message.received', { limit: 1 });

  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/api/tags`);
  const u = new URL(calls[1].url);
  assert.equal(u.pathname, '/api/webhooks/samples');
  assert.equal(u.searchParams.get('event'), 'message.received');
  assert.equal(u.searchParams.get('limit'), '1');
});
