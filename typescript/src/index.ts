/**
 * @whatsarab/sdk — the official TypeScript client for the WhatsArab API.
 *
 *   import { WhatsArab } from '@whatsarab/sdk';
 *
 *   const wa = new WhatsArab({ apiKey: process.env.WHATSARAB_API_KEY! });
 *
 *   await wa.messages.send({ to: '201234567890', text: 'أهلًا! طلبك في الطريق.' });
 *   const { request_id } = await wa.otp.send({ to: '201234567890', template: 'otp_login' });
 *   await wa.otp.verify({ request_id, code: '123456' });
 *
 * SCOPE: this client covers the API-KEY surface and nothing else — every
 * operation under /api in the published OpenAPI document except the legacy
 * `/api/notify` (the dashboard's own send-test, kept for integrations written
 * before `/api/messages`; new code sends templates through `messages.send`)
 * and `/api/salla/notifications` (called only by WhatsArab's own app inside
 * Salla). tests/unit/sdk-parity.test.ts in the main repository keeps this
 * list in sync with the API catalog.
 * Contacts are covered as far as an API key reaches: list, upsert by phone,
 * read one, add / remove a tag (`contacts`), the workspace's tags (`tags`),
 * plus outbound webhook subscriptions and recent event samples (`webhooks`)
 * for REST-hook triggers, and `me()` — who the key is. The inbox and
 * broadcasts stay session-authenticated (they belong to the dashboard, not to
 * a server-side key), so an SDK cannot offer them without inventing
 * endpoints. If that changes, the spec at /public/openapi.json changes first.
 */

/** Default host. Override for staging or a self-hosted deployment. */
export const DEFAULT_BASE_URL = 'https://whatsarab.com';

export interface WhatsArabOptions {
  /** Your API key (`whap_<prefix>_<secret>`), from /app/integrations. */
  apiKey: string;
  /** Backend origin, no trailing slash. Defaults to the hosted platform. */
  baseUrl?: string;
  /** Fetch override — for tests, proxies, or a custom agent. Node 18+ has one built in. */
  fetch?: typeof fetch;
  /** Abort a request that takes longer than this. Default 30_000 ms; 0 disables. */
  timeoutMs?: number;
}

/**
 * Every failure arrives as this, including transport failures — so a caller
 * writes one catch, not two. `code` is the platform's stable error code
 * (`OUTSIDE_CSW`, `OVER_QUOTA`, `INVALID_PHONE`…), which is what you branch on;
 * `message` is for humans and may be reworded.
 */
export class WhatsArabError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly metaError?: unknown;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    metaError?: unknown;
  }) {
    super(opts.message);
    this.name = 'WhatsArabError';
    this.status = opts.status;
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.metaError = opts.metaError;
  }
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  request_id?: string;
  error?: { code?: string; message?: string; meta_error?: unknown };
}

// ── Numbers ──────────────────────────────────────────────────────────

/**
 * How the API names one of your WhatsApp numbers wherever it echoes one:
 * `from` on every send response, `number` on every event. Any of the three
 * fields can be passed straight back as `from` on the next call.
 */
export interface NumberRef {
  /** Our id for the number — the `id` of `numbers.list()`. */
  number_id: string;
  /** Meta's phone_number_id — the identifier Meta's webhooks carry. */
  phone_number_id: string;
  /** The phone as Meta reports it (e.g. `+20 10 1234 5678`); null until it has. */
  display_number: string | null;
}

/** One row of `numbers.list()`. Never carries credentials. */
export interface WorkspaceNumber {
  id: string;
  phone_number_id: string;
  display_number: string | null;
  label: string | null;
  /** The workspace's default ★ number — the fallback sender when `from` is
   *  omitted (see `FromOptions` for how the platform picks without one). */
  is_default: boolean;
  status: string;
  /** The chip colour the dashboard shows for this number. */
  color: string;
}

/**
 * The sender selector every send-side call takes. Any of: the number `id`
 * from `numbers.list()`, its Meta `phone_number_id`, or its phone in E.164
 * (`+201234567890`). Omit it and the platform uses the workspace default
 * (for sends, preferring the number of the recipient's latest conversation).
 *
 * An API key restricted to specific numbers (Dashboard → Integrations → API
 * keys) gets `NUMBER_NOT_ALLOWED` (403) for a number outside its list, and
 * with `from` omitted sends from the first number on that list.
 */
export interface FromOptions {
  from?: string;
}

