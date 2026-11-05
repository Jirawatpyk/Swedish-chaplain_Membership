/**
 * T104 — Resend Broadcasts gateway adapter (F7 US2).
 *
 * Concrete `BroadcastsGatewayPort` impl wrapping Resend SDK Broadcasts
 * surface (`segments.*`, the Contacts-Import endpoint,
 * `contacts.segments.remove`, `broadcasts.create`, `broadcasts.send`,
 * `broadcasts.get`). Spec 140 s4 moved the SDK calls to the Segments names;
 * the port methods and the `resend_audience_id` columns keep "audience".
 *
 * Error classification (thrown shapes per port docstring):
 *   - 5xx / network / timeout → `{kind: 'retryable', reason}`
 *   - 409 idempotency conflict → `{kind: 'idempotency_conflict', reason}`
 *   - 404 audience/broadcast → `{kind: 'resource_missing', resourceType, resourceId}`
 *   - 4xx other → `{kind: 'permanent', code, reason}`
 *
 * Retry policy: 1/2/4/8/16s backoff (CHK020) on retryable errors only, inside
 * ONE budget per request (`callTimeoutMs`, default `RESEND_CALL_TIMEOUT_MS` =
 * 10 s; spec 140 s2a): a backoff is taken only while the budget left exceeds
 * it + 1 s, so a retried call gives up within 10 s, not ~31 s. The creates
 * (`createAudience`, `createBroadcast`, `createContactImport`) make ONE
 * attempt unless Resend answered 429 (it created nothing);
 * `createContactImport`'s budget is `IMPORT_CALL_TIMEOUT_MS` (30 s). Spec 140
 * s4 deleted the legacy instance whose `createBroadcast` retried any retryable
 * error. Permanent errors throw immediately.
 *
 * Logging: pino with `redact` configured globally to drop request
 * bodies; only metadata (audienceId, broadcastId, recipientCount,
 * idempotencyKey hash) is logged.
 */
import type { Resend } from 'resend';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { RemoveContactOutcome } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import {
  IMPORT_CALL_TIMEOUT_MS,
  RESEND_CALL_TIMEOUT_MS,
  RESEND_QUOTA_EXCEEDED_CODES,
  oneCallFitsBefore,
} from '../../application/ports/broadcasts-gateway-port';
import type {
  AudienceContactCount,
  BroadcastsGatewayPort,
  CreateBroadcastInput,
  DeleteBroadcastOnceOutcome,
  GatewayRetryableSubKind,
  RetrievedBroadcastResource,
  RetrieveBroadcastOnceOutcome,
  RetrieveBroadcastOutcome,
  ListAudiencesInput,
  ListAudiencesResult,
} from '../../application/ports/broadcasts-gateway-port';
import { env } from '@/lib/env';
import { RESEND_API_BASE_URL } from '@/lib/resend-api-base-url';
import { getResendBroadcastsClient } from './resend-broadcasts-client';
import { renderBroadcastHtml } from './email-template';
import { extractBareEmail, stripAngleBrackets } from './bare-email';
import { MAX_RESEND_BROADCAST_NAME_CP } from '@/modules/broadcasts/application/format/resend-dashboard-name';

const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

/** `GET /segments` page size, and a stop for a runaway cursor. */
const LIST_AUDIENCES_PAGE_SIZE = 100;
const LIST_AUDIENCES_MAX_PAGES = 50;

interface ResendErrorShape {
  readonly statusCode?: number | null;
  readonly name?: string;
  readonly message?: string;
}

interface ResendSdkResponse<T> {
  readonly data?: T | null;
  readonly error?: ResendErrorShape | null;
}

export type GatewayThrowableKind =
  | 'retryable'
  | 'permanent'
  | 'idempotency_conflict'
  | 'resource_missing';

/**
 * `subKind` distinguishes the underlying transport class for `retryable`
 * errors so OTel metrics + alerts can split network outage from server
 * 5xx (review I6). Aliases the port-owned union (round-3 Type-1 single
 * source of truth).
 */
export type GatewayThrowableSubKind = GatewayRetryableSubKind;

/**
 * Round-4 CRIT-E — discriminated init union; only `retryable` carries
 * `subKind`; only `resource_missing` carries `resourceType` + `resourceId`;
 * only `permanent` carries `code`. Eliminates illegal combinations like
 * `(kind:'permanent', subKind:'network')` at compile time and removes
 * the `subKind ?? 'api'` default that masked classifier bugs.
 */
export type GatewayThrowableInit =
  | { readonly kind: 'retryable'; readonly subKind: GatewayThrowableSubKind; readonly reason: string }
  | { readonly kind: 'idempotency_conflict'; readonly reason: string }
  | {
      readonly kind: 'resource_missing';
      readonly resourceType: 'audience' | 'broadcast' | 'import';
      readonly resourceId: string;
      readonly reason: string;
    }
  | { readonly kind: 'permanent'; readonly code: string; readonly reason: string };

export class GatewayThrowable extends Error {
  readonly kind: GatewayThrowableKind;
  readonly subKind?: GatewayThrowableSubKind;
  readonly reason: string;
  readonly code?: string;
  readonly resourceType?: 'audience' | 'broadcast' | 'import';
  readonly resourceId?: string;

  constructor(init: GatewayThrowableInit) {
    super(init.reason);
    this.name = 'GatewayThrowable';
    this.kind = init.kind;
    this.reason = init.reason;
    if (init.kind === 'retryable') {
      this.subKind = init.subKind;
    } else if (init.kind === 'resource_missing') {
      this.resourceType = init.resourceType;
      this.resourceId = init.resourceId;
    } else if (init.kind === 'permanent') {
      this.code = init.code;
    }
  }
}

/**
 * Spec 141 review — refuse an empty identifier before the SDK sees it. On
 * resend@6.35 a falsy segment id is dropped from the path, so `contacts.list`
 * becomes `GET /contacts` (the whole account, shared by every tenant); the old
 * detach, `contacts.remove`, became `DELETE /contacts/{email}`, an ACCOUNT-WIDE
 * delete, which is why spec 140 s4 moved it to `contacts.segments.remove` and
 * the DR4 contract guard fails any such request. Every method that takes an id
 * or an email runs this first; a `null` from a nullable column is refused the
 * same way, as a `GatewayThrowable`.
 */
