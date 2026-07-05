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
    // Resend's default 2 req/s account rate limit. The request is fine —
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
          err: e instanceof Error ? e.message : String(e),
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

    // The Resend Contacts API is one-at-a-time (no bulk endpoint) and the
    // account is capped at 2 req/s. Wrap EACH single create in its own
    // withRetry so that when Resend answers 429 (now classified retryable —
    // see classifyResendError), the 1/2/4/8/16s backoff self-throttles just
    // that ONE contact and retries it, WITHOUT re-creating the contacts that
    // already succeeded. Previously the retry wrapped a whole 100-contact
    // batch, so a mid-batch 429 re-ran the entire batch (duplicate creates)
    // AND — before 429 was retryable — killed the broadcast outright
    // (BUG-028).
    //
    // We deliberately do NOT add a fixed per-contact sleep: a blanket delay
    // across an unbounded (up to AUDIENCE_HARD_CAP) list would burn the whole
    // dispatch-function time budget on sleeping and time the invocation out
    // before it finishes. Reactive backoff only pays the cost when the limit
    // is actually hit. Reliable delivery of very large audiences within a
    // single invocation is a separate architectural concern (batched
    // multi-tick dispatch), tracked outside this fix.
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
        // Resend SDK accepts idempotencyKey as a request option.
        const result = (await sdk.broadcasts.send(broadcastId, {
          idempotencyKey,
        } as Parameters<typeof sdk.broadcasts.send>[1])) as ResendSdkResponse<{
          id: string;
        }>;
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
      logger.info({ audienceId }, 'resend.broadcasts.contact_removed');
    } catch (e) {
      // A 404 → the contact/audience is already gone → erasure goal already met.
      if (e instanceof GatewayThrowable && e.kind === 'resource_missing') return;
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
};

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