// ── Messages ─────────────────────────────────────────────────────────

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export interface TemplateComponent {
  type: 'body' | 'header' | 'button';
  parameters: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface MediaRef {
  /** Media id from `media.upload()`. */
  id: string;
  kind: MediaKind;
  caption?: string;
  filename?: string;
}

/**
 * Exactly one address. `to` is the phone; `recipient` is the WhatsApp user id
 * of a customer who writes with a username and whose phone Meta has not shared
 * — the `fromUserId` of a `message.received` webhook (whose `from` is then an
 * empty string). Passing both is a compile error rather than a 400.
 */
type Address =
  | {
      /** E.164 without the plus: `201234567890`. */
      to: string;
      recipient?: never;
    }
  | {
      /** WhatsApp business-scoped user id, e.g. `EG.13491208655302741918`. */
      recipient: string;
      to?: never;
    };

interface SendOptions extends FromOptions {
  /**
   * The pre-Oct-2026 spelling of `from` (Meta phone_number_id only). Still
   * accepted; if both are present `from` wins. New code should pass `from`.
   */
  from_phone_number_id?: string;
  /** Validate and price the call without sending it. */
  dry_run?: boolean;
}

type SendCommon = Address & SendOptions;

/** The other kinds are `never` in each branch: a plain union lets an object
 *  carrying two kinds through, because excess-property checks look at the
 *  union as a whole (test/types.check.ts pins it). */
type NoOtherKind = { template?: never; text?: never; interactive?: never; media?: never };

/**
 * Exactly one of template / text / interactive / media — expressed as a union
 * so passing two is a compile error rather than a 400 at runtime.
 */
export type SendMessageInput =
  | (SendCommon & Omit<NoOtherKind, 'template'> & { template: string; language?: string; components?: TemplateComponent[] })
  | (SendCommon & Omit<NoOtherKind, 'text'> & { text: string })
  | (SendCommon & Omit<NoOtherKind, 'interactive'> & { interactive: Record<string, unknown> })
  | (SendCommon & Omit<NoOtherKind, 'media'> & { media: MediaRef });

export interface SendMessageResult {
  /** The wamid. Match it against delivery-status webhooks. `null` on a dry
   *  run — nothing was sent. */
  message_id: string | null;
  /** Echoed back masked — the platform never returns the full number.
   *  Empty for a send addressed by `recipient`. */
  to: string;
  /** The user id, echoed back on a send addressed by `recipient`. */
  recipient?: string;
  kind: 'template' | 'text' | 'interactive' | 'media';
  template?: string;
  status: string;
  /** The number that actually sent (or, on a dry run, would send). `null`
   *  only on a legacy workspace that has no number rows yet. */
  from: NumberRef | null;
  /** Set on a dry run. */
  dry_run?: boolean;
  /** Dry run of a free-form kind: whether the 24-hour window is open on
   *  the sending number, i.e. whether a real send would succeed. */
  window_open?: boolean | null;
  /** Dry run: messages left in this month's quota. */
  quota_remaining?: number;
}

// ── Media ────────────────────────────────────────────────────────────

export interface UploadMediaResult {
  media_id: string;
  /** The number the file was uploaded through. Meta ties a media id to the
   *  number that uploaded it — send it from the SAME number. */
  from: NumberRef | null;
}

// ── Templates ────────────────────────────────────────────────────────

export type TemplateCategory = 'AUTHENTICATION' | 'MARKETING' | 'UTILITY' | 'SERVICE';

/**
 * Templates live on a WhatsApp Business Account, and a workspace's numbers
 * may sit on different accounts — `from` says whose templates you mean.
 */
export interface CreateTemplateInput extends FromOptions {
  /** Lowercase, alphanumeric and underscores. */
  name: string;
  /** BCP-47, e.g. `en` or `ar`. */
  language: string;
  category: TemplateCategory;
  components: Array<Record<string, unknown>>;
}

export interface EditTemplateInput {
  components?: Array<Record<string, unknown>>;
  category?: TemplateCategory;
  [key: string]: unknown;
}

/** The header formats that need a sample for Meta's review. */
export type TemplateHeaderFormat = 'IMAGE' | 'VIDEO' | 'DOCUMENT';

export interface UploadSampleOptions extends FromOptions {
  /** The header format the sample is for: IMAGE takes JPEG/PNG, VIDEO MP4, DOCUMENT PDF. */
  format: TemplateHeaderFormat;
  filename?: string;
}

export interface UploadSampleResult {
  /** Goes in the header component: `example: { header_handle: [handle] }`. */
  handle: string;
  /** The type the file's bytes were recognised as. */
  mime: string;
}

/** Whether a template can be sent, as Meta's state on one account decides it. */
export type TemplateVerdict =
  | { verdict: 'available' }
  /** It exists in this language but is not approved — `status` is Meta's (e.g. `PENDING`, `REJECTED`). */
  | { verdict: 'not_approved'; status: string }
  /** It exists, only in other languages — those are listed. */
  | { verdict: 'language_missing'; languages: string[] }
  | { verdict: 'missing' }
  /** An account could not be asked (an outage at Meta) — never counted as lacking. */
  | { verdict: 'unknown' };

/** A number that cannot send the template, and why. */
export type TemplateLackingNumber = {
  /** The number `id` (as in `numbers.list()`). */
  id: string;
  label: string;
  displayNumber: string | null;
} & Exclude<TemplateVerdict, { verdict: 'available' | 'unknown' }>;

/**
 * One row of `templates.availability()`. The row's own verdict is the
 * strictest across the scope: the first lacking number's verdict, else
 * `unknown` if some account could not be asked, else `available`. A number
 * whose account could not be asked is in neither list.
 */
export type TemplateAvailability = {
  name: string;
  language: string;
  /** Number ids whose account has it APPROVED in `language`. */
  availableOn: string[];
  lackingOn: TemplateLackingNumber[];
} & TemplateVerdict;

export interface TemplateAvailabilityInput {
  /** Template names, each `name` or `name:language` (at most 300). A comma-separated string works too. */
  names: string[] | string;
  /** Default language for bare names, e.g. `ar` or `en_US` — required when any name carries none. */
  language?: string;
  /** `'all'` (the default: every active number) or your number ids from `numbers.list()`. */
  scope?: 'all' | string[];
}

/**
 * `templates.copy()` — submit a template that one number's account has to
 * another number's account. Both sides take the same forms as `from` (number
 * `id`, Meta `phone_number_id`, or E.164) and both are required.
 */
export interface CopyTemplateInput {
  name: string;
  language: string;
  /** The number whose account HAS the template. */
  from: string;
  /** The number whose account should get it. */
  to: string;
}

export interface CopyTemplateResult {
  name: string;
  language: string;
  category: TemplateCategory;
  /** Meta reviews the copy: `PENDING` until it is approved. */
  status: string;
  /** Meta's id for the new template; null if Meta did not return one. */
  id: string | null;
  sourceWabaId: string;
  targetWabaId: string;
  from: NumberRef;
  to: NumberRef;
}

// ── OTP ──────────────────────────────────────────────────────────────

export interface OtpSendInput extends FromOptions {
  to: string;
  /** An approved AUTHENTICATION-category template. */
  template: string;
  language?: string;
  /** Digits in the code, 4–8 (outside the range: clamped, no error). Defaults to the platform setting. */
  code_length?: number;
  /** Seconds until the code expires, 60–5400 (outside the range: clamped; `expires_in` is the value used). Defaults to the platform setting. */
  ttl_seconds?: number;
  /** Wrong codes allowed, 1–10 (outside the range: clamped, no error). Defaults to the platform setting. */
  max_attempts?: number;
  /** Legacy spelling of `from` (Meta phone_number_id only); `from` wins. */
  from_phone_number_id?: string;
}

export interface OtpSendResult {
  request_id: string;
  expires_in: number;
  /** The number the code was sent from. */
  from: NumberRef | null;
  [key: string]: unknown;
}

export interface OtpVerifyInput {
  request_id: string;
  code: string;
}

export interface OtpVerifyResult {
  verified: boolean;
  remaining_attempts?: number;
  [key: string]: unknown;
}

// ── Events ───────────────────────────────────────────────────────────

export type WebhookEventType = 'status' | 'inbound' | 'value_error' | 'template_status_update' | 'inbound_unhandled';

/**
 * One row of `events.list()`: the webhook payload Meta sent, flattened onto
 * `ts` / `type` / `meta_message_id`, plus `number` — the workspace number the
 * event belongs to (the one that received an inbound, or sent the message a
 * status reports on), or `null` when none can be attributed.
 *
 * Inbound events carry `from` (phone, possibly an empty string for a
 * username-only customer), `from_user_id`, `phone_number_id`, `name`,
 * `msg_type`, `text`…; status events `status`, `recipient_id`,
 * `recipient_user_id`. The index signature covers those payload fields.
 */
export interface WebhookEvent {
  /** ISO timestamp of when the event was received. */
  ts: string;
  type: WebhookEventType | string;
  meta_message_id: string | null;
  number: NumberRef | null;
  // Inbound events — `from` may be an empty string for a username-only
  // customer (then `from_user_id` identifies them).
  from?: string;
  from_user_id?: string;
  phone_number_id?: string;
  name?: string;
  msg_type?: string;
  text?: string;
  // Status events.
  status?: string;
  recipient_id?: string;
  recipient_user_id?: string;
  /** Anything else Meta put in the payload. */
  [key: string]: unknown;
}

export interface EventsListOptions {
  /** 1–500. Default 50. */
  limit?: number;
  type?: WebhookEventType;
  /**
   * Only events of ONE number — the number `id`, its Meta `phone_number_id`
   * or its phone in E.164 (the same forms `from` takes). Inbound events belong
   * to the number that received them, status events to the number that sent
   * the message. A number outside a restricted key's list is `NUMBER_NOT_ALLOWED`.
   */
  number_id?: string;
}

// ── Contacts ─────────────────────────────────────────────────────────

/** A custom-field value. `null` (in an upsert) removes that key. */
export type CustomFieldValue = string | number | boolean | null;

/**
 * `contacts.upsert()` — create the contact if the phone is new, otherwise
 * MERGE: omitted fields keep their value, `custom_fields` merge key by key,
 * `tags` are added (never replacing). Opt-out is one-way: `opted_in: false`
 * opts out; `opted_in: true` records consent only on a contact that is not
 * opted out — it never lifts a block.
 */
export interface UpsertContactInput extends FromOptions {
  /** E.164, country code first, no leading 0 (`+201000000001`). */
  phone: string;
  name?: string;
  /** Up to 50 keys per call; `null` removes a key. */
  custom_fields?: Record<string, CustomFieldValue>;
  /** Up to 20, normalized server-side; each applied like `contacts.addTag()`. */
  tags?: string[];
  opted_in?: boolean;
}

/** One contact as the API returns it. */
export interface Contact {
  id: string;
  /** E.164 digits, no «+». */
  phone: string;
  name: string | null;
  /** The contact's tags together with the tags on its conversations. */
  tags: string[];
  custom_fields: Record<string, unknown>;
  opted_in_at: string | null;
  opted_out: boolean;
  opted_out_at: string | null;
  /** Who set the block: `customer` (sent «إيقاف»), `team`, `loop_breaker`, `unknown`; null when not opted out. */
  opted_out_by: 'customer' | 'team' | 'loop_breaker' | 'unknown' | null;
  /** The numbers whose audience the contact is in (a restricted key sees only its own). */
  numbers: NumberRef[];
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertContactResult extends Contact {
  /** True when the phone was new (HTTP 201), false when it was updated (200). */
  created: boolean;
}

export interface AddContactTagResult {
  /** The tag as stored (normalized). */
  tag: string;
  /** False when the contact already had it — the call is safe to repeat. */
  added_to_contact: boolean;
  /** The conversation it was applied to (and its automations ran on), or null when the contact has none. */
  conversation_id: string | null;
}

export interface RemoveContactTagResult {
  tag: string;
  removed_from_contact: boolean;
  conversation_ids: string[];
}

export interface ListContactsOptions {
  /** 1–100. Default 50. */
  limit?: number;
  /** `next_cursor` from the previous page, unchanged. */
  cursor?: string;
  /** ISO-8601 with an offset: only contacts created at or after it. */
  since?: string;
}

export interface ContactPage {
  /** Newest first. */
  contacts: Contact[];
  /** Pass as `cursor` for the next page; null when there is none. */
  next_cursor: string | null;
}

export interface TagCount {
  tag: string;
  /** How many contacts and conversations carry it. */
  count: number;
}

// ── Account ──────────────────────────────────────────────────────────

/** Who the API key is — `me()`. */
export interface Me {
  workspace: { id: string; name: string };
  plan: { slug: string; name: string } | null;
  /** Null only for a dashboard session (never for an API key). */
  key: { prefix: string; name: string; scope: 'read' | 'send' | 'full'; number_ids: string[] | null } | null;
  /** Webhook subscription slots: `limit: null` is unlimited. A trigger needs `used < limit` and a `full` key. */
  webhooks: { used: number; limit: number | null };
}

// ── Webhook subscriptions ────────────────────────────────────────────

export type WebhookSubscriptionEvent =
  | 'message.sent'
  | 'message.delivered'
  | 'message.read'
  | 'message.failed'
  | 'message.received'
  | 'conversation.opened'
  | 'conversation.closed'
  | 'tag.added'
  | 'tag.removed'
  | 'contact.created'
  | 'broadcast.finished'
  | 'template.status_changed';

export interface CreateWebhookInput {
  /** 1–120 chars, shown in the dashboard. */
  label: string;
  /** Public https:// URL; private / metadata IP addresses are refused. */
  url: string;
  events: WebhookSubscriptionEvent[];
  /** Only these numbers' events (ids from `numbers.list()`); null / omitted = every number. */
  number_ids?: string[] | null;
}

export interface WebhookSubscription {
  id: string;
  label: string;
  url: string;
  events: WebhookSubscriptionEvent[];
  number_ids: string[] | null;
  active: boolean;
  last_success_at: string | null;
  last_failure_at: string | null;
  consecutive_failures: number;
  created_at: string;
}

export interface CreatedWebhookSubscription extends WebhookSubscription {
  /** The signing secret (`whsec_…`) — returned only here, store it now. */
  secret: string;
}

/** One recent event in exactly the envelope a delivery's body carries. */
export interface WebhookEventSample {
  event: WebhookSubscriptionEvent;
  /** Unique per sample. */
  deliveryId: string;
  /** Always null: no subscription delivered a sample. */
  webhookId: null;
  /** Unix seconds. */
  timestamp: number;
  data: Record<string, unknown>;
}

// ── Client ───────────────────────────────────────────────────────────

export class WhatsArab {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  readonly numbers: NumbersResource;
  readonly messages: MessagesResource;
  readonly media: MediaResource;
  readonly templates: TemplatesResource;
  readonly otp: OtpResource;
  readonly events: EventsResource;
  readonly contacts: ContactsResource;
  readonly tags: TagsResource;
  readonly webhooks: WebhooksResource;

  constructor(opts: WhatsArabOptions) {
    if (!opts.apiKey) throw new Error('apiKey is required');
    this.apiKey = opts.apiKey;
    // Bounded quantifier: an unbounded `\/+$` backtracks polynomially on a long
    // run of slashes. Nobody attacks their own SDK config, but a bounded one
    // costs nothing and survives being copied somewhere that does take
    // untrusted input.
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/{1,256}$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;

    this.numbers = new NumbersResource(this);
    this.messages = new MessagesResource(this);
    this.media = new MediaResource(this);
    this.templates = new TemplatesResource(this);
    this.otp = new OtpResource(this);
    this.events = new EventsResource(this);
    this.contacts = new ContactsResource(this);
    this.tags = new TagsResource(this);
    this.webhooks = new WebhooksResource(this);
  }

  /**
   * Who this key is: the workspace, the key's scope and number list, and the
   * plan's webhook slots. Use it as an integration's connection test — it
   * tells you before a trigger fails that it needs a `full` key or a free slot.
   */
  async me(): Promise<Me> {
    return this.request<Me>('GET', '/api/me');
  }

  /** @internal */
  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    init?: { json?: unknown; body?: BodyInit; accept?: 'json' | 'binary' | 'envelope' },
  ): Promise<T> {
    const headers: Record<string, string> = { 'X-API-Key': this.apiKey };
    if (init?.json !== undefined) headers['Content-Type'] = 'application/json';

    // A hung socket is indistinguishable from a slow send, and a caller with no
    // timeout waits forever. AbortSignal.timeout(0) would abort immediately, so
    // 0 means "no timeout" rather than "abort now".
    const signal = this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
        signal,
      });
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw new WhatsArabError({
        status: 0,
        code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        message: e?.message || `Could not reach ${this.baseUrl}`,
      });
    }

    if (init?.accept === 'binary') {
      if (!res.ok) throw await this.errorFrom(res);
      return (await res.arrayBuffer()) as T;
    }

    const envelope = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
    if (!res.ok || !envelope?.success) {
      throw new WhatsArabError({
        status: res.status,
        code: envelope?.error?.code || `HTTP_${res.status}`,
        message: envelope?.error?.message || res.statusText || 'Request failed',
        requestId: envelope?.request_id,
        metaError: envelope?.error?.meta_error,
      });
    }
    // A paged list carries its cursor beside `data`, so it needs the envelope.
    if (init?.accept === 'envelope') return envelope as unknown as T;
    return envelope.data as T;
  }

  private async errorFrom(res: Response): Promise<WhatsArabError> {
    const envelope = (await res.json().catch(() => null)) as ApiEnvelope<unknown> | null;
    return new WhatsArabError({
      status: res.status,
      code: envelope?.error?.code || `HTTP_${res.status}`,
      message: envelope?.error?.message || res.statusText || 'Request failed',
      requestId: envelope?.request_id,
    });
  }
}