function isBlankId(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

function assertNonEmpty(values: Readonly<Record<string, string>>): void {
  for (const [field, value] of Object.entries(values)) {
    if (isBlankId(value)) {
      throw new GatewayThrowable({
        kind: 'permanent',
        code: 'empty_identifier',
        reason: `${field} is empty`,
      });
    }
  }
}

/**
 * Spec 140 slice 3 (DT4) — the second layer on the contact detach: a segment id
 * Resend minted is a UUID (every id it returned in the step 0 probes, research.md
 * slice 3; prod held 0 `broadcasts` rows and dev 1, UUID-shaped, on 5 Nov 2026),
 * so anything else is refused before any call, in `assertNonEmpty`'s shape with
 * its own code. Case-insensitive: Resend answers lowercase, and an uppercased id
 * names the same segment in the path. No trim: a padded id would reach the path
 * as is. Run after `assertNonEmpty`, so a blank id still answers
 * `empty_identifier`. Applied to every call that puts a segment id into the
 * path (spec 140 s4 plan review, sec L5): `removeContactFromAudience`,
 * `getAudienceContactCount` (`contacts.list`) and `deleteAudience`
 * (`segments.remove` / `segments.get`).
 */
const RESEND_SEGMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSegmentId(values: Readonly<Record<string, string>>): void {
  for (const [field, value] of Object.entries(values)) {
    if (!RESEND_SEGMENT_ID_PATTERN.test(value)) {
      throw new GatewayThrowable({
        kind: 'permanent',
        code: 'invalid_identifier',
        reason: `${field} is not a Resend segment id`,
      });
    }
  }
}

/**
 * Spec 140 s3 review round 1 (R1-K) — the email half of the detach guard. The
 * SDK puts the address into the URL path unencoded, so `/`, `?`, `#`, `%` or
 * `\` would end, re-route or (a `%2f`) be decoded into the path. Refused before
 * any call, permanent `invalid_identifier`, with a message that never carries
 * the address. `/ ? # \` fail every address validator here; `%` passes the
 * members `asEmail` pattern, so such an address, if one was ever pushed, is
 * detached by hand (`docs/runbooks/member-erasure.md` § Manual remediation).
 */
const PATH_UNSAFE_EMAIL_CHARS = /[/?#%\\]/;

function assertPathSafeEmail(email: string): void {
  if (PATH_UNSAFE_EMAIL_CHARS.test(email)) {
    throw new GatewayThrowable({
      kind: 'permanent',
      code: 'invalid_identifier',
      reason: 'email contains a character that is not safe in a URL path',
    });
  }
}

/**
 * The HTTP status the gateway acts on, read as resend@4.8 read it (spec 141,
 * the maintainer's option A, 30 Oct 2026).
 *
 * - `application_error` is the name the SDK gives every error it builds
 *   itself: a non-JSON body (an edge's or proxy's HTML page, `index.mjs:1708`)
 *   and anything its outer `catch` takes (`:1750`, `statusCode: null`) — a
 *   thrown `fetch`, but also a 2xx whose body would not parse, which the SDK
 *   cannot tell apart. 4.8 left `statusCode` undefined on the first and the
 *   classifier read 500; 6.35 passes the page's status through, so an HTML 404
 *   read as "already gone" — on the erasure path a false "already absent" in
 *   the Art. 30 record. Read it as retryable again, whatever it carries, as 4.8
 *   did; the `statusCode: null` case is tagged `network` (mostly a transport
 *   failure, sometimes an unreadable success — a retried create can then mint
 *   a second resource, as on 4.8).
 * - Any other error with `statusCode: null` is a refusal the SDK made locally
 *   without a request (`missing_required_field`, `invalid_parameter`): no
 *   retry can fix it, so it reads as a 422.
 * - A real Resend error (JSON, a specific name) keeps its status.
 */
function httpStatusOf(err: ResendErrorShape | undefined | null): number {
  if (err?.name === 'application_error') return err.statusCode === null ? 0 : 500;
  if (err?.statusCode === null) return 422;
  return err?.statusCode ?? 500;
}

/** Resend itself said the resource is gone (404 or 410) — never an edge's page. */
function isProviderGone(err: ResendErrorShape | undefined | null): boolean {
  const status = httpStatusOf(err);
  return status === 404 || status === 410;
}

/**
 * Spec 140 s4 plan review — the classification's inputs without Resend's
 * `message`, for a call whose path carries an email address: the message
 * becomes the thrown `reason`, which reaches log lines. An absent field stays
 * absent, so `httpStatusOf` reads the shape exactly as before.
 */
function statusAndNameOf(err: ResendErrorShape): ResendErrorShape {
  return {
    ...(err.statusCode !== undefined && { statusCode: err.statusCode }),
    ...(err.name !== undefined && { name: err.name }),
  };
}

function classifyResendError(
  err: ResendErrorShape | undefined | null,
  resourceType?: 'audience' | 'broadcast' | 'import',
  resourceId?: string,
): GatewayThrowable {
  const status = httpStatusOf(err);
  const reason = err?.message ?? 'unknown resend error';
  const code = err?.name ?? `http_${status}`;

  // Review I6: tag retryable errors with the transport class so OTel
  // metrics + alerts can split network outage from server-side bugs.
  if (status === 0) {
    return new GatewayThrowable({
      kind: 'retryable',
      subKind: 'network',
      reason,
    });
  }
  if (status >= 500) {
    return new GatewayThrowable({
      kind: 'retryable',
      subKind: 'server_5xx',
      reason,
    });
  }
  if (status === 429 && err?.name !== undefined && RESEND_QUOTA_EXCEEDED_CODES.includes(err.name)) {
    // Spec 140 slice 3 (DT3) — the account's sending QUOTA, not its rate: a
    // DOCUMENTED 429 that does not clear inside a call, nor inside FR-021's
    // hour (a daily quota may reset inside it; the spec chose permanent). The
    // name is kept as the code, which the failure metric maps to `resend_429`.
    return new GatewayThrowable({ kind: 'permanent', reason, code });
  }
  if (status === 429) {
    // Resend's account rate limit — measured at 10 req/s, not the 2 this
    // said before T095 (2026-09-08). The request is fine —
    // it was merely too fast — so back off and retry rather than treating
    // it as a permanent failure that kills the whole broadcast (BUG-028).
    // Without this branch a 429 fell through to `permanent` below and
    // withRetry rethrew immediately with no backoff.
    return new GatewayThrowable({
      kind: 'retryable',
      subKind: 'api',
      reason,
    });
  }
  if (status === 409 && err?.name === 'resource_locked') {
    // Spec 140 slice 3 (DT3) — another request is updating the resource; this
    // one was not refused, so it is retried (inside one call's budget; a create
    // retries a 429 only, `isRateLimited`). Every other 409 keeps the
    // idempotency reading below.
    return new GatewayThrowable({ kind: 'retryable', subKind: 'locked', reason });
  }
  if (status === 409) {
    return new GatewayThrowable({
      kind: 'idempotency_conflict',
      reason,
    });
  }
  if (status === 404 && resourceType !== undefined && resourceId !== undefined) {
    return new GatewayThrowable({
      kind: 'resource_missing',
      reason,
      resourceType,
      resourceId,
    });
  }
  return new GatewayThrowable({ kind: 'permanent', reason, code });
}

/**
 * Spec 140 s2a — the least time an attempt after a backoff must have left. A
 * retry is made only while the budget left exceeds the next backoff + this.
 */
const RETRY_MIN_ATTEMPT_MS = 1_000;

/** A 429: `classifyResendError` gives it, and only it, `retryable` / `api`. */
function isRateLimited(e: unknown): boolean {
  return e instanceof GatewayThrowable && e.kind === 'retryable' && e.subKind === 'api';
}

/**
 * Spec 140 s2a (DL5a, DL8, P6) — one bounded gateway call.
 *
 * ONE `AbortSignal.timeout(callTimeoutMs)` spans every attempt and every
 * backoff, so a retried call never takes longer than `callTimeoutMs` in total;
 * a per-attempt signal would let six attempts run ~6 × C. Every attempt hands
 * the signal to its request (the SDK's `RequestOptions.signal` reaches
 * `fetch`, `node_modules/resend/dist/index.mjs` `fetchRequest`).
 *
 * Once the signal has aborted, the failure is `retryable` / `timeout`,
 * whatever shape it arrived in: the SDK's outer catch turns an aborted `fetch`
 * (or an aborted `response.json()`) into `application_error` with
 * `statusCode: null`, and a raw `fetch` rejects with a `TimeoutError`, before
 * or mid-body.
 *
 * `retry: 'rate_limit'` (the creates) retries a 429 only: Resend refused the
 * request for its rate and created nothing. Anything else that may have
 * reached Resend (a 5xx, a network failure, a timeout) is one attempt, because
 * a retried create that reached Resend mints a second resource; a failed
 * create waits for the next tick, inside the FR-021 hour (review round 1,
 * CR#1). `retry: 'retryable'` retries every retryable error (the reads, the
 * deletes and `/send`). A timeout is never retried: the signal is spent.
 */
async function boundedCall<T>(
  op: (signal: AbortSignal) => Promise<T>,
  ctx: {
    readonly method: string;
    readonly callTimeoutMs: number;
    readonly retry: 'retryable' | 'rate_limit';
  },
): Promise<T> {
  const signal = AbortSignal.timeout(ctx.callTimeoutMs);
  const deadline = Date.now() + ctx.callTimeoutMs;
  let lastErr: unknown = null;
  for (let attempt = 0; ; attempt++) {
    try {
      return await op(signal);
    } catch (e) {
      lastErr = e;
      // Only retry on `retryable` kind; everything else throws immediately
      if (e instanceof GatewayThrowable && e.kind !== 'retryable') {
        throw e;
      }
      if (signal.aborted) {
        throw new GatewayThrowable({
          kind: 'retryable',
          subKind: 'timeout',
          reason: `${ctx.method} gave up after ${ctx.callTimeoutMs} ms`,
        });
      }
      const backoff = RETRY_BACKOFF_MS[attempt];
      if (
        (ctx.retry === 'rate_limit' && !isRateLimited(e)) ||
        backoff === undefined ||
        deadline - Date.now() <= backoff + RETRY_MIN_ATTEMPT_MS
      ) {
        break;
      }
      // Review round 2 — annotated with its class (check:log-error-objects TOKEN_FIELDS_BY_TYPE).
      const subKind: GatewayThrowable['subKind'] | undefined = e instanceof GatewayThrowable ? e.subKind : undefined;
      logger.warn(
        {
          method: ctx.method,
          attempt: attempt + 1,
          backoffMs: backoff,
          // Class + kind, never the provider's free text (108 Phase 9 review
          // S15). Only `retryable` errors reach this line, so a 4xx echoing a
          // submitted row cannot appear here today — but the classification
          // that keeps it out lives four lines up and is one edit away from
          // changing. The redaction in `logger.ts` is key-based and covers
          // neither `err` nor `message`.
          err: e instanceof Error ? e.constructor.name : 'unknown',
          errorKind: e instanceof GatewayThrowable ? e.kind : undefined,
          subKind,
        },
        'resend.broadcasts.retry',
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  // Review #17: ALWAYS rethrow as GatewayThrowable so callers can rely
  // on `instanceof GatewayThrowable` + `.kind` discrimination. A bare
  // SDK throwable that bypassed classification escapes as `retryable`
  // with `subKind: 'timeout'`.
  if (lastErr instanceof GatewayThrowable) throw lastErr;
  const reason =
    lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown retryable error');
  throw new GatewayThrowable({ kind: 'retryable', subKind: 'timeout', reason });
}

function client(): Resend {
  return getResendBroadcastsClient();
}

export interface ResendBroadcastsGatewayOptions {
  /**
   * The budget of one request, its retries and backoff included. Default
   * {@link RESEND_CALL_TIMEOUT_MS}; tests pass 50 ms. A port call that makes
   * several requests (`listAudiences`, per page) has this budget PER REQUEST,
   * so it can run N x C. The per-invocation budgets: the import leg's tick
   * (spec 140 slice 2b) and `listAudiences`' caller `deadlineAt` (slice 3, DT5).
   */
  readonly callTimeoutMs?: number;
  /**
   * Spec 140 s2a review round 2 (CR#3) — `createContactImport`'s budget
   * (one attempt, a 429 aside). Default {@link IMPORT_CALL_TIMEOUT_MS}.
   */
  readonly importCallTimeoutMs?: number;
}

/** Spec 140 s2a — a gateway whose every request is bounded by `callTimeoutMs`. */
export function createResendBroadcastsGateway({
  callTimeoutMs = RESEND_CALL_TIMEOUT_MS,
  importCallTimeoutMs = IMPORT_CALL_TIMEOUT_MS,
}: ResendBroadcastsGatewayOptions = {}): BroadcastsGatewayPort {
  return {
    async createAudience(name: string): Promise<{ readonly audienceId: string }> {
      return boundedCall(
        async (signal) => {
          const sdk = client();
          const result = (await sdk.segments.create({ name }, { signal })) as ResendSdkResponse<{
            id: string;
          }>;
          if (result.error || !result.data?.id) {
            throw classifyResendError(result.error ?? undefined, 'audience');
          }
          logger.info(
            { audienceId: result.data.id },
            'resend.broadcasts.audience_created',
          );
          return { audienceId: result.data.id };
        },
        { method: 'createAudience', callTimeoutMs, retry: 'rate_limit' },
      );
    },

    async createBroadcast(
      input: CreateBroadcastInput,
    ): Promise<{ readonly broadcastId: string }> {
      assertNonEmpty({ audienceId: input.audienceId });
      // Spec 140 DT1 — the second layer: Resend refuses a `name` over 70 code
      // points, and that refusal ends the E-Blast. The callers cap it
      // (`resendDashboardName`); a caller that does not is refused here,
      // before any request, in the same permanent shape as `assertNonEmpty`.
      if ([...input.broadcastNameForResendDashboard].length > MAX_RESEND_BROADCAST_NAME_CP) {
        throw new GatewayThrowable({
          kind: 'permanent',
          code: 'broadcast_name_too_long',
          reason: `broadcast name exceeds ${MAX_RESEND_BROADCAST_NAME_CP} code points`,
        });
      }
      return boundedCall(
        async (signal) => {
          const sdk = client();
          // T147 — wrap the sanitised inner body with the chamber-branded
          // shell + locale-aware footer (FR-029). The footer carries the
          // unsubscribe CTA via Resend's `{{{RESEND_UNSUBSCRIBE_URL}}}`
          // merge tag — Resend substitutes per-recipient at send time.
          const wrappedHtml = renderBroadcastHtml({
            subject: input.subject,
            bodyHtml: input.htmlBody,
            tenantDisplayName: input.tenantDisplayName,
            locale: input.locale,
            // F119 T031 — live brand chrome; omitted ⇒ byte-identical to pre-F119.
            ...(input.brand !== undefined ? { brand: input.brand } : {}),
          });
          const bareFromEmail = extractBareEmail(input.fromEmail);
          // Finding B — strip `<`/`>` from the display name so a member company
          // name containing angle brackets cannot produce a nested, invalid
          // RFC 5322 `from` header that Resend rejects (permanent
          // failed_to_dispatch). `extractBareEmail` only sanitises the address.
          const safeFromName = stripAngleBrackets(input.fromName);
          const result = (await sdk.broadcasts.create({
            segmentId: input.audienceId,
            from: `${safeFromName} <${bareFromEmail}>`,
            subject: input.subject,
            html: wrappedHtml,
            replyTo: input.replyToEmail,
            name: input.broadcastNameForResendDashboard,
          }, { signal })) as ResendSdkResponse<{ id: string }>;
          if (result.error || !result.data?.id) {
            throw classifyResendError(result.error ?? undefined, 'broadcast');
          }
          logger.info(
            {
              broadcastId: result.data.id,
              audienceId: input.audienceId,
              subjectLength: input.subject.length,
            },
            'resend.broadcasts.broadcast_created',
          );
          return { broadcastId: result.data.id };
        },
        { method: 'createBroadcast', callTimeoutMs, retry: 'rate_limit' },
      );
    },

    async sendBroadcast(
      broadcastId: string,
      idempotencyKey: string,
    ): Promise<void> {
      assertNonEmpty({ broadcastId });
      await boundedCall(
        async (signal) => {
          const sdk = client();
          // Spec 141: resend@6.35.0 fixed this upstream — `broadcasts.send(id,
          // payload, requestOptions)` now forwards the options to `post()`
          // (`node_modules/resend/dist/index.mjs:310`). The raw `post()` below is
          // kept, pinned on the wire by `tests/contract/resend/`; moving to
          // `broadcasts.send` is spec 140's call. The 4.8 history follows.
          //
          // ⚠️ NOT `sdk.broadcasts.send(...)`. Round 3 finding 3-1: in
          // resend@4.8.0 that helper is
          //   `send(id, payload) => this.resend.post(path, {scheduled_at})`
          // — TWO arguments (`node_modules/resend/dist/index.js:252`). The
          // `Idempotency-Key` header is set ONLY from `post()`'s THIRD `options`
          // argument (`:599`), which the sibling `broadcasts.create` does pass and
          // `send` does not. Its own `.d.ts` declares an unused
          // `SendBroadcastRequestOptions extends PostOptions`, so the omission
          // looks like an oversight upstream rather than a design.
          //
          // The key was therefore NEVER transmitted, and the previous line here
          // asserted the opposite ("Resend SDK accepts idempotencyKey as a request
          // option") while an `as Parameters<...>[1]` cast suppressed the tsc
          // error that would have said so. A comment plus a cast is how a missing
          // guarantee survives a green suite.
          //
          // `post<T>` is public and typed on the `Resend` class
          // (`index.d.ts:833`), so this is the SDK's own API, not a raw fetch.
          // Body `{}` matches what the helper sends: `{scheduled_at: undefined}`
          // serialises to `{}`.
          //
          // What a replay meets: MEASURED 2026-10-29, the key changes nothing —
          // a `boundedCall` replay INSIDE one tick (a lost response, or a 5xx after
          // Resend already accepted the send) is answered `422 validation_error
          // "Only draft broadcasts can be sent or scheduled"` whatever the key,
          // and Resend delivers once. That 422 is classified `permanent` below;
          // the dispatch tick probes it (`_probe-refused-send.ts`) rather than
          // record a failure for mail that went out.
          //
          // What it does NOT close: `createBroadcast` carries no key at all, so
          // a re-entered tick that minted again would send a NEW resource, where
          // no key can help. The tick does not rely on the key for that: it
          // persists the minted id BEFORE this call (`attachBroadcastId`) and a
          // re-entered tick probes it (`retrieveBroadcast`) and reuses it — S8,
          // in `build-audience-tick.ts`.
          const result = (await sdk.post(`/broadcasts/${broadcastId}/send`, {}, {
            idempotencyKey,
            signal,
          })) as ResendSdkResponse<{ id: string }>;
          if (result.error) {
            throw classifyResendError(
              result.error ?? undefined,
              'broadcast',
              broadcastId,
            );
          }
          logger.info(
            { broadcastId, idempotencyKeyHash: idempotencyKey.slice(0, 16) },
            'resend.broadcasts.broadcast_sent',
          );
        },
        { method: 'sendBroadcast', callTimeoutMs, retry: 'retryable' },
      );
    },

    async getAudienceContactCount(
      audienceId: string,
    ): Promise<AudienceContactCount> {
      // IMP-5 — query Resend for the contact count on an audience.
      //
      // Round 4 F1 residual — this said "(paginated). For MVP we list and return
      // `data.length`", and then threw away the only thing that made the caveat
      // actionable. MEASURED against the live account 2026-09-09: the response's
      // top-level keys are exactly `data,has_more,object`. The endpoint TELLS us
      // when the list is short, and we were not reading it.
      //
      // resend@4.8.0 modelled neither half (`ListContactsOptions` was
      // `{ audienceId }`, `ListContactsResponseSuccess` was `{ object, data }`),
      // so `has_more` is read off the runtime shape; 6.35 declares it, and the
      // read is unchanged. On 6.35 this call goes to `/segments/{id}/contacts`:
      // MEASURED 2026-10-30 with 110 contacts, both paths return all 110 with
      // `has_more: false` (spec 141); spec 140 s4 passes `segmentId`, the same
      // path (step 0 item 2). Narrowed with `=== false`, so
      // that a missing field reads as "not complete": an absent signal must not be
      // reported as a verified-complete count. Because the field is undeclared, a
      // provider rename cannot fail the build — only this narrowing direction
      // protects the caller, and only the wire-level test protects the narrowing.
      //
      // No `resource_missing` → `not_found` mapping any more. This endpoint does
      // not 404 a missing audience (MEASURED 2026-09-10: `200` + empty list), so
      // the arm that used to sit here had no reachable input, and the callers'
      // handling of the value it never produced was dead code that read as
      // covered. If Resend ever changes that, the throw reaches the caller's
      // unverifiable arm, which is where "we could not count" already goes.
      assertNonEmpty({ audienceId });
      assertSegmentId({ audienceId });
      return await boundedCall(
        async (signal) => {
          const sdk = client();
          const result = (await sdk.contacts.list({ segmentId: audienceId }, { signal })) as ResendSdkResponse<{
            data: ReadonlyArray<unknown>;
            has_more?: boolean;
          }>;
          if (result.error) {
            throw classifyResendError(
              result.error ?? undefined,
              'audience',
              audienceId,
            );
          }
          return {
            // BOTH levels need `?.`: with only the outer one a payload-less 200
            // threw a TypeError, which `boundedCall` retries (it short-circuits
            // only a `GatewayThrowable`) for 31 s and rethrows as a transport
            // timeout.
            count: result.data?.data?.length ?? 0,
            // True only on positive evidence — `has_more: true`, an absent field
            // and a missing payload all mean "unverifiable". Pinned per case in
            // `resend-audience-contact-count.test.ts`.
            complete: result.data?.has_more === false,
          };
        },
        { method: 'getAudienceContactCount', callTimeoutMs, retry: 'retryable' },
      );
    },

    async retrieveBroadcast(
      broadcastId: string,
    ): Promise<RetrieveBroadcastOutcome> {
      assertNonEmpty({ broadcastId });
      try {
        const resource = await boundedCall(
          async (signal): Promise<RetrievedBroadcastResource | null> => {
            const sdk = client();
            const result = (await sdk.broadcasts.get(broadcastId, { signal })) as ResendSdkResponse<{
              id: string;
              status: string;
              sent_at?: string | null;
            }>;
            if (result.error) {
              throw classifyResendError(
                result.error ?? undefined,
                'broadcast',
                broadcastId,
              );
            }
            if (!result.data) return null;
            return {
              id: result.data.id,
              status: normaliseStatus(result.data.status),
              sentAt: result.data.sent_at ?? null,
            };
          },
          { method: 'retrieveBroadcast', callTimeoutMs, retry: 'retryable' },
        );
        if (resource === null) return { kind: 'not_found' };
        return { kind: 'present', resource };
      } catch (e) {
        if (e instanceof GatewayThrowable && e.kind === 'resource_missing') {
          return { kind: 'not_found' };
        }
        throw e;
      }
    },

    /**
     * Spec 139 review round 1 — the port docblock has the contract. A raw
     * `fetch` with the same `callTimeoutMs` bound (10 s) as {@link deleteBroadcastOnce}, because
     * the erasure cascade calls it under the broadcast row's lock. The log line
     * carries the HTTP status and the outcome only, never the body.
     */
    async retrieveBroadcastOnce(broadcastId: string): Promise<RetrieveBroadcastOnceOutcome> {
      // One attempt and an outcome, never a throw: an empty id would read the
      // broadcast LIST at `/broadcasts/`, so it is unclassified, with no request.
      if (isBlankId(broadcastId)) return { kind: 'other' };
      let res: Response;
      try {
        res = await fetch(`${RESEND_API_BASE_URL}/broadcasts/${encodeURIComponent(broadcastId)}`, {
          method: 'GET',
          signal: AbortSignal.timeout(callTimeoutMs),
          headers: { Authorization: `Bearer ${env.broadcasts.apiKey}` },
        });
      } catch (e) {
        logger.warn(
          { broadcastId, err: errKind(e), timedOut: isTimeout(e) },
          'resend.broadcasts.retrieve_once_transport_failed',
        );
        return { kind: 'retryable' };
      }
      // Spec 140 s2a — a body that stalls past the budget is a timeout, not an
      // unreadable answer.
      const text = await res.text().catch(() => null);
      if (text === null) return { kind: 'retryable' };
      const outcome = retrieveOnceOutcomeFor(rawHttpStatusOf(res.status, text), text);
      logger.info({ broadcastId, status: res.status, outcome: outcome.kind }, 'resend.broadcasts.retrieve_once');
      return outcome;
    },

    async removeContactFromAudience(
      audienceId: string,
      email: string,
    ): Promise<RemoveContactOutcome> {
      assertNonEmpty({ audienceId, email });
      assertSegmentId({ audienceId });
      assertPathSafeEmail(email);
      // Spec 140 s4 — the segment-scoped detach, `contacts.segments.remove`
      // (`DELETE /contacts/{email}/segments/{id}`), never `contacts.remove`,
      // whose id-less form is the account-wide `DELETE /contacts/{email}` (DR4).
      // The email goes to the SDK as given: it puts it in the path unencoded,
      // and Resend reads a `+` literally and matches the address
      // case-SENSITIVELY (MEASURED 5 Nov 2026, research.md slice 4 step 0 item
      // 1). So it is neither encoded nor re-cased here: the address sent is the
      // one given, which is lowercase because the erasure capture is lowercase
      // and the only push, `createContactImport`, lowercases.
      const absent = await boundedCall(
        async (signal) => {
          const sdk = client();
          const result = (await sdk.contacts.segments.remove({
            email,
            segmentId: audienceId,
          }, { signal })) as ResendSdkResponse<{ object?: string; deleted?: boolean }>;
          if (result.error) {
            // A 404 → the contact was not in that segment, or the segment does
            // not exist → nothing to detach. Since spec 140 s4 this fires: on
            // this endpoint every no-op answered `404 not_found` (random
            // segment, wrong case, non-member) and only a membership that
            // existed answered `200 deleted:true` (MEASURED 5 Nov 2026,
            // research.md slice 4 step 0 items 1 and 4). A 410 Gone means the
            // same, as on the siblings `deleteAudience` / `deleteBroadcast`
            // (PR #756 review round 1, code-review #4). An HTML 404 / 410 is not
            // Resend's answer and stays retryable (`httpStatusOf`).
            if (isProviderGone(statusAndNameOf(result.error))) return true;
            // Status and name only, never Resend's message: the thrown reason
            // reaches log lines, and a later wording change could put the
            // address into it (spec 140 s4 plan review). The step 0 404 bodies
            // carried none.
            throw classifyResendError(statusAndNameOf(result.error), 'audience', audienceId);
          }
          // `detached` becomes a removal in an append-only Art. 30 record, so
          // it needs Resend's own `deleted: true` (MEASURED: `200
          // {"object":"contact_segment","deleted":true}`). A 200 without it
          // was never seen; it is not read as a detach. Permanent, so the
          // erasure record counts it failed and the runbook remediates it.
          if (result.data?.deleted !== true) {
            throw new GatewayThrowable({
              kind: 'permanent',
              code: 'detach_unconfirmed',
              reason: 'the segment detach answered without deleted: true',
            });
          }
          return false;
        },
        { method: 'removeContactFromAudience', callTimeoutMs, retry: 'retryable' },
      );
      // Round 2 R2-25 — an absent contact is reported as `already_absent`, never
      // as `detached`: the caller counts detaches into
      // `resend_contacts_removed_count`, an append-only Art. 30 record shown to a
      // DPO, and a removal that did not happen is a false statement under
      // Art. 12(3). (PR #756 review round 2, code-review #6: the `resource_missing`
      // catch that used to sit here was unreachable, since the classifier gives
      // that kind only to a 404, which `isProviderGone` already answered.)
      if (absent) {
        logger.info({ audienceId }, 'resend.broadcasts.contact_already_absent');
        return { kind: 'already_absent' };
      }
      logger.info({ audienceId }, 'resend.broadcasts.contact_detached');
      return { kind: 'detached' };
    },

    async listAudiences({ deadlineAt }: ListAudiencesInput): Promise<ListAudiencesResult> {
      // Spec 141: on resend@6.35 `segments.list` (spec 140 s4; `audiences` is
      // its alias) is the paginated `GET /segments`, so follow `has_more`
      // (cursor = the last id) instead of
      // reading page 1 only — reclaim-orphaned-audiences must see EVERY audience.
      // Each page is its own `boundedCall`, so a retry never re-reads earlier pages.
      const byId = new Map<string, { id: string; name: string; created_at: string }>();
      const seenCursors = new Set<string>();
      let after: string | undefined;
      let truncatedBy: 'deadline' | 'max_pages' | 'empty_page' | 'repeated_cursor' | null = null;
      for (let page = 0; ; page += 1) {
        if (page === LIST_AUDIENCES_MAX_PAGES) {
          truncatedBy = 'max_pages';
          break;
        }
        // Spec 140 DT5 — the caller's per-invocation budget: a page starts only
        // while one bounded call still fits before `deadlineAt`, so the listing
        // ends inside it (the page bound above stays as the runaway stop). The
        // use case's delete chunks judge with the same rule (R1-H).
        if (!oneCallFitsBefore(deadlineAt, Date.now(), callTimeoutMs)) {
          truncatedBy = 'deadline';
          break;
        }
        const result = await boundedCall(
          async (signal) => {
            const sdk = client();
            const res = (await sdk.segments.list({
              limit: LIST_AUDIENCES_PAGE_SIZE,
              ...(after !== undefined && { after }),
            }, { signal })) as ResendSdkResponse<{
              object: string;
              has_more?: boolean;
              data: ReadonlyArray<{ id: string; name: string; created_at: string }>;
            }>;
            if (res.error) {
              throw classifyResendError(res.error ?? undefined, 'audience');
            }
            return res.data;
          },
          { method: 'listAudiences', callTimeoutMs, retry: 'retryable' },
        );
        const pageRows = result?.data ?? [];
        for (const r of pageRows) byId.set(r.id, r);
        const last = pageRows.at(-1);
        if (result?.has_more !== true) break;
        // `has_more` with an empty page leaves no cursor to follow: the list is cut.
        if (last === undefined) {
          truncatedBy = 'empty_page';
          break;
        }
        // A cursor seen before would page forever over the same rows.
        if (seenCursors.has(last.id)) {
          truncatedBy = 'repeated_cursor';
          break;
        }
        seenCursors.add(last.id);
        after = last.id;
      }
      const rows = [...byId.values()];
      const truncated = truncatedBy !== null;
      if (truncated) {
        // Reclaim then sees fewer audiences than exist: it deletes less, never
        // more, but say so rather than pass a cut list off as the whole.
        logger.warn({ audienceCount: rows.length, truncatedBy }, 'resend.broadcasts.audiences_list_truncated');
      }
      logger.info({ audienceCount: rows.length, truncated }, 'resend.broadcasts.audiences_listed');
      // Parse at the adapter boundary so callers work with Date, not raw strings.
      return {
        audiences: rows.map((r) => ({ id: r.id, name: r.name, createdAt: new Date(r.created_at) })),
        truncated,
      };
    },

    async deleteAudience(audienceId: string): Promise<void> {
      assertNonEmpty({ audienceId });
      // PR #756 review round 2 (code-review #3) — an id that is not UUID-shaped
      // names no segment Resend could hold (every id it returns is a UUID), so
      // the delete's goal is already met: resolve as gone with NO request, rather
      // than a permanent `invalid_identifier` the cleanup cron would re-fail every
      // tick (dev litter such as `aud_fake_N`). The warn names the id's class,
      // never the id. The detach and the count still refuse such an id
      // (`assertSegmentId`): an id-less call there is account-wide.
      if (!RESEND_SEGMENT_ID_PATTERN.test(audienceId)) {
        logger.warn(
          { idClass: audienceId.startsWith('aud_') ? 'aud_prefixed' : 'not_a_segment_id' },
          'resend.broadcasts.audience_id_not_a_segment',
        );
        return;
      }
      await boundedCall(
        async (signal) => {
          const sdk = client();
          const result = (await sdk.segments.remove(audienceId, { signal })) as ResendSdkResponse<{
            deleted: boolean;
            id: string;
            object: string;
          }>;
          if (result.error) {
            // Finding H — 404 Not Found AND 410 Gone both mean the audience is
            // already absent → the delete goal is met (idempotent early-return).
            // Without the 410 branch, a Resend 410 would fall through to
            // `classifyResendError` → `permanent`, and the cleanup row would
            // re-fail every cron tick forever.
            if (isProviderGone(result.error)) {
              logger.info({ audienceId }, 'resend.broadcasts.audience_already_absent');
              return; // idempotent: already gone
            }
            const refused = classifyResendError(result.error ?? undefined, 'audience', audienceId);
            // Spec 140 s2c Verify finding — MEASURED 2026-11-03 on the sink
            // account while it held only the `General` segment: a DELETED
            // audience answers DELETE 403 `validation_error` "Cannot delete last
            // audience." (Resend checks "last audience" before the id), while
            // GET answers 404. So a 403, and only a 403, is probed ONCE, on the
            // same signal (inside this call's budget): 404 / 410 → already gone;
            // anything else (found, 5xx, a throw) → the DELETE's own `permanent`
            // classification, which `boundedCall` does not retry.
            if (httpStatusOf(result.error) === 403) {
              let probe: ResendSdkResponse<{ id: string }> | null = null;
              try {
                probe = (await sdk.segments.get(audienceId, { signal })) as ResendSdkResponse<{ id: string }>;
              } catch {
                throw refused;
              }
              if (probe.error && isProviderGone(probe.error)) {
                logger.info({ audienceId, via: 'probe_after_403' }, 'resend.broadcasts.audience_already_absent');
                return;
              }
            }
            throw refused;
          }
          logger.info({ audienceId }, 'resend.broadcasts.audience_deleted');
        },
        { method: 'deleteAudience', callTimeoutMs, retry: 'retryable' },
      );
    },

    /**
     * Reclaim a broadcast resource this tick minted and could not persist. The
     * exact shape of `deleteAudience` above, for the same reason: 404 and 410
     * both mean "already gone", which is the goal, so they resolve instead of
     * falling into `classifyResendError` → `permanent`.
     *
     * `DELETE /broadcasts/{id}` was exercised against the live account on
     * 2026-09-10 (the `'draft'` measurement was taken by creating a broadcast and
     * deleting it), so unlike the idempotency header this is a call whose happy
     * path is known to work, not assumed to.
     */
    async deleteBroadcast(broadcastId: string): Promise<void> {
      assertNonEmpty({ broadcastId });
      await boundedCall(
        async (signal) => {
          const sdk = client();
          const result = (await sdk.broadcasts.remove(broadcastId, { signal })) as ResendSdkResponse<{
            deleted: boolean;
            id: string;
            object: string;
          }>;
          if (result.error) {
            if (isProviderGone(result.error)) {
              logger.info({ broadcastId }, 'resend.broadcasts.broadcast_already_absent');
              return; // idempotent: already gone
            }
            throw classifyResendError(result.error ?? undefined, 'broadcast', broadcastId);
          }
          logger.info({ broadcastId }, 'resend.broadcasts.broadcast_deleted');
        },
        { method: 'deleteBroadcast', callTimeoutMs, retry: 'retryable' },
      );
    },

    /**
     * Spec 139 P1 — the port docblock has the contract. A raw `fetch`, like
     * `importFetch`, because the SDK took no `signal` when this was written
     * (resend@4.8.0; 6.32+ accepts one, adopted by spec 140) and this
     * call must not outlive the gateway's `callTimeoutMs` (10 s) while the caller holds
     * a row lock. One attempt; the outcome is the status class, never the
     * provider's text (the log line carries the HTTP status only).
     */
    async deleteBroadcastOnce(broadcastId: string): Promise<DeleteBroadcastOnceOutcome> {
      // As `retrieveBroadcastOnce`: an empty id is unclassified, with no request.
      if (isBlankId(broadcastId)) return { kind: 'other' };
      let res: Response;
      try {
        res = await fetch(`${RESEND_API_BASE_URL}/broadcasts/${encodeURIComponent(broadcastId)}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(callTimeoutMs),
          headers: { Authorization: `Bearer ${env.broadcasts.apiKey}` },
        });
      } catch (e) {
        // A timeout, an abort or a transport failure: whether the DELETE reached
        // Resend is unknown, so nothing is decided.
        logger.warn(
          { broadcastId, err: errKind(e), timedOut: isTimeout(e) },
          'resend.broadcasts.delete_once_transport_failed',
        );
        return { kind: 'retryable' };
      }
      // The body decides one thing only: whether an error came from Resend.
      // As `retrieveBroadcastOnce`: a stalled body is a timeout.
      const text = await res.text().catch(() => null);
      if (text === null) return { kind: 'retryable' };
      const outcome = deleteOnceOutcomeFor(rawHttpStatusOf(res.status, text));
      logger.info({ broadcastId, status: res.status, outcome: outcome.kind }, 'resend.broadcasts.delete_once');
      return outcome;
    },

    /**
     * T086 — hand the WHOLE audience to Resend in one multipart request.
     *
     * Replaced the per-contact push loop (deleted in spec 140 s4), which was
     * serial and therefore bounded by latency (~2.08 req/s measured, so ~623
     * contacts per 300 s function). This call is size-independent: ~412 ms for one address and the
     * same for thousands, because Resend processes the CSV asynchronously and
     * answers with a job id. `getContactImport` below is how we learn it landed.
     *
     * Field shapes are not negotiable and are pinned by value in
     * `tests/unit/broadcasts/infrastructure/resend-contact-import.test.ts`:
     *
     *   - `segments` is an array of OBJECTS, `[{ id }]`. `[<id>]` is a 422, and
     *     `audience_id` — the spelling two 2026-09-08 probes used — is accepted
     *     and SILENTLY IGNORED, which is how "the import does not attach to an
     *     audience" became a recorded fact for a day.
     *   - `column_map` maps `email` only. The CSV must carry no `unsubscribed`
     *     column: research V2 measured that `on_conflict=upsert` preserves a
     *     contact's unsubscribed flag precisely while that column is absent, and
     *     that measurement is the only reason `upsert` is lawful here
     *     (GDPR Art. 21 / PDPA section 32). Adding the column would resurrect
     *     everyone who ever pressed unsubscribe.
     *   - `upsert` also makes a resubmitted import harmless, which is what lets
     *     the caller retry a tick without tracking partial progress.
     */
    /**
     * Spec 140 s2a (DL5a): ONE attempt, no in-process retry, a 429 aside (it
     * created nothing; review round 1, CR#1). It carries no
     * idempotency key, because `POST /contacts/imports` does not accept one
     * (108 Phase 9 review S18), so a retry after the request reached Resend made
     * a second import job; a failed submit now waits for the next tick. The
     * history of the retry this used to have follows.
     *
     * A transport failure AFTER the request reached Resend therefore creates a
     * SECOND import job, and only the second id is stored. State stays correct —
     * `on_conflict=upsert` means both jobs converge on the same contact set, so
     * the counts the completion rule reads still match — but it burns contact
     * quota and orphans a job nothing will ever poll. On the Free plan's 1,000
     * contacts that is worth knowing before a large send.
     *
     * Not fixed here because the honest fixes both cost more than the defect:
     * dropping the retry makes a routine network blip fail a broadcast, and
     * de-duplicating would mean listing recent imports and matching them by
     * audience — a second provider round trip on every submit to save a rare
     * duplicate. Recorded instead of silently retried.
     */
    async createContactImport(
      audienceId: string,
      emails: readonly string[],
    ): Promise<{ readonly importId: string }> {
      assertNonEmpty({ audienceId });
      return boundedCall(
        async (signal) => {
          // BOUNDARY VALIDATION (108 Phase 9 review S16). `EmailLower` looks like
          // a guarantee and is not: `unsafeBrandEmailLower` is `return raw as
          // EmailLower` with no validation, and it is what feeds every path into
          // this method. So the CSV's safety rested entirely on validation done
          // when the address was written to the database, with nothing re-checking
          // it here.
          //
          // An address containing \n or \r injects an extra CSV row — creating a
          // contact in the audience that was never in the resolved list. One with
          // a comma or a quote shifts columns. The completion rule DOES catch the
          // injected-row case downstream (`total !== resolvedCount` refuses the
          // send), but only AFTER the contact exists at Resend: that is a
          // backstop, not a boundary. Refuse here so the bad row is never created.
          const unsafe = emails.filter((e) => /[\r\n",]/.test(e));
          if (unsafe.length > 0) {
            throw classifyResendError({
              statusCode: 422,
              name: 'unsafe_recipient_format',
              // Count only — never echo the addresses into an error whose message
              // reaches a log line (S15 is about exactly that path).
              message: `${unsafe.length} recipient address(es) contain CSV control characters`,
            });
          }
          // Spec 140 s3 Verify finding — Resend matches a segment contact by its
          // exact case (MEASURED 5 Nov 2026: `DELIVERED.x@` and `delivered.x@`
          // are two contacts, and a DELETE with the other case answers 200
          // `deleted: true` while removing nothing). The erasure detach sends the
          // lowercased address, so a mixed-case push would leave an erased
          // member in a live segment while the Art. 30 record says detached.
          // `EmailLower` is a brand, not a check (see above), so each address is
          // lowercased here (spec 140 s3 review round 1, R1-A; it was refused,
          // which failed the whole E-Blast for an address every producer
          // already lowercases). Not de-duplicated: two addresses that collide
          // once lowercased make Resend's count differ from the resolved count,
          // and the completion rule refuses the send.
          const csv = ['email', ...emails.map((e) => e.toLowerCase())].join('\n') + '\n';
          const form = new FormData();
          form.append('file', new Blob([csv], { type: 'text/csv' }), 'audience.csv');
          form.append('column_map', JSON.stringify({ email: 'email' }));
          form.append('on_conflict', 'upsert');
          form.append('segments', JSON.stringify([{ id: audienceId }]));

          const body = await importFetch('/contacts/imports', {
            method: 'POST',
            body: form,
          }, signal);
          if (body.id === undefined || body.id === '') {
            // A 2xx with no id is unusable and cannot be retried into existence.
            throw classifyResendError({
              statusCode: 502,
              name: 'malformed_import_response',
              message: 'contact import accepted but returned no id',
            });
          }
          logger.info(
            { audienceId, importId: body.id, recipientCount: emails.length },
            'resend.broadcasts.contact_import_submitted',
          );
          return { importId: body.id };
        },
        { method: 'createContactImport', callTimeoutMs: importCallTimeoutMs, retry: 'rate_limit' },
      );
    },

    /**
     * T086 — poll one import.
     *
     * Returns `status` and `counts` VERBATIM. The completion decision belongs to
     * the caller (contract section 4: `completed` AND `failed === 0` AND
     * `created + updated + skipped === total` AND `total` equals the resolved
     * count), and it is load-bearing rather than defensive: one import in five
     * identical probes returned `completed` with `failed: 0` and `total: 0` and
     * attached nothing (research R9 V2 (c)). Smoothing that into "it finished,
     * so it worked" here would send a broadcast to an empty audience.
     *
     * Absent counts (a `pending` import has none) become zeros rather than
     * `undefined`, so arithmetic on them is comparable rather than NaN.
     */
    async getContactImport(importId: string): Promise<{
      readonly status: string;
      readonly counts: {
        readonly total: number;
        readonly created: number;
        readonly updated: number;
        readonly skipped: number;
        readonly failed: number;
      };
    }> {
      assertNonEmpty({ importId });
      return boundedCall(
        async (signal) => {
          // `importId` is provider-controlled — it arrives as `body.id` from
          // Resend and is persisted without validation — and it goes straight into
          // a URL PATH. `fetch` normalises `..` segments, so an id carrying one
          // would change which endpoint this calls (108 Phase 9 review S23). Low
          // risk, since it needs a compromised or misbehaving Resend, and one
          // function call to remove.
          const body = await importFetch(
            `/contacts/imports/${encodeURIComponent(importId)}`,
            { method: 'GET' },
            signal,
            importId,
          );
          const c = body.counts ?? {};
          return {
            status: body.status ?? 'unknown',
            counts: {
              total: c.total ?? 0,
              created: c.created ?? 0,
              updated: c.updated ?? 0,
              skipped: c.skipped ?? 0,
              failed: c.failed ?? 0,
            },
          };
        },
        { method: 'getContactImport', callTimeoutMs, retry: 'retryable' },
      );
    },

  };
}

/**
 * T086 — the Contacts Import endpoints, spoken to with a raw `fetch`.
 *
 * `resend@4.8` had no `contacts.imports`, so these two are hand-rolled (6.35
 * has `contacts.imports`; spec 140 decides whether to move to it). The
 * SDK's own error envelope is not available either, so the response body is
 * mapped onto the same `ResendErrorShape` `classifyResendError` already
 * understands — that keeps `permanent` / `retryable` meaning one thing across
 * the whole gateway, which the batch retry gate depends on.
 */
interface ResendImportResponse {
  readonly id?: string;
  readonly status?: string;
  readonly counts?: {
    readonly total?: number;
    readonly created?: number;
    readonly updated?: number;
    readonly skipped?: number;
    readonly failed?: number;
  };
  readonly statusCode?: number;
  readonly name?: string;
  readonly message?: string;
}

/**
 * Throw the gateway's own classified error for a non-2xx import response.
 *
 * `resourceType` + `resourceId` are BOTH required by `classifyResendError`'s 404
 * branch, and this used to pass neither — so a 404 for a purged import job was
 * classified `permanent` rather than `resource_missing` (108 Phase 9 review
 * S17). Callers that want to tell "the job is gone" from "Resend refused the
 * request" could not.
 */
function throwImportError(
  status: number,
  body: ResendImportResponse,
  resourceId?: string,
): never {
  throw classifyResendError(
    {
      statusCode: status,
      name: body.name ?? `http_${status}`,
      message: body.message ?? 'resend contact import error',
    },
    // Round 4, whole-branch review #7 — was `'audience'`, with `resourceId` set
    // to the IMPORT id. A 404 on `GET /contacts/imports/{id}` is a missing
    // IMPORT JOB, and reporting it as a missing audience sent an operator to
    // hunt a Resend audience called `imp_…` that was never the problem. The
    // fabricated half was the TYPE, not the id — class 4, in the field a human
    // reads off the cron log and the audit row.
    'import',
    resourceId,
  );
}

/**
 * `AbortSignal.timeout` rejects with a `TimeoutError` (a `DOMException`, so
 * `errKind` alone reads only the class); kept apart from an abort or a network
 * failure so a slow Resend is visible on the log line.
 */
function isTimeout(e: unknown): boolean {
  return e instanceof Error && e.name === 'TimeoutError';
}

/**
 * The raw-fetch twin of `httpStatusOf` (spec 141, option A, extended to every
 * call by the maintainer) for the one decision that matters: "gone". A 404 or
 * 410 counts only when the body is Resend's own JSON error (it parses and
 * carries a `name`); from an edge's or proxy's page it reads as a transient
 * 500, so "gone" is never decided from a page Resend did not write. Every
 * other status keeps the reading it has on `main` (raw fetch never went
 * through the SDK, so it never had the 4.8 SDK reading to restore).
 */
function rawHttpStatusOf(status: number, text: string): number {
  if (status !== 404 && status !== 410) return status;
  try {
    const body = JSON.parse(text) as { name?: unknown } | null;
    if (body !== null && typeof body === 'object' && typeof body.name === 'string') return status;
  } catch {
    // not JSON — not Resend's answer
  }
  return 500;
}

function deleteOnceOutcomeFor(status: number): DeleteBroadcastOnceOutcome {
  if (status >= 200 && status < 300) return { kind: 'deleted' };
  if (status === 404 || status === 410) return { kind: 'absent' };
  if (status === 403) return { kind: 'forbidden' };
  if (status === 429 || status >= 500) return { kind: 'retryable' };
  return { kind: 'other' };
}

function retrieveOnceOutcomeFor(status: number, text: string): RetrieveBroadcastOnceOutcome {
  if (status >= 200 && status < 300) {
    let body: { status?: unknown; sent_at?: unknown } | null;
    try {
      body = JSON.parse(text) as { status?: unknown; sent_at?: unknown } | null;
    } catch {
      return { kind: 'other' };
    }
    const raw = body?.status;
    if (typeof raw !== 'string') return { kind: 'other' };
    // Review round 2 (reliability nit) — a string `sent_at` only; anything else is null.
    const sentAt = typeof body?.sent_at === 'string' ? body.sent_at : null;
    // Spec 140 s1 — MEASURED 2026-10-29 (an audience deleted under a queued
    // broadcast). Named by this reader only; `normaliseStatus` keeps it
    // `unknown` for every other caller (see `RetrieveBroadcastOnceOutcome`).
    return { kind: 'present', status: raw === 'failed' ? 'failed' : normaliseStatus(raw), sentAt };
  }
  if (status === 404 || status === 410) return { kind: 'not_found' };
  if (status === 429 || status >= 500) return { kind: 'retryable' };
  return { kind: 'other' };
}

/**
 * `signal` is the caller's `boundedCall` signal (spec 140 s2a: it replaced a
 * 30 s per-request timeout), so one budget covers the request, its body and
 * any retry.
 */
async function importFetch(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
  resourceId?: string,
): Promise<ResendImportResponse> {
  let res: Response;
  try {
    res = await fetch(`${RESEND_API_BASE_URL}${path}`, {
      ...init,
      signal,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${env.broadcasts.apiKey}`,
      },
    });
  } catch (e) {
    // A transport failure, or a request that may have reached Resend and lost
    // its answer: retryable/network, the reading `classifyResendError` gives
    // `statusCode: 0` (an aborted signal reads as a timeout in `boundedCall`).
    // A GET or DELETE retries it; a create does not (spec 140 s2a, DL5a).
    throw classifyResendError({
      statusCode: 0,
      name: 'network_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    // The body stalled or broke mid-read (an aborted signal rejects here too):
    // the answer is unknown, as for a transport failure. `boundedCall` reads an
    // aborted signal as a timeout.
    throw classifyResendError({
      statusCode: 0,
      name: 'network_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  let body: ResendImportResponse;
  try {
    body = text.length > 0 ? (JSON.parse(text) as ResendImportResponse) : {};
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (!res.ok) throwImportError(rawHttpStatusOf(res.status, text), body, resourceId);
  return body;
}

function normaliseStatus(
  raw: string,
): RetrievedBroadcastResource['status'] {
  switch (raw) {
    // MEASURED 2026-09-10: a broadcast created and never handed to `/send`
    // reports `draft`. It was absent here, so the single most ordinary state
    // a resource can be in fell through the unknown-status default below —
    // reported as `queued` AND logged at error on every retrieve.
    case 'draft':
    case 'queued':
    case 'sending':
    case 'sent':
    case 'cancelled':
      return raw;
    // MEASURED 2026-10-30 (live account, sink only, 2 runs): a queued broadcast
    // cancelled through POST /broadcasts/{id}/cancel answers `canceled` — ONE
    // L, as Resend's docs spell it — at +0/2/15/45 s. The same state as our
    // `cancelled`; read as `unknown`, every arm built on `cancelled` (the
    // erasure cascade's 403 + cancelled, the gate's 403 on a cancelled id, the
    // import leg's cancelled re-mint) could never fire.
    case 'canceled':
      return 'cancelled';
    default:
      // Say "unknown", do not INVENT 'queued'.
      //
      // Fabricating a real status here made the union closed at the type level
      // and open at runtime, and a caller could not tell the difference. It cost
      // something concrete: a send gate written as `status !== 'draft'` read the
      // fabricated `'queued'` as proof that a broadcast had been handed to
      // `/send`, skipped the send, and let the row advance to `sending` — after
      // which `reconcile-stuck-sending` stamped it `sent` and consumed the
      // member's annual quota for mail that never went out.
      //
      // `'draft'` is the standing proof that this arm catches LIVE values, not
      // hypothetical future ones: it fell through here until 2026-09-10.
      //
      // `failed` and `scheduled` land here on purpose (both real — MEASURED
      // 2026-10-29: a `queued` broadcast whose audience is deleted turns
      // `failed`, no mail). The dispatch tick refuses an `unknown` probe
      // (fail closed); see `RetrievedBroadcastResource['status']` for why
      // they are not mapped, and the dispatch tick for the recovery.
      logger.error(
        { rawStatus: raw },
        'resend.broadcasts.unknown_status',
      );
      return 'unknown';
  }
}

/** The production gateway: every call bounded by {@link RESEND_CALL_TIMEOUT_MS}. */
export const resendBroadcastsGateway: BroadcastsGatewayPort = createResendBroadcastsGateway();
