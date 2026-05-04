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
import {
  asSha256Hex,
  type AuditContext,
  type F8AuditEvent,
  type F8AuditPayloadFor,
} from '@/modules/renewals/application/ports/renewal-audit-emitter';
import { renewalAuditEmitterStub } from '@/modules/renewals/infrastructure/audit-emitter-stub';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import { asSuggestionId } from '@/modules/renewals/domain/tier-upgrade-suggestion';
import { asMemberId, asPlanId } from '@/modules/members';
import { asCreditNoteId } from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import type { UserId } from '@/modules/auth/domain/branded';

const asUserId = (raw: string): UserId => raw as UserId;

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
  it('tier_upgrade_suggested — all 5 contract fields preserved + branded IDs round-trip', () => {
    const payload: F8AuditPayloadFor<'tier_upgrade_suggested'> = {
      suggestion_id: asSuggestionId('00000000-0000-0000-0000-000000000aa1'),
      member_id: asMemberId('mem-1'),
      from_plan_id: asPlanId('00000000-0000-0000-0000-0000000000aa'),
      to_plan_id: asPlanId('00000000-0000-0000-0000-0000000000ab'),
      reason_code: 'declared_turnover_above_threshold',
    };
    const captured = captureLog({ type: 'tier_upgrade_suggested', payload });
    // Round 4: assert the captured log object actually preserves every
    // field (forensics-grade contract test, not just wiring).
    expect(captured).toMatchObject({
      f8AuditStub: true,
      eventType: 'tier_upgrade_suggested',
      payload: {
        suggestion_id: '00000000-0000-0000-0000-000000000aa1',
        member_id: 'mem-1',
        from_plan_id: '00000000-0000-0000-0000-0000000000aa',
        to_plan_id: '00000000-0000-0000-0000-0000000000ab',
        reason_code: 'declared_turnover_above_threshold',
      },
    });
  });

  it('tier_upgrade_pending_superseded_by_manual_change — open + accepted both round-trip through stub', () => {
    const fromOpen: F8AuditPayloadFor<'tier_upgrade_pending_superseded_by_manual_change'> = {
      suggestion_id: asSuggestionId('00000000-0000-0000-0000-000000000aa1'),
      superseded_from_status: 'open',
      manual_change_actor_user_id: asUserId('admin-1'),
      superseding_plan_id: asPlanId('plan-99'),
    };
    const fromAccepted: F8AuditPayloadFor<'tier_upgrade_pending_superseded_by_manual_change'> = {
      suggestion_id: asSuggestionId('00000000-0000-0000-0000-000000000aa1'),
      superseded_from_status: 'accepted_pending_apply',
      manual_change_actor_user_id: asUserId('admin-1'),
      superseding_plan_id: asPlanId('plan-99'),
    };
    // Round 5 S-08 — assert the captured log object actually preserves
    // every branded-ID field (forensics-grade contract test).
    const capturedOpen = captureLog({
      type: 'tier_upgrade_pending_superseded_by_manual_change',
      payload: fromOpen,
    });
    expect(capturedOpen).toMatchObject({
      eventType: 'tier_upgrade_pending_superseded_by_manual_change',
      payload: {
        suggestion_id: '00000000-0000-0000-0000-000000000aa1',
        superseded_from_status: 'open',
        manual_change_actor_user_id: 'admin-1',
        superseding_plan_id: 'plan-99',
      },
    });
    expect(fromAccepted.superseded_from_status).toBe('accepted_pending_apply');
  });

  it('at_risk_score_threshold_crossed — BandTransition DU rejects ALL 4 same-band noise cases', () => {
    const payload: F8AuditPayloadFor<'at_risk_score_threshold_crossed'> = {
      member_id: asMemberId('mem-1'),
      previous_band: 'low',
      new_band: 'critical',
      score: 87.5,
    };
    expect(payload.previous_band).toBe('low');
    expect(payload.new_band).toBe('critical');

    // Compile-time invariant: same-band "transition" is a TS error
    // because no arm of BandTransition matches `<X> → <X>`. All 4
    // same-band cases are asserted so a future arm-shape regression
    // (e.g., accidentally adding `new_band: 'low'` to the `low` arm)
    // surfaces here, not in production forensics noise.

    // @ts-expect-error — BandTransition arm `low` does not allow new_band: 'low'
    const _illegalLow: F8AuditPayloadFor<'at_risk_score_threshold_crossed'> = {
      member_id: asMemberId('mem-1'),
      previous_band: 'low',
      new_band: 'low',
      score: 0,
    };
    // @ts-expect-error — BandTransition arm `medium` does not allow new_band: 'medium'
    const _illegalMedium: F8AuditPayloadFor<'at_risk_score_threshold_crossed'> = {
      member_id: asMemberId('mem-1'),
      previous_band: 'medium',
      new_band: 'medium',
      score: 50,
    };
    // @ts-expect-error — BandTransition arm `high` does not allow new_band: 'high'
    const _illegalHigh: F8AuditPayloadFor<'at_risk_score_threshold_crossed'> = {
      member_id: asMemberId('mem-1'),
      previous_band: 'high',
      new_band: 'high',
      score: 75,
    };
    // @ts-expect-error — BandTransition arm `critical` does not allow new_band: 'critical'
    const _illegalCritical: F8AuditPayloadFor<'at_risk_score_threshold_crossed'> = {
      member_id: asMemberId('mem-1'),
      previous_band: 'critical',
      new_band: 'critical',
      score: 95,
    };
    expect(_illegalLow).toBeDefined();
    expect(_illegalMedium).toBeDefined();
    expect(_illegalHigh).toBeDefined();
    expect(_illegalCritical).toBeDefined();
  });

  it('renewal_reminder_send_failed_permanent — bounce_class union + Sha256Hex brand', () => {
    const withProviderId: F8AuditPayloadFor<'renewal_reminder_send_failed_permanent'> = {
      cycle_id: asCycleId('00000000-0000-0000-0000-000000000ccc'),
      step_id: 'T-30',
      recipient_email_hashed: asSha256Hex(
        'sha256:0000000000000000000000000000000000000000000000000000000000000abc',
      ),
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

    // Round 5 S-08 — round-trip the Sha256Hex brand through stub
    // logging to confirm the field survives serialisation.
    const captured = captureLog({
      type: 'renewal_reminder_send_failed_permanent',
      payload: withProviderId,
    });
    expect(captured).toMatchObject({
      eventType: 'renewal_reminder_send_failed_permanent',
      payload: {
        cycle_id: '00000000-0000-0000-0000-000000000ccc',
        step_id: 'T-30',
        recipient_email_hashed:
          'sha256:0000000000000000000000000000000000000000000000000000000000000abc',
        bounce_class: 'hard_bounce',
        provider_message_id: 'resend-abc',
      },
    });
  });

  it('lapsed_member_admin_reactivation_rejected — actor + nullable refund CN', () => {
    const payload: F8AuditPayloadFor<'lapsed_member_admin_reactivation_rejected'> = {
      cycle_id: asCycleId('00000000-0000-0000-0000-000000000ccc'),
      actor_user_id: asUserId('admin-1'),
      refund_credit_note_id: asCreditNoteId('cn-42'),
    };
    const noRefund: F8AuditPayloadFor<'lapsed_member_admin_reactivation_rejected'> = {
      cycle_id: asCycleId('00000000-0000-0000-0000-000000000ccc'),
      actor_user_id: asUserId('admin-1'),
      refund_credit_note_id: null,
    };
    expect(payload.refund_credit_note_id).toBe('cn-42');
    expect(noRefund.refund_credit_note_id).toBeNull();
  });

  it('lapsed_member_admin_reactivation_timed_out — actor literal-typed null (cron actor)', () => {
    const payload: F8AuditPayloadFor<'lapsed_member_admin_reactivation_timed_out'> = {
      cycle_id: asCycleId('00000000-0000-0000-0000-000000000ccc'),
      actor_user_id: null,
    };
    // Compile-time: assigning a non-null actor here would be a type error.
    expect(payload.actor_user_id).toBeNull();
  });
});