/** `?from=…` for the calls that take the selector on the query string. A
 *  supplied value is always sent — even `''` — so the server answers
 *  INVALID_FROM_NUMBER instead of the call silently using another number. */
function fromQuery(opts?: FromOptions): string {
  return opts?.from !== undefined ? `?from=${encodeURIComponent(opts.from)}` : '';
}

/** Body of a send/OTP call: `from` wins over the legacy spelling when both
 *  are present — resolved here, so the documented precedence does not rest
 *  on the server alone. */
function withFromPrecedence<T extends { from?: string; from_phone_number_id?: string }>(input: T): T {
  if (input.from === undefined || input.from_phone_number_id === undefined) return input;
  const { from_phone_number_id: _legacy, ...rest } = input;
  return rest as T;
}

class NumbersResource {
  constructor(private readonly client: WhatsArab) {}

  /**
   * Your workspace's WhatsApp numbers — the ids every `from` accepts. Read it
   * once to learn them; the same objects come back as `from` on every send
   * and as `number` on every event. A key restricted to specific numbers
   * sees only those: this list is exactly what that key may send from.
   */
  async list(): Promise<WorkspaceNumber[]> {
    return this.client.request<WorkspaceNumber[]>('GET', '/api/numbers');
  }
}

class MessagesResource {
  constructor(private readonly client: WhatsArab) {}

