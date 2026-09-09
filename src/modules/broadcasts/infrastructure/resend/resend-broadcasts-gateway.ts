/**
 * T104 — Resend Broadcasts gateway adapter (F7 US2).
 *
 * Concrete `BroadcastsGatewayPort` impl wrapping Resend SDK Broadcasts
 * surface (`audiences.create`, `contacts.create`, `broadcasts.create`,
 * `broadcasts.send`, `broadcasts.get`).
 *
 * Error classification (thrown shapes per port docstring):
 *   - 5xx / network / timeout → `{kind: 'retryable', reason}`
 *   - 409 idempotency conflict → `{kind: 'idempotency_conflict', reason}`
 *   - 404 audience/broadcast → `{kind: 'resource_missing', resourceType, resourceId}`
 *   - 4xx other → `{kind: 'permanent', code, reason}`
 *
 * Retry policy: 1/2/4/8/16s × 5 (CHK020) on retryable errors only.
 * Permanent errors throw immediately.
 *
 * Logging: pino with `redact` configured globally to drop request
 * bodies; only metadata (audienceId, broadcastId, recipientCount,
 * idempotencyKey hash) is logged.
 */
import type { Resend } from 'resend';
import { logger } from '@/lib/logger';
import type {
  AudienceContact,
  BroadcastsGatewayPort,
  CreateBroadcastInput,
  GatewayRetryableSubKind,
  GetAudienceContactCountOutcome,
  RetrievedBroadcastResource,
  RetrieveBroadcastOutcome,
  ResendAudienceSummary,
} from '../../application/ports/broadcasts-gateway-port';
import { env } from '@/lib/env';
import { getResendBroadcastsClient } from './resend-broadcasts-client';
import { renderBroadcastHtml } from './email-template';
import { extractBareEmail, stripAngleBrackets } from './bare-email';

const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

interface ResendErrorShape {
  readonly statusCode?: number;
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
      readonly resourceType: 'audience' | 'broadcast';
      readonly resourceId: string;
      readonly reason: string;
    }
  | { readonly kind: 'permanent'; readonly code: string; readonly reason: string };

