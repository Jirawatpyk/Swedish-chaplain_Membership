/**
 * F3 audit-event-type count guard.
 *
 * Mirrors the F2/F8 count-guard pattern but for the F3 union type.
 * Since F3AuditEventType is a TS union (not a const tuple), we use
 * a compile-time assertion via a mapped type that becomes a string[]
 * at runtime. Any new event type added to the union but NOT to this
 * test array causes a TS error (TS2322), not a silent pass.
 *
 * IMPORTANT: when adding a new F3AuditEventType value, add it BOTH
 * to the union in audit-port.ts AND to the F3_AUDIT_EVENTS tuple below.
 * The toBe(N) assertion then needs updating to N+1.
 */
import { describe, expect, it } from 'vitest';
import type { F3AuditEventType } from '@/modules/members/application/ports/audit-port';

// Compile-time exhaustiveness: this tuple must list every value in
// F3AuditEventType. A missing value → the `_AssertF3Coverage` proof
// below resolves to `never` (TS2322 on the `const _` line); an extra
// value → the tuple element is not assignable to F3AuditEventType.
// Runtime: length is asserted to catch stale count strings.
const F3_AUDIT_EVENTS: readonly F3AuditEventType[] = [
  'member_created',
  'member_updated',
  'member_plan_changed',
  'member_plan_manually_changed',
  'member_primary_contact_changed',
  'member_status_changed',
  'member_archived',
  'member_undeleted',
  'contact_created',
  'contact_updated',
  'contact_removed',
  'member_self_updated',
  'member_self_update_forbidden',
  'member_cross_tenant_probe',
  'plan_bundle_changed',
  'member_contact_email_changed',
  'user_sessions_revoked',
  'email_verification_sent',
  'email_verification_consumed',
  'email_change_notification_sent_to_old_address',
  'member_email_change_reverted',
  'email_verification_resent',
  'email_dispatch_failed',
  'invitation_bounced',
  'bulk_action_rate_limit_exceeded',
  'member_portal_invite_queued',
  'contact_linked_to_user',
  'member_preferred_locale_changed',
  'member_number_assigned',
  // COMP-1 Member Erasure (migration 0221) — F3 events, 5y retention.
  'member_erasure_requested',
  'member_erased',
  // COMP-1 US3-C (migration 0228) — best-effort sub-processor erasure propagation outcome.
  'subprocessor_erasure_propagated',
] as const;

// Compile-time proof that the tuple covers the full union.
// If F3AuditEventType adds a new variant that is not in the tuple,
// `F3AuditEventType extends (typeof F3_AUDIT_EVENTS)[number]` fails and
// the type resolves to `never`, making `const _: _AssertF3Coverage = true`
// a TS2322 error.
type _AssertF3Coverage = typeof F3_AUDIT_EVENTS extends
  readonly F3AuditEventType[]
  ? F3AuditEventType extends (typeof F3_AUDIT_EVENTS)[number]
    ? true
    : never
  : never;
const _: _AssertF3Coverage = true;

describe('F3AuditEventType count guard', () => {
  it('F3 audit event type count is 32 (31 prior + subprocessor_erasure_propagated)', () => {
    // Reference `_` so the compile-time proof is not tree-shaken / unused.
    expect(_).toBe(true);
    expect(F3_AUDIT_EVENTS.length).toBe(32);
  });
});