  /**
   * Send one message. Returns 202 with the wamid — accepted by Meta, not yet
   * delivered; delivery arrives on the webhook bus.
   *
   * `text`, `interactive` and `media` don't count against your WhatsArab
   * quota; Meta bills them to your WhatsApp Business Account (the
   * first 1,000 service messages per business phone number per month are free,
   * then the market's utility rate). They are only deliverable inside the recipient's
   * 24-hour customer-service window; outside it the call fails with
   * `OUTSIDE_CSW` and you must send an approved `template`.
   */
  async send(input: SendMessageInput): Promise<SendMessageResult> {
    return this.client.request<SendMessageResult>('POST', '/api/messages', { json: withFromPrecedence(input) });
  }
}

class MediaResource {
  constructor(private readonly client: WhatsArab) {}

  /**
   * Upload a file and get a media id to pass to `messages.send({ media })`.
   * Accepts anything the platform's FormData accepts — a Blob, a File, or a
   * Uint8Array wrapped in a Blob.
   *
   * Meta ties a media id to the number that uploaded it, so pass the same
   * `from` here as on the send that will use it.
   */
  async upload(file: Blob, filename?: string, opts?: FromOptions): Promise<UploadMediaResult> {
    const form = new FormData();
    form.append('file', file, filename);
    if (opts?.from !== undefined) form.append('from', opts.from);
    return this.client.request<UploadMediaResult>('POST', '/api/media', { body: form });
  }

