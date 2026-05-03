/**
 * T047 (F8 Phase 2 Wave E) — `RenewalGateway` Application port.
 *
 * Outbound transactional email gateway for renewal-related notifications
 * (reminder ladder, self-service renew links, post-pay receipts). Reuses
 * F1+F4 transactional Resend (`RESEND_API_KEY`) — NOT F7's broadcasts
 * API which has a separate suppression list + reputation pool. Renewal
 * reminders are TRANSACTIONAL communications per FR-019 + Assumption A5.
 *
 * Locale: caller passes the recipient's preferred locale ('en' | 'th'
 * | 'sv'). Adapter resolves the localised template + From-name from
 * the tenant's `tenant_renewal_settings.reply_to_*` (when set) or
 * falls back to F1+F4 defaults.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { CycleId } from '../../domain/renewal-cycle';

export type SupportedLocale = 'en' | 'th' | 'sv';

export interface RenewalEmailRecipient {
  readonly memberId: string;
  readonly toEmail: string;
  readonly toName: string | null;
  readonly preferredLocale: SupportedLocale;
}

export interface SendRenewalEmailInput {
  readonly tenantId: string;
  readonly cycleId: CycleId;
  /**
   * Schedule-policy step_id (e.g. `t-30.email`). Adapter routes to a
   * matching localised React Email template; caller never assembles
   * subject/body strings.
   */
  readonly stepId: string;
  readonly templateId: string;
  readonly recipient: RenewalEmailRecipient;
  /**
   * Per-step substitution variables (member_first_name, plan_name,
   * expires_at, renewal_link, etc.). Adapter validates against the
   * template's expected variable set; missing variables fail-fast
   * before Resend dispatch.
   */
  readonly templateVariables: Record<string, string | number | boolean>;
  /** Idempotency key — typically the reminder_event_id UUID. */
  readonly idempotencyKey: string;
  /**
   * Optional reply-to override (per-cycle ED escalation can route to a
   * specific admin). Falls back to tenant_renewal_settings defaults
   * when null.
   */
  readonly replyToEmail?: string;
  readonly replyToDisplayName?: string;
}

export interface SendRenewalEmailResult {
  /** Resend message id (non-null on success). */
  readonly deliveryId: string;
  /** Server-side dispatched-at ISO timestamp. */
  readonly dispatchedAt: string;
}

export type SendRenewalEmailError =
  | { readonly kind: 'recipient_unsubscribed' }
  | { readonly kind: 'recipient_email_unverified' }
  | {
      readonly kind: 'template_variables_missing';
      readonly missing: ReadonlyArray<string>;
    }
  | { readonly kind: 'gateway_5xx'; readonly retryable: true; readonly message: string }
  | { readonly kind: 'gateway_4xx'; readonly retryable: false; readonly message: string };

export interface RenewalGateway {
  /**
   * Dispatch one transactional renewal email. Adapter handles the
   * Resend SDK call + idempotency-key dedup + retry for 5xx; returns
   * Result for typed error narrowing at the dispatcher use-case
   * boundary.
   */
  sendRenewalEmail(
    input: SendRenewalEmailInput,
  ): Promise<
    | { readonly ok: true; readonly value: SendRenewalEmailResult }
    | { readonly ok: false; readonly error: SendRenewalEmailError }
  >;
}
