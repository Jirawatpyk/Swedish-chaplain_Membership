/**
 * Authentication audit event types (data-model.md § 2.7, spec User Story 7).
 *
 * 17 event types total — every user-visible auth action emits exactly
 * one row in `audit_log` (T067 audit-repo.append). The list is the
 * single source of truth and is duplicated in the Postgres enum
 * `audit_event_type` (schema.ts § auditEventTypeEnum) — keep in sync.
 *
 * Pass 5: bumped 16 → 17 after splitting `password_reset_failed`
 * out of the `invitation_redemption_failed` overload. See
 * `drizzle/migrations/0002_add_password_reset_failed_audit.sql`.
 *
 * Pure types — no framework imports.
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