  /** Download a media file by id. Returns the raw bytes. */
  async download(mediaId: string): Promise<ArrayBuffer> {
    return this.client.request<ArrayBuffer>(
      'GET',
      `/api/media/${encodeURIComponent(mediaId)}`,
      { accept: 'binary' },
    );
  }
}

class TemplatesResource {
  constructor(private readonly client: WhatsArab) {}

  /** Templates of one account: `from` names a number on it; omitted, the default. */
  async list(opts?: FromOptions): Promise<unknown[]> {
    return this.client.request<unknown[]>('GET', `/api/templates${fromQuery(opts)}`);
  }

  async create(input: CreateTemplateInput): Promise<unknown> {
    return this.client.request<unknown>('POST', '/api/templates', { json: input });
  }

  /** Edit by Meta template id — note that create/delete key off the NAME. */
  async edit(id: string, input: EditTemplateInput, opts?: FromOptions): Promise<unknown> {
    return this.client.request<unknown>('PATCH', `/api/templates/${encodeURIComponent(id)}${fromQuery(opts)}`, {
      json: input,
    });
  }

  async delete(name: string, opts?: FromOptions): Promise<unknown> {
    return this.client.request<unknown>('DELETE', `/api/templates/${encodeURIComponent(name)}${fromQuery(opts)}`);
  }

