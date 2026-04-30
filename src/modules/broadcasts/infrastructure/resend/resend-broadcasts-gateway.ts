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
  RetrievedBroadcastResource,
} from '../../application/ports/broadcasts-gateway-port';
import { getResendBroadcastsClient } from './resend-broadcasts-client';

const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const CONTACTS_CHUNK_SIZE = 100;

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
 * 5xx (review I6 — 2026-04-30). Other kinds carry `subKind: 'api'`.
 */
export type GatewayThrowableSubKind =
  | 'network'
  | 'timeout'
  | 'server_5xx'
  | 'api';

export class GatewayThrowable extends Error {
  readonly kind: GatewayThrowableKind;
  readonly subKind: GatewayThrowableSubKind;
  readonly reason: string;
  readonly code?: string;
  readonly resourceType?: 'audience' | 'broadcast';
  readonly resourceId?: string;

  constructor(opts: {
    kind: GatewayThrowableKind;
    subKind?: GatewayThrowableSubKind;
    reason: string;
    code?: string;
    resourceType?: 'audience' | 'broadcast';
    resourceId?: string;
  }) {
    super(opts.reason);
    this.name = 'GatewayThrowable';
    this.kind = opts.kind;
    this.subKind = opts.subKind ?? 'api';
    this.reason = opts.reason;
    if (opts.code !== undefined) this.code = opts.code;
    if (opts.resourceType !== undefined) this.resourceType = opts.resourceType;
    if (opts.resourceId !== undefined) this.resourceId = opts.resourceId;
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
  // SDK throwable that bypassed classification escapes as `retryable`.
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

    // Paginate at the Resend per-call limit (100).
    for (let i = 0; i < contacts.length; i += CONTACTS_CHUNK_SIZE) {
      const chunk = contacts.slice(i, i + CONTACTS_CHUNK_SIZE);
      await withRetry(
        async () => {
          const sdk = client();
          // Resend Contacts API is one-at-a-time; loop inside chunk.
          for (const c of chunk) {
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
        const result = (await sdk.broadcasts.create({
          audienceId: input.audienceId,
          from: `${input.fromName} <${input.fromEmail}>`,
          subject: input.subject,
          html: input.htmlBody,
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

  async retrieveBroadcast(
    broadcastId: string,
  ): Promise<RetrievedBroadcastResource | null> {
    try {
      return await withRetry(
        async () => {
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
    } catch (e) {
      if (e instanceof GatewayThrowable && e.kind === 'resource_missing') {
        return null;
      }
      throw e;
    }
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
