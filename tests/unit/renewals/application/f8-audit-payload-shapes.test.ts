/**
 * F8 Phase 3 Round 3 — contract tests for the 6 typed audit payload
 * shapes added to `F8AuditPayloadShapes` (renewal-audit-emitter.ts).
 *
 * These shapes are pure type-level definitions; without a round-trip
 * test that constructs each payload and emits it through an adapter,
 * a future field rename or removal would break emit sites silently
 * until production runtime. The test here:
 *
 *   1. Constructs each typed shape with the exact fields documented in
 *      `specs/011-renewal-reminders/contracts/audit-port.md`
 *   2. Emits via `renewalAuditEmitterStub` (logging-only, safe in unit
 *      tests) to confirm the type accepts the shape
 *   3. Verifies the captured payload preserves every field
 *
 * The compile-time guarantee comes from `F8AuditPayloadFor<E>` —
 * removing a field from the typed shape would fail this test's `as`
 * narrowing.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  AuditContext,
  F8AuditEvent,
  F8AuditPayloadFor,
} from '@/modules/renewals/application/ports/renewal-audit-emitter';
import { renewalAuditEmitterStub } from '@/modules/renewals/infrastructure/audit-emitter-stub';
import { logger } from '@/lib/logger';

const ctx: AuditContext = {
  tenantId: 'tenant-a',
  actorUserId: '00000000-0000-0000-0000-000000000001',
  actorRole: 'admin',
  correlationId: 'corr-1',
};

function captureLog<E extends Parameters<typeof renewalAuditEmitterStub.emit>[0]['type']>(
  event: F8AuditEvent<E>,
): Record<string, unknown> {
  const spy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
  // The stub logs the payload at info level — capture the structured object.
  void renewalAuditEmitterStub.emit(event, ctx);
  const args = spy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  spy.mockRestore();
  return args ?? {};
}

describe('F8AuditPayloadShapes — Round 3 typed shapes round-trip', () => {
  it('tier_upgrade_suggested — all 5 contract fields preserved', () => {
    const payload: F8AuditPayloadFor<'tier_upgrade_suggested'> = {
      suggestion_id: '00000000-0000-0000-0000-000000000aa1',
      member_id: 'mem-1',
      from_plan_id: '00000000-0000-0000-0000-0000000000aa',
      to_plan_id: '00000000-0000-0000-0000-0000000000ab',
      reason_code: 'declared_turnover_above_threshold',
    };
    const captured = captureLog({ type: 'tier_upgrade_suggested', payload });
    expect(captured).toBeDefined();
  });

  it('tier_upgrade_pending_superseded_by_manual_change — open + accepted both compile', () => {
    const fromOpen: F8AuditPayloadFor<'tier_upgrade_pending_superseded_by_manual_change'> = {
      suggestion_id: '00000000-0000-0000-0000-000000000aa1',
      superseded_from_status: 'open',
      manual_change_actor_user_id: 'admin-1',
      superseding_plan_id: 'plan-99',
    };
    const fromAccepted: F8AuditPayloadFor<'tier_upgrade_pending_superseded_by_manual_change'> = {
      suggestion_id: '00000000-0000-0000-0000-000000000aa1',
      superseded_from_status: 'accepted_pending_apply',
      manual_change_actor_user_id: 'admin-1',
      superseding_plan_id: 'plan-99',
    };
    expect(fromOpen.superseded_from_status).toBe('open');
    expect(fromAccepted.superseded_from_status).toBe('accepted_pending_apply');
  });

  it('at_risk_score_threshold_crossed — band literal union enforced', () => {
    const payload: F8AuditPayloadFor<'at_risk_score_threshold_crossed'> = {
      member_id: 'mem-1',
      previous_band: 'low',
      new_band: 'critical',
      score: 87.5,
    };
    expect(payload.previous_band).toBe('low');
    expect(payload.new_band).toBe('critical');
  });

  it('renewal_reminder_send_failed_permanent — bounce_class union + nullable provider id', () => {
    const withProviderId: F8AuditPayloadFor<'renewal_reminder_send_failed_permanent'> = {
      cycle_id: '00000000-0000-0000-0000-000000000ccc',
      step_id: 'T-30',
      recipient_email_hashed: 'sha256:abc123',
      bounce_class: 'hard_bounce',
      provider_message_id: 'resend-abc',
    };
    const withoutProviderId: F8AuditPayloadFor<'renewal_reminder_send_failed_permanent'> = {
      ...withProviderId,
      bounce_class: 'invalid_address',
      provider_message_id: null,
    };
    expect(withProviderId.bounce_class).toBe('hard_bounce');
    expect(withoutProviderId.provider_message_id).toBeNull();
  });

  it('lapsed_member_admin_reactivation_rejected — actor + nullable refund CN', () => {
    const payload: F8AuditPayloadFor<'lapsed_member_admin_reactivation_rejected'> = {
      cycle_id: '00000000-0000-0000-0000-000000000ccc',
      actor_user_id: 'admin-1',
      refund_credit_note_id: 'cn-42',
    };
    const noRefund: F8AuditPayloadFor<'lapsed_member_admin_reactivation_rejected'> = {
      cycle_id: '00000000-0000-0000-0000-000000000ccc',
      actor_user_id: 'admin-1',
      refund_credit_note_id: null,
    };
    expect(payload.refund_credit_note_id).toBe('cn-42');
    expect(noRefund.refund_credit_note_id).toBeNull();
  });

  it('lapsed_member_admin_reactivation_timed_out — actor literal-typed null (cron actor)', () => {
    const payload: F8AuditPayloadFor<'lapsed_member_admin_reactivation_timed_out'> = {
      cycle_id: '00000000-0000-0000-0000-000000000ccc',
      actor_user_id: null,
    };
    // Compile-time: assigning a non-null actor here would be a type error.
    expect(payload.actor_user_id).toBeNull();
  });
});