  /**
   * Which of your numbers can send each named template — one row per name,
   * in the order asked. Templates live on a WhatsApp Business account and
   * your numbers may sit on different accounts, so check before you send
   * from a number you have not used the template with. `read` scope.
   *
   *   const [row] = await wa.templates.availability({ names: ['order_confirmation'], language: 'ar' });
   *   if (row.verdict !== 'available') console.log(row.lackingOn);
   */
  async availability(input: TemplateAvailabilityInput): Promise<TemplateAvailability[]> {
    const names = Array.isArray(input.names) ? input.names.join(',') : input.names;
    const query = new URLSearchParams({ names });
    if (input.language !== undefined) query.set('language', input.language);
    if (input.scope !== undefined) query.set('scope', Array.isArray(input.scope) ? input.scope.join(',') : input.scope);
    return this.client.request<TemplateAvailability[]>('GET', `/api/templates/availability?${query.toString()}`);
  }

  /**
   * Upload the sample a media-header template needs for Meta's review, then
   * put the handle in the header of `templates.create`. Upload from the same
   * number (`from`) the template will be created on. `full` scope.
   *
   *   const { handle } = await wa.templates.uploadSample(jpegBlob, { format: 'IMAGE' });
   *   await wa.templates.create({ name: 'promo', language: 'ar', category: 'MARKETING', components: [
   *     { type: 'HEADER', format: 'IMAGE', example: { header_handle: [handle] } },
   *     { type: 'BODY', text: 'عرض اليوم' },
   *   ] });
   */
  async uploadSample(file: Blob, opts: UploadSampleOptions): Promise<UploadSampleResult> {
    const form = new FormData();
    form.append('file', file, opts.filename);
    const query = new URLSearchParams({ format: opts.format });
    if (opts.from !== undefined) query.set('from', opts.from);
    return this.client.request<UploadSampleResult>('POST', `/api/templates/sample-upload?${query.toString()}`, { body: form });
  }

