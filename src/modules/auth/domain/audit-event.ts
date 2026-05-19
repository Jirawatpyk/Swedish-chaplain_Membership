/**
 * Authentication audit event types (data-model.md § 2.7, spec User Story 7).
 *
 * Every user-visible auth action emits exactly one row in `audit_log`
 * (T067 audit-repo.append). This array is the single source of truth
 * and is duplicated in the Postgres enum `audit_event_type`
 * (schema.ts § auditEventTypeEnum) — keep in sync via migrations.
 *
 * NOTE: not every payment- or webhook-related lifecycle event flows
 * through F1's `audit_log` enum. F5 + F7 + F8 declare their own
 * tenant-scoped audit-port event taxonomies; only F5 route-level
 * events (signature reject, env mismatch, etc.) are registered here
 * because the route handlers call `auditRepo.append` directly without
 * a port boundary. See the inline comments below.
 *
 * Pure types — no framework imports.
 *
 * Provenance:
 *   - Pass 5: split `password_reset_failed` out of the
 *     `invitation_redemption_failed` overload (migration 0002).
 *   - 2026-04-25 audit-finding #10 + #13: added
 *     `webhook_unknown_intent` + `webhook_payment_already_canceled`
 *     (migration 0046).
 *   - Review I-14: added `payment_processor_retrieve_failed`
 *     (migration 0047).
 *   - Review S5: added `payment_invoice_not_found` (migration 0048).
 *   - F5R2-C2: added `webhook_dispatch_permanent_failure`
 *     (migration 0151).
 *   - B5 (post-ship 2026-05-17): added three operational events for
 *     wrong-current-password, malformed-hash detection, and
 *     password-reset email send failures (migration 0158).
 */

import type { AuditEventId, UserId } from './branded';

export const AUDIT_EVENT_TYPES = [
  'sign_in_success',
  'sign_in_failure',
  'sign_out',
  'password_reset_requested',
  'password_reset_completed',
  'password_reset_failed',
  'password_changed',
  'account_created',
  'account_disabled',
  'account_reenabled',
  'role_changed',
  'lockout_triggered',
  'lockout_cleared',
  'session_forcibly_ended',
  'concurrent_sessions_revoked',
  'manager_denied_write',
  'invitation_redemption_failed',
  // --- F5 webhook + rate-limit event types consumed by auditRepo directly
  // via route handlers (`src/app/api/webhooks/stripe/route.ts` +
  // `src/app/api/payments/{initiate,[id]/cancel}/route.ts`). Tenant-
  // scoped payment lifecycle events (payment_initiated / payment_succeeded
  // etc.) do NOT go through this repo — they use the F5 AuditPort
  // (`@/modules/payments/application/ports/audit-port`) with `retention_years`
  // per data-model.md § 7.1. These 5 routes-level events are registered
  // here so the route can append without an `unknown` cast, fulfilling
  // Backend F-02 + PCI F-03 + Threat F-09 review findings.
  'webhook_signature_rejected',
  'payment_environment_mismatch',
  'webhook_api_version_mismatch',
  'payment_initiate_rate_limited',
  'payment_cancel_rate_limited',
  // --- Webhook ops-visibility events added by migration 0046
  //     (audit 2026-04-25 findings #10 + #13).
  'webhook_unknown_intent',
  'webhook_payment_already_canceled',
  // --- Migration 0047 (Review I-14) — confirmPayment retrievePaymentIntent
  //     failure trail. Operational only.
  'payment_processor_retrieve_failed',
  // --- Migration 0048 (Review S5) — confirmPayment invoice_not_found trail.
  'payment_invoice_not_found',
  // --- Migration 0151 (F5R2-C2) — webhook route's permanent-failure
  //     200-ack forensic trail. 5y retention. Honours the
  //     process-webhook-event.ts:156 docstring promise.
  'webhook_dispatch_permanent_failure',
  // --- B5 (post-ship 2026-05-17, migration 0158) ---
  // `password_change_failed` — emitted on the wrong-current-password
  //   branch in change-password.ts. Pre-B5 this branch only logged at
  //   warn and incremented authMetrics; an attacker with a stolen
  //   session cookie probing the user's password had ZERO audit-trail
  //   footprint. (silent-failure C5 in review-20260517).
  'password_change_failed',
  // `password_reset_email_failed` — emitted by forgot-password when the
  //   Resend retry loop exhausts. Pre-B5 the failure was logger.error
  //   only, leaving audit trail looking as if the email had been sent.
  //   Closes silent-failure C4.
  'password_reset_email_failed',
  // `password_malformed_hash_detected` — emitted by sign-in when the
  //   argon2 verify catches a malformed-hash error. Pre-B5 this fell
  //   through to wrong-password + incrementFailedCount, locking the
  //   account out for what is actually a DB-corruption issue. The
  //   dedicated event lets operators page in on the metric without
  //   confusing the legitimate-user-typed-wrong-password baseline.
  //   Closes silent-failure H4 / B4.
  'password_malformed_hash_detected',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/**
 * Special actor sentinel values (data-model.md § 2.7):
 *
 *   - 'anonymous'        — sign-in failure for an unknown email
 *   - 'system:bootstrap' — the bootstrap admin seed script (T080)
 *   - 'system:cron'      — scheduled jobs (T160 lockout-cleanup)
 */
/**
 * `'system:webhook'` added 2026-04-25 (audit finding #2): Stripe
 * webhook reject paths (signature/env/api-version mismatches) need a
 * dedicated sentinel — `'system:cron'` lumps them with scheduled-job
 * actors, polluting audit dashboards. Use `'system:webhook'` for any
 * non-cron synchronous-event-handler context (Stripe, Resend, etc.).
 */
export type ActorRef =
  | UserId
  | 'anonymous'
  | 'system:bootstrap'
  | 'system:cron'
  | 'system:webhook';

export interface AuditEvent {
  readonly id: AuditEventId;
  readonly timestamp: Date;
  readonly eventType: AuditEventType;
  readonly actorUserId: ActorRef;
  readonly targetUserId: UserId | null;
  readonly sourceIp: string | null;
  /** Short human-readable description, ≤ 500 chars. NEVER contains secrets. */
  readonly summary: string;
  readonly requestId: string;
}

/** Maximum length of `summary` — enforced by audit-repo before insert. */
export const AUDIT_SUMMARY_MAX_LENGTH = 500;

export function isAuditEventType(value: string): value is AuditEventType {
  return (AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}
