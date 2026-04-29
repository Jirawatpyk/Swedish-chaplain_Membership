/**
 * T028 — `WebhookVerifierPort` Application port (F7).
 *
 * Resend Broadcasts webhook signature verification. Resend uses the
 * Svix HMAC-SHA256 signature scheme — the handler MUST verify the
 * signature against the raw request body BEFORE parsing JSON, or
 * tampered payloads slip through. Same constraint as F5 Stripe webhook.
 *
 * Webhook endpoint: `/api/webhooks/resend-broadcasts` (Node.js runtime
 * pinned, NOT Edge — raw body access). Pre-tenant RLS bypass: the
 * handler runs signature verify + idempotency upsert under
 * `swecham_super` until the `resend_broadcast_id → broadcasts(tenant_id)`
 * lookup resolves the tenant. Then re-binds `app.current_tenant` for
 * downstream writes.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { BroadcastDeliveryStatus } from '../../domain/value-objects/delivery-status';

/**
 * Custom Error class with discriminated `kind` field — same pattern as
 * F5 `WebhookSignatureError`. Adapter throws this on verification
 * failure; the route handler catches it, emits
 * `broadcast_webhook_signature_rejected` audit, returns 401.
 */
export class WebhookSignatureError extends Error {
  public readonly kind:
    | 'missing_header'
    | 'malformed'
    | 'bad_signature'
    | 'tampered_body'
    | 'expired_timestamp';

  constructor(kind: WebhookSignatureError['kind'], message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
    this.kind = kind;
  }
}

/**
 * Narrowed envelope returned by `constructEvent`. Domain-typed; does
 * NOT leak Resend SDK types into Application (the SDK shape may
 * change between versions; the port shape is the contract).
 */
export interface VerifiedBroadcastEvent {
  readonly id: string;
  readonly type: string;
  readonly createdAtUnixSeconds: number;
  readonly data: {
    readonly broadcastId: string;
    readonly recipientEmail: string;
    readonly resendMessageId: string;
    readonly status: BroadcastDeliveryStatus;
    readonly errorMessage?: string;
    readonly bounceType?: 'hard' | 'soft';
  };
}

export interface WebhookVerifierPort {
  /**
   * Verify the Svix signature header against the raw body. Returns
   * the narrowed event on success; throws `WebhookSignatureError` on
   * any verification failure.
   *
   * @param rawBody Raw request body (string — NOT parsed JSON)
   * @param svixSignatureHeader The `Svix-Signature` header value
   * @param svixIdHeader The `Svix-Id` header value
   * @param svixTimestampHeader The `Svix-Timestamp` header value
   * @param secret Webhook signing secret from `RESEND_BROADCASTS_WEBHOOK_SECRET`
   */
  constructEvent(
    rawBody: string,
    svixSignatureHeader: string | null,
    svixIdHeader: string | null,
    svixTimestampHeader: string | null,
    secret: string,
  ): VerifiedBroadcastEvent;
}