  /**
   * Copy a template from one number's account to another's. Meta reviews
   * the copy, so it comes back `PENDING`. Refused with `SAME_ACCOUNT`,
   * `TEMPLATE_EXISTS`, `TEMPLATE_NOT_FOUND`, or `TEMPLATE_COPY_NEEDS_MEDIA`
   * (a media header or carousel needs a fresh sample — create it on the
   * target instead). `full` scope.
   */
  async copy(input: CopyTemplateInput): Promise<CopyTemplateResult> {
    return this.client.request<CopyTemplateResult>('POST', '/api/templates/copy', { json: input });
  }
}

class OtpResource {
  constructor(private readonly client: WhatsArab) {}

  async send(input: OtpSendInput): Promise<OtpSendResult> {
    return this.client.request<OtpSendResult>('POST', '/api/otp/send', { json: withFromPrecedence(input) });
  }

  async verify(input: OtpVerifyInput): Promise<OtpVerifyResult> {
    return this.client.request<OtpVerifyResult>('POST', '/api/otp/verify', { json: input });
  }
}

class EventsResource {
  constructor(private readonly client: WhatsArab) {}

  /**
   * Recent webhook events, newest first. A bare number is still accepted as
   * the limit (`events.list(20)`), as before; pass an object to filter by
   * `type` or by `number_id`.
   */
  async list(options: number | EventsListOptions = 50): Promise<WebhookEvent[]> {
    const opts: EventsListOptions = typeof options === 'number' ? { limit: options } : options;
    const query = new URLSearchParams();
    // The documented bound, applied here too — the server clamps the same
    // way, so a caller sees the same page either side of the wire.
    const requested = Math.trunc(opts.limit ?? 50);
    query.set('limit', String(Number.isFinite(requested) ? Math.min(500, Math.max(1, requested)) : 50));
    if (opts.type !== undefined) query.set('type', opts.type);
    // Sent whenever supplied, even `''`: the server rejects an invalid
    // selector, which beats quietly returning every number's events.
    if (opts.number_id !== undefined) query.set('number_id', opts.number_id);
    return this.client.request<WebhookEvent[]>('GET', `/api/events?${query.toString()}`);
  }
}

class ContactsResource {
  constructor(private readonly client: WhatsArab) {}

  /**
   * Create or update a contact by phone (merge semantics — see
   * `UpsertContactInput`). `created` says which happened. Needs a `send` key.
   */
  async upsert(input: UpsertContactInput): Promise<UpsertContactResult> {
    return this.client.request<UpsertContactResult>('POST', '/api/contacts', { json: input });
  }

  /**
   * One page of contacts, newest first. Follow `next_cursor` until it is null;
   * a contact created while you page never shifts or repeats a row.
   */
  async list(opts: ListContactsOptions = {}): Promise<ContactPage> {
    const query = new URLSearchParams();
    if (opts.limit !== undefined) query.set('limit', String(opts.limit));
    if (opts.cursor !== undefined) query.set('cursor', opts.cursor);
    if (opts.since !== undefined) query.set('since', opts.since);
    const qs = query.toString();
    const env = await this.client.request<{ data: Contact[]; next_cursor: string | null }>(
      'GET',
      `/api/contacts${qs ? `?${qs}` : ''}`,
      { accept: 'envelope' },
    );
    return { contacts: env.data, next_cursor: env.next_cursor ?? null };
  }

  /** One contact by phone (E.164, with or without «+»). 404 `NOT_FOUND` when unknown. */
  async get(phone: string): Promise<Contact> {
    return this.client.request<Contact>('GET', `/api/contacts/${encodeURIComponent(phone)}`);
  }

  /**
   * Tag a contact exactly as an agent would in the inbox: onto the contact and
   * the customer's conversation (on `from`, else their latest), where the
   * ad-signal rule, the `tag.added` webhook and tag-triggered sequences and
   * flows run. If the contact has no matching conversation, the response's
   * `conversation_id` is null and the tag is saved on the contact only.
   * Needs a `send` key.
   */
  async addTag(phone: string, tag: string, opts?: FromOptions): Promise<AddContactTagResult> {
    return this.client.request<AddContactTagResult>('POST', `/api/contacts/${encodeURIComponent(phone)}/tags`, {
      json: opts?.from !== undefined ? { tag, from: opts.from } : { tag },
    });
  }