export class GatewayThrowable extends Error {
  readonly kind: GatewayThrowableKind;
  readonly subKind?: GatewayThrowableSubKind;
  readonly reason: string;
  readonly code?: string;
  readonly resourceType?: 'audience' | 'broadcast';
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

function classifyResendError(
  err: ResendErrorShape | undefined | null,
  resourceType?: 'audience' | 'broadcast',
  resourceId?: string,
): GatewayThrowable {
  const status = err?.statusCode ?? 500;
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

async function withRetry<T>(
  op: () => Promise<T>,
  ctx: { method: string },
): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await op();
    } catch (e) {
      lastErr = e;
      // Only retry on `retryable` kind; everything else throws immediately
      if (e instanceof GatewayThrowable && e.kind !== 'retryable') {
        throw e;
      }
      if (attempt === RETRY_BACKOFF_MS.length) break;
      const backoff = RETRY_BACKOFF_MS[attempt] ?? 16_000;
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
          subKind: e instanceof GatewayThrowable ? e.subKind : undefined,
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

export const resendBroadcastsGateway: BroadcastsGatewayPort = {
  async createAudience(name: string): Promise<{ readonly audienceId: string }> {
    return withRetry(
      async () => {
        const sdk = client();
        const result = (await sdk.audiences.create({ name })) as ResendSdkResponse<{
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
      { method: 'createAudience' },
    );
  },

  async addContactsToAudience(
    audienceId: string,
    contacts: ReadonlyArray<AudienceContact>,
  ): Promise<void> {
    if (contacts.length === 0) return;

    // The Resend Contacts API is one-at-a-time (no bulk endpoint). The
    // account limit is 10 req/s, NOT the 2 this comment used to claim
    // (measured 2026-09-08, T095: `ratelimit-policy: 10;w=1` straight from
    // the API's headers). But this loop is serial, so it can only reach
    // `min(10, 1/RTT)` and the warm round trip is ~0.29 s — i.e. ~3.4 req/s,
    // latency-bound. Two consequences worth knowing before you tune anything
    // here: one tick drains ~1,000 contacts, not the ~3,000 the documented
    // limit suggests; and on the `dispatch-scheduled` path the 429 backoff
    // below never fires, because one serial loop at 3.45 req/s never
    // approaches 10.
    //
    // That second point is path-specific — corrected 2026-09-08 after review.
    // `dispatch-batches` drives this same method through
    // `batch-dispatcher.ts`, which keeps up to `concurrencyCap` batches in
    // flight (default 4). Four serial loops are ~13.8 req/s against a 10 req/s
    // policy, so on THAT path 429s are expected and the backoff is load-bearing.
    // Do not tune it away on the strength of the serial-path reasoning.
    // See `specs/108-contact-recipient-rules/research.md` § R9 (T095 block).
    //
    // Wrap EACH single create in its own
    // withRetry so that when Resend answers 429 (now classified retryable —
    // see classifyResendError), the 1/2/4/8/16s backoff self-throttles just
    // that ONE contact and retries it, WITHOUT re-creating the contacts that
    // already succeeded. Previously the retry wrapped a whole 100-contact
    // batch, so a mid-batch 429 re-ran the entire batch (duplicate creates)
    // AND — before 429 was retryable — killed the broadcast outright
    // (BUG-028).
    //
    // We deliberately do NOT add a fixed per-contact sleep: a blanket delay
    // across a list bounded only by `audienceCeiling()` (5,000, or 50,000 once
    // the 108 flag and batching are both on — `domain/audience-ceiling.ts`;
    // the `AUDIENCE_HARD_CAP` this comment used to name was deleted by 108
    // T085) would burn the whole dispatch-function time budget on sleeping and
    // time the invocation out before it finishes. Reactive backoff only pays
    // the cost when the limit is actually hit. Reliable delivery of very large
    // audiences within a single invocation is what `createContactImport` below
    // solves — one multipart upload instead of N requests — so this loop is the
    // legacy path only, reached when `FEATURE_F7_IMPORT_AUDIENCE` is off. Its
    // capacity is the reason `currentAudienceCeiling()` clamps in that state:
    // measured 2.08 req/s ⇒ ~623 per 300 s tick ⇒ a 500 accept bound. Anything
    // above that used to be accepted and never delivered.
    for (const c of contacts) {
      await withRetry(
        async () => {
          const sdk = client();
          const result = (await sdk.contacts.create({
            email: c.emailLower,
            audienceId,
            ...(c.firstName !== undefined && { firstName: c.firstName }),
            ...(c.lastName !== undefined && { lastName: c.lastName }),
            unsubscribed: false,
          })) as ResendSdkResponse<{ id: string }>;
          if (result.error) {
            throw classifyResendError(
              result.error ?? undefined,
              'audience',
              audienceId,
            );
          }
        },
        { method: 'addContactsToAudience' },
      );
    }
    logger.info(
      { audienceId, recipientCount: contacts.length },
      'resend.broadcasts.contacts_added',
    );
  },

  async createBroadcast(
    input: CreateBroadcastInput,
  ): Promise<{ readonly broadcastId: string }> {
    return withRetry(
      async () => {
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
        });
        const bareFromEmail = extractBareEmail(input.fromEmail);
        // Finding B — strip `<`/`>` from the display name so a member company
        // name containing angle brackets cannot produce a nested, invalid
        // RFC 5322 `from` header that Resend rejects (permanent
        // failed_to_dispatch). `extractBareEmail` only sanitises the address.
        const safeFromName = stripAngleBrackets(input.fromName);
        const result = (await sdk.broadcasts.create({
          audienceId: input.audienceId,
          from: `${safeFromName} <${bareFromEmail}>`,
          subject: input.subject,
          html: wrappedHtml,
          replyTo: input.replyToEmail,
          name: input.broadcastNameForResendDashboard,
        })) as ResendSdkResponse<{ id: string }>;
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
      { method: 'createBroadcast' },
    );
  },

  async sendBroadcast(
    broadcastId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await withRetry(
      async () => {
        const sdk = client();
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
        // What this closes: a `withRetry` replay INSIDE one tick — a lost
        // response or a 5xx after Resend already accepted the send no longer
        // re-fires the broadcast.
        //
        // What it does NOT close (S8, a flag-flip blocker, see
        // `build-audience-tick.ts`): `createBroadcast` carries no key at all, so
        // a re-entered tick mints a NEW broadcast resource and sends to a
        // different path, where no key can help.
        const result = (await sdk.post(`/broadcasts/${broadcastId}/send`, {}, {
          idempotencyKey,
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
      { method: 'sendBroadcast' },
    );
  },

  async getAudienceContactCount(
    audienceId: string,
  ): Promise<GetAudienceContactCountOutcome> {
    // IMP-5 — query Resend for the contact count on an audience. The
    // SDK exposes `contacts.list(audienceId)` (paginated). For MVP we
    // list and return `data.length`; a future optimisation could use a
    // head-only endpoint when Resend provides one.
    try {
      const count = await withRetry(
        async () => {
          const sdk = client();
          const result = (await sdk.contacts.list({ audienceId })) as ResendSdkResponse<{
            data: ReadonlyArray<unknown>;
          }>;
          if (result.error) {
            throw classifyResendError(
              result.error ?? undefined,
              'audience',
              audienceId,
            );
          }
          return result.data?.data.length ?? 0;
        },
        { method: 'getAudienceContactCount' },
      );
      return { kind: 'present', count };
    } catch (e) {
      if (e instanceof GatewayThrowable && e.kind === 'resource_missing') {
        return { kind: 'not_found' };
      }
      throw e;
    }
  },

  async retrieveBroadcast(
    broadcastId: string,
  ): Promise<RetrieveBroadcastOutcome> {
    try {
      const resource = await withRetry(
        async (): Promise<RetrievedBroadcastResource | null> => {
          const sdk = client();
          const result = (await sdk.broadcasts.get(broadcastId)) as ResendSdkResponse<{
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
        { method: 'retrieveBroadcast' },
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

  async removeContactFromAudience(audienceId: string, email: string): Promise<void> {
    try {
      await withRetry(
        async () => {
          const sdk = client();
          const result = (await sdk.contacts.remove({
            audienceId,
            email,
          })) as ResendSdkResponse<{ deleted: boolean }>;
          if (result.error) {
            throw classifyResendError(result.error ?? undefined, 'audience', audienceId);
          }
        },
        { method: 'removeContactFromAudience' },
      );
      logger.info({ audienceId }, 'resend.broadcasts.contact_detached');
    } catch (e) {
      // A 404 → the contact/audience is already gone → nothing to detach.
      if (e instanceof GatewayThrowable && e.kind === 'resource_missing') return;
      throw e;
    }
  },

  /**
   * COMP-1 US3-C — the call that actually erases.
   *
   * `removeContactFromAudience` above answers `{"deleted": true}` and DETACHES:
   * measured 2026-09-09, the audience-scoped read 404s afterwards while
   * `GET /contacts/{email}` still returns the contact at 200. This endpoint's
   * read-back is a real 404.
   *
   * The distinction matters because the erasure cascade was calling the wrong
   * one and counting each call as a removal, so `resendOutcome: 'ok'` was
   * reported for members whose addresses were still at the processor.
   */
  async deleteContactGlobally(email: string): Promise<void> {
    try {
      await withRetry(
        async () => {
          const body = await importFetch(
            `/contacts/${encodeURIComponent(email)}`,
            { method: 'DELETE' },
            // No resourceId: it would be the address, and that must not reach a
            // classified error's `reason`, which is logged.
          );
          // The provider says `deleted: true` for a detach as well, so this is
          // logged rather than trusted as proof. What makes this call correct is
          // the endpoint, not the answer.
          if ((body as { deleted?: unknown }).deleted !== true) {
            logger.warn(
              { deleted: (body as { deleted?: unknown }).deleted },
              'resend.broadcasts.contact_delete_unexpected_body',
            );
          }
        },
        { method: 'deleteContactGlobally' },
      );
      // No email in the log line — forbidden-fields hygiene (FR-053a).
      logger.info({}, 'resend.broadcasts.contact_deleted_globally');
    } catch (e) {
      // A 404 means the contact is already gone: the erasure goal is met.
      if (e instanceof GatewayThrowable && e.kind === 'resource_missing') return;
      // `resource_missing` needs a resourceId, and the only id available here is
      // the address itself — which must not reach a classified error's `reason`,
      // because that is logged. So a genuine 404 arrives as `permanent`, and its
      // `code` carries the provider's `name`. Measured: Resend answers
      // `{"statusCode":404,"name":"not_found"}`.
      if (
        e instanceof GatewayThrowable &&
        e.kind === 'permanent' &&
        (e.code === 'not_found' || e.code === 'http_404')
      ) {
        return;
      }
      throw e;
    }
  },

  async listAudiences(): Promise<ReadonlyArray<ResendAudienceSummary>> {
    return withRetry(
      async () => {
        const sdk = client();
        const result = (await sdk.audiences.list()) as ResendSdkResponse<{
          object: string;
          data: ReadonlyArray<{ id: string; name: string; created_at: string }>;
        }>;
        if (result.error) {
          throw classifyResendError(result.error ?? undefined, 'audience');
        }
        const rows = result.data?.data ?? [];
        logger.info({ audienceCount: rows.length }, 'resend.broadcasts.audiences_listed');
        // Parse at the adapter boundary so callers work with Date, not raw strings.
        return rows.map((r) => ({ id: r.id, name: r.name, createdAt: new Date(r.created_at) }));
      },
      { method: 'listAudiences' },
    );
  },

  async deleteAudience(audienceId: string): Promise<void> {
    await withRetry(
      async () => {
        const sdk = client();
        const result = (await sdk.audiences.remove(audienceId)) as ResendSdkResponse<{
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
          if (
            result.error.statusCode === 404 ||
            result.error.statusCode === 410
          ) {
            logger.info({ audienceId }, 'resend.broadcasts.audience_already_absent');
            return; // idempotent: already gone
          }
          throw classifyResendError(result.error ?? undefined, 'audience', audienceId);
        }
        logger.info({ audienceId }, 'resend.broadcasts.audience_deleted');
      },
      { method: 'deleteAudience' },
    );
  },

  /**
   * T086 — hand the WHOLE audience to Resend in one multipart request.
   *
   * Replaces the `addContactsToAudience` loop, which is serial and therefore
   * bounded by latency (~2.08 req/s measured, so ~623 contacts per 300 s
   * function). This call is size-independent: ~412 ms for one address and the
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
   * KNOWN, ACCEPTED: this call is wrapped in `withRetry` but carries no
   * idempotency key, because `POST /contacts/imports` does not accept one
   * (108 Phase 9 review S18).
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
    return withRetry(
      async () => {
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
        const csv = ['email', ...emails].join('\n') + '\n';
        const form = new FormData();
        form.append('file', new Blob([csv], { type: 'text/csv' }), 'audience.csv');
        form.append('column_map', JSON.stringify({ email: 'email' }));
        form.append('on_conflict', 'upsert');
        form.append('segments', JSON.stringify([{ id: audienceId }]));

        const body = await importFetch('/contacts/imports', {
          method: 'POST',
          body: form,
        });
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
      { method: 'createContactImport' },
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
    return withRetry(
      async () => {
        // `importId` is provider-controlled — it arrives as `body.id` from
        // Resend and is persisted without validation — and it goes straight into
        // a URL PATH. `fetch` normalises `..` segments, so an id carrying one
        // would change which endpoint this calls (108 Phase 9 review S23). Low
        // risk, since it needs a compromised or misbehaving Resend, and one
        // function call to remove.
        const body = await importFetch(
          `/contacts/imports/${encodeURIComponent(importId)}`,
          { method: 'GET' },
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
      { method: 'getContactImport' },
    );
  },

};

/**
 * T086 — the Contacts Import endpoints, spoken to with a raw `fetch`.
 *
 * `resend@4.8` has no `contacts.imports`, so these two are hand-rolled. The
 * SDK's own error envelope is not available either, so the response body is
 * mapped onto the same `ResendErrorShape` `classifyResendError` already
 * understands — that keeps `permanent` / `retryable` meaning one thing across
 * the whole gateway, which the batch retry gate depends on.
 */
const RESEND_API_BASE = 'https://api.resend.com';

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
    'audience',
    resourceId,
  );
}

/**
 * A hung `fetch` has no default timeout. This one is bounded by the route's
 * `maxDuration = 300`, but that budget is shared with every remaining broadcast
 * in the same tick loop (`MAX_PER_TICK = 50`, no wall-clock check between rows),
 * so one stalled call can starve the rest of the tick. 30 s is generous against
 * a measured ~481 ms round trip and still leaves the loop time to continue.
 */
const IMPORT_FETCH_TIMEOUT_MS = 30_000;

async function importFetch(
  path: string,
  init: RequestInit,
  resourceId?: string,
): Promise<ResendImportResponse> {
  let res: Response;
  try {
    res = await fetch(`${RESEND_API_BASE}${path}`, {
      ...init,
      signal: AbortSignal.timeout(IMPORT_FETCH_TIMEOUT_MS),
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${env.broadcasts.apiKey}`,
      },
    });
  } catch (e) {
    // A transport failure never reached Resend, so it is safe to retry — the
    // same reading `classifyResendError` gives `statusCode: 0`.
    throw classifyResendError({
      statusCode: 0,
      name: 'network_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  const text = await res.text();
  let body: ResendImportResponse;
  try {
    body = text.length > 0 ? (JSON.parse(text) as ResendImportResponse) : {};
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (!res.ok) throwImportError(res.status, body, resourceId);
  return body;
}

function normaliseStatus(
  raw: string,
): 'queued' | 'sending' | 'sent' | 'cancelled' {
  switch (raw) {
    case 'queued':
    case 'sending':
    case 'sent':
    case 'cancelled':
      return raw;
    default:
      // Unknown Resend status — treat as 'queued' (non-terminal, will
      // be retried by reconciler). Log so a future Resend status
      // addition is visible in ops dashboards instead of silently
      // looping the reconciler forever.
      logger.error(
        { rawStatus: raw },
        'resend.broadcasts.unknown_status',
      );
      return 'queued';
  }
}