  /** Remove a tag from the contact and its conversations. Idempotent. Needs a `send` key. */
  async removeTag(phone: string, tag: string): Promise<RemoveContactTagResult> {
    return this.client.request<RemoveContactTagResult>(
      'DELETE',
      `/api/contacts/${encodeURIComponent(phone)}/tags/${encodeURIComponent(tag)}`,
    );
  }
}

class TagsResource {
  constructor(private readonly client: WhatsArab) {}

  /** Every tag in use (on contacts or conversations), most used first — for tag pickers. */
  async list(): Promise<TagCount[]> {
    return this.client.request<TagCount[]>('GET', '/api/tags');
  }
}

class WebhooksResource {
  constructor(private readonly client: WhatsArab) {}

  /**
   * Up to 3 recent real events of one type, in the delivery envelope — sample
   * data for setting up a trigger. Empty when none happened in 30 days.
   * `limit` is 1–3 (default 3); any other value falls back to 3 on the
   * server, without an error. Needs a `full` key.
   */
  async samples(event: WebhookSubscriptionEvent, opts: { limit?: number } = {}): Promise<WebhookEventSample[]> {
    const query = new URLSearchParams({ event });
    if (opts.limit !== undefined) query.set('limit', String(opts.limit));
    return this.client.request<WebhookEventSample[]>('GET', `/api/webhooks/samples?${query.toString()}`);
  }

  /** Your outbound webhook subscriptions (never their secrets). Needs a `full` key. */
  async list(): Promise<WebhookSubscription[]> {
    return this.client.request<WebhookSubscription[]>('GET', '/api/webhooks');
  }

  /**
   * Subscribe — the REST-hook «subscribe» step of an n8n / Zapier / Make
   * trigger. The `secret` is returned only here; verify deliveries with
   * `verifyWebhookSignature`. Needs a `full` key.
   */
  async create(input: CreateWebhookInput): Promise<CreatedWebhookSubscription> {
    return this.client.request<CreatedWebhookSubscription>('POST', '/api/webhooks', { json: input });
  }

  /** Unsubscribe. 404 `NOT_FOUND` when there is no such subscription. Needs a `full` key. */
  async delete(id: string): Promise<{ id: string; deleted: true }> {
    return this.client.request<{ id: string; deleted: true }>('DELETE', `/api/webhooks/${encodeURIComponent(id)}`);
  }
}

// ── Webhook verification ─────────────────────────────────────────────

/**
 * Verify an outbound webhook from WhatsArab.
 *
 * Deliveries carry `X-Whatsarab-Timestamp` and `X-Whatsarab-Signature:
 * sha256=<hex>` computed over `${timestamp}.${rawBody}` with the
 * subscription's secret.
 *
 * Pass the RAW body — the exact bytes received. A body that has been parsed and
 * re-serialized will not match, and that is the single commonest way this check
 * is got wrong.
 *
 *   app.post('/hook', express.raw({ type: 'application/json' }), (req, res) => {
 *     const ok = verifyWebhookSignature({
 *       secret: process.env.HOOK_SECRET!,
 *       rawBody: req.body,
 *       signatureHeader: req.header('x-whatsarab-signature'),
 *       timestampHeader: req.header('x-whatsarab-timestamp'),
 *     });
 *     if (!ok) return res.sendStatus(401);
 *     ...
 *   });
 */
export function verifyWebhookSignature(opts: {
  secret: string;
  rawBody: string | Uint8Array;
  signatureHeader: string | null | undefined;
  timestampHeader: string | null | undefined;
  /** Reject deliveries older than this. Default 300 s; 0 disables the check. */
  toleranceSeconds?: number;
  /** Injected in tests. Defaults to the wall clock. */
  now?: () => number;
}): boolean {
  const { secret, rawBody, signatureHeader, timestampHeader } = opts;
  if (!secret || !signatureHeader || !timestampHeader) return false;

  const tolerance = opts.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const ts = Number(timestampHeader);
    if (!Number.isFinite(ts)) return false;
    const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
    if (Math.abs(nowSec - ts) > tolerance) return false;
  }

  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;

  // require() rather than a top-level import so the browser build of this
  // package does not try to resolve node:crypto. Webhook verification only
  // happens on a server.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHmac, timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');

  const body = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  const expected = createHmac('sha256', secret).update(`${timestampHeader}.${body}`).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length through an exception — compare lengths first, in the open.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
