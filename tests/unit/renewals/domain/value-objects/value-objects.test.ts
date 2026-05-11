/**
 * F8 Phase 2 Wave D — value-object spec.ts (T030–T033 colocated).
 *
 * Domain layer Constitution Principle II: 100% line coverage. Single
 * spec file covers all 4 value objects for one-shot Vitest invocation
 * + simpler grep when reviewing.
 */
import { describe, expect, it } from 'vitest';
import {
  TIER_BUCKETS,
  asTierBucket,
  parseTierBucket,
  isTierBucket,
} from '@/modules/renewals/domain/value-objects/tier-bucket';
import {
  CYCLE_STATUSES,
  TERMINAL_CYCLE_STATUSES,
  asCycleStatus,
  parseCycleStatus,
  isTerminalCycleStatus,
  canTransition,
  assertCanTransition,
} from '@/modules/renewals/domain/value-objects/cycle-status';
import {
  RISK_BANDS,
  RISK_BAND_THRESHOLDS,
  asRiskBand,
  parseRiskBand,
  bandForScore,
  isAtRiskWidgetBand,
} from '@/modules/renewals/domain/value-objects/risk-band';
import {
  REMINDER_CHANNELS,
  REMINDER_ASSIGNEE_ROLES,
  REMINDER_OFFSET_DAYS_MIN,
  REMINDER_OFFSET_DAYS_MAX,
  parseReminderStep,
  reminderStepToJson,
  type ReminderStep,
} from '@/modules/renewals/domain/value-objects/reminder-step';

// ─────────────────────────────────────────────────────────────────────
// T030 — TierBucket
// ─────────────────────────────────────────────────────────────────────
describe('TierBucket (T030)', () => {
  it('TIER_BUCKETS contains the 5 canonical buckets per /speckit.clarify Q2 round 1', () => {
    expect(TIER_BUCKETS).toEqual([
      'thai_alumni',
      'start_up',
      'regular',
      'premium',
      'partnership',
    ]);
  });

  it('asTierBucket — unchecked cast (trusted contexts only)', () => {
    expect(asTierBucket('regular')).toBe('regular');
    // Even garbage casts compile + return verbatim — purpose is the brand.
    expect(asTierBucket('garbage')).toBe('garbage');
  });

  it('parseTierBucket — accepts all 5 buckets', () => {
    for (const bucket of TIER_BUCKETS) {
      const r = parseTierBucket(bucket);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(bucket);
    }
  });

  it('parseTierBucket — rejects unknown strings + surfaces the raw input', () => {
    const r = parseTierBucket('enterprise');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid_tier_bucket');
      expect(r.error.raw).toBe('enterprise');
    }
  });

  it('isTierBucket — runtime narrowing predicate', () => {
    expect(isTierBucket('regular')).toBe(true);
    expect(isTierBucket('enterprise')).toBe(false);
    expect(isTierBucket(42)).toBe(false);
    expect(isTierBucket(null)).toBe(false);
    expect(isTierBucket(undefined)).toBe(false);
    expect(isTierBucket({})).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// T031 — CycleStatus
// ─────────────────────────────────────────────────────────────────────
describe('CycleStatus (T031)', () => {
  it('CYCLE_STATUSES has the 7-state set including pending_admin_reactivation', () => {
    expect(CYCLE_STATUSES).toEqual([
      'upcoming',
      'reminded',
      'awaiting_payment',
      'completed',
      'lapsed',
      'cancelled',
      'pending_admin_reactivation',
    ]);
  });

  it('TERMINAL_CYCLE_STATUSES = completed | lapsed | cancelled', () => {
    expect(TERMINAL_CYCLE_STATUSES).toEqual(['completed', 'lapsed', 'cancelled']);
  });

  it('asCycleStatus — unchecked cast', () => {
    expect(asCycleStatus('upcoming')).toBe('upcoming');
    expect(asCycleStatus('garbage')).toBe('garbage');
  });

  it('parseCycleStatus — accepts every canonical state', () => {
    for (const s of CYCLE_STATUSES) {
      const r = parseCycleStatus(s);
      expect(r.ok).toBe(true);
    }
  });

  it('parseCycleStatus — rejects unknown', () => {
    const r = parseCycleStatus('paid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.raw).toBe('paid');
  });

  it('isTerminalCycleStatus — true only for terminal trio', () => {
    expect(isTerminalCycleStatus('completed')).toBe(true);
    expect(isTerminalCycleStatus('lapsed')).toBe(true);
    expect(isTerminalCycleStatus('cancelled')).toBe(true);
    expect(isTerminalCycleStatus('upcoming')).toBe(false);
    expect(isTerminalCycleStatus('reminded')).toBe(false);
    expect(isTerminalCycleStatus('awaiting_payment')).toBe(false);
    expect(isTerminalCycleStatus('pending_admin_reactivation')).toBe(false);
  });

  it('canTransition — happy paths from data-model § 2.1 state diagram', () => {
    // upcoming → reminded → awaiting_payment → completed
    expect(canTransition('upcoming', 'reminded')).toBe(true);
    expect(canTransition('reminded', 'awaiting_payment')).toBe(true);
    expect(canTransition('awaiting_payment', 'completed')).toBe(true);
    // awaiting_payment → lapsed (grace exhausted)
    expect(canTransition('awaiting_payment', 'lapsed')).toBe(true);
    // awaiting_payment → pending_admin_reactivation (FR-005b)
    expect(canTransition('awaiting_payment', 'pending_admin_reactivation')).toBe(
      true,
    );
    // pending_admin_reactivation → completed | cancelled
    expect(canTransition('pending_admin_reactivation', 'completed')).toBe(true);
    expect(canTransition('pending_admin_reactivation', 'cancelled')).toBe(true);
    // lapsed → re-enter
    expect(canTransition('lapsed', 'awaiting_payment')).toBe(true);
    expect(canTransition('lapsed', 'pending_admin_reactivation')).toBe(true);
  });

  it('canTransition — admin cancel allowed from every non-terminal state', () => {
    expect(canTransition('upcoming', 'cancelled')).toBe(true);
    expect(canTransition('reminded', 'cancelled')).toBe(true);
    expect(canTransition('awaiting_payment', 'cancelled')).toBe(true);
    expect(canTransition('pending_admin_reactivation', 'cancelled')).toBe(true);
  });

  it('canTransition — terminal states have NO outbound transitions', () => {
    for (const target of CYCLE_STATUSES) {
      expect(canTransition('completed', target)).toBe(false);
      expect(canTransition('cancelled', target)).toBe(false);
    }
  });

  it('canTransition — rejects illegal jumps (e.g. upcoming → completed direct)', () => {
    expect(canTransition('upcoming', 'completed')).toBe(false);
    expect(canTransition('reminded', 'completed')).toBe(false);
    expect(canTransition('reminded', 'lapsed')).toBe(false);
    expect(canTransition('upcoming', 'lapsed')).toBe(false);
  });

  it('assertCanTransition — Result wrapper around canTransition', () => {
    expect(assertCanTransition('upcoming', 'reminded').ok).toBe(true);
    const r = assertCanTransition('completed', 'upcoming');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid_transition');
      expect(r.error.from).toBe('completed');
      expect(r.error.to).toBe('upcoming');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// T032 — RiskBand
// ─────────────────────────────────────────────────────────────────────
describe('RiskBand (T032)', () => {
  it('RISK_BANDS = 4-band classification', () => {
    expect(RISK_BANDS).toEqual(['healthy', 'warning', 'at-risk', 'critical']);
  });

  it('RISK_BAND_THRESHOLDS — contiguous 0-100 coverage', () => {
    expect(RISK_BAND_THRESHOLDS.healthy).toEqual({ minInclusive: 0, maxInclusive: 24 });
    expect(RISK_BAND_THRESHOLDS.warning).toEqual({ minInclusive: 25, maxInclusive: 49 });
    expect(RISK_BAND_THRESHOLDS['at-risk']).toEqual({ minInclusive: 50, maxInclusive: 74 });
    expect(RISK_BAND_THRESHOLDS.critical).toEqual({ minInclusive: 75, maxInclusive: 100 });
  });

  it('asRiskBand — unchecked cast', () => {
    expect(asRiskBand('healthy')).toBe('healthy');
    expect(asRiskBand('garbage')).toBe('garbage');
  });

  it('parseRiskBand — accepts canonical + rejects unknown', () => {
    for (const band of RISK_BANDS) {
      expect(parseRiskBand(band).ok).toBe(true);
    }
    const r = parseRiskBand('safe');
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'invalid_risk_band') {
      expect(r.error.raw).toBe('safe');
    }
  });

  it('bandForScore — boundaries land in the expected band', () => {
    expect(bandForScore(0)).toEqual({ ok: true, value: 'healthy' });
    expect(bandForScore(24)).toEqual({ ok: true, value: 'healthy' });
    expect(bandForScore(25)).toEqual({ ok: true, value: 'warning' });
    expect(bandForScore(49)).toEqual({ ok: true, value: 'warning' });
    expect(bandForScore(50)).toEqual({ ok: true, value: 'at-risk' });
    expect(bandForScore(74)).toEqual({ ok: true, value: 'at-risk' });
    expect(bandForScore(75)).toEqual({ ok: true, value: 'critical' });
    expect(bandForScore(100)).toEqual({ ok: true, value: 'critical' });
  });

  it('bandForScore — out-of-range + non-finite values reject with typed error', () => {
    for (const bad of [-1, 101, NaN, Infinity, -Infinity]) {
      const r = bandForScore(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('score_out_of_range');
    }
  });

  it('isAtRiskWidgetBand — true for at-risk + critical only', () => {
    expect(isAtRiskWidgetBand('at-risk')).toBe(true);
    expect(isAtRiskWidgetBand('critical')).toBe(true);
    expect(isAtRiskWidgetBand('healthy')).toBe(false);
    expect(isAtRiskWidgetBand('warning')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// T033 — ReminderStep
// ─────────────────────────────────────────────────────────────────────
describe('ReminderStep (T033)', () => {
  it('REMINDER_CHANNELS + REMINDER_ASSIGNEE_ROLES + offset bounds', () => {
    expect(REMINDER_CHANNELS).toEqual(['email', 'task']);
    expect(REMINDER_ASSIGNEE_ROLES).toEqual([
      'admin',
      'manager',
      'executive_director',
    ]);
    expect(REMINDER_OFFSET_DAYS_MIN).toBe(-365);
    expect(REMINDER_OFFSET_DAYS_MAX).toBe(365);
  });

  it('parseReminderStep — accepts canonical email step', () => {
    const r = parseReminderStep({
      step_id: 't-30.email',
      offset_days: -30,
      channel: 'email',
      template_id: 'renewal.t-30.regular',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.channel).toBe('email');
      expect(r.value.stepId).toBe('t-30.email');
      expect(r.value.offsetDays).toBe(-30);
      if (r.value.channel === 'email') {
        expect(r.value.templateId).toBe('renewal.t-30.regular');
      }
    }
  });

  it('parseReminderStep — accepts canonical task step', () => {
    const r = parseReminderStep({
      step_id: 't-120.task.quarterly_review',
      offset_days: -120,
      channel: 'task',
      task_type: 'quarterly_review_meeting',
      assignee_role: 'executive_director',
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.channel === 'task') {
      expect(r.value.taskType).toBe('quarterly_review_meeting');
      expect(r.value.assigneeRole).toBe('executive_director');
    }
  });

  it('parseReminderStep — rejects missing step_id', () => {
    const cases = [{ offset_days: 0, channel: 'email' }, { step_id: '' }];
    for (const raw of cases) {
      const r = parseReminderStep(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('missing_step_id');
    }
  });

  it('parseReminderStep — rejects non-integer / out-of-range offset_days', () => {
    const r1 = parseReminderStep({
      step_id: 's',
      offset_days: 'thirty' as unknown as number,
      channel: 'email',
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.kind).toBe('offset_days_not_integer');

    const r2 = parseReminderStep({
      step_id: 's',
      offset_days: 1.5,
      channel: 'email',
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.kind).toBe('offset_days_not_integer');

    const r3 = parseReminderStep({
      step_id: 's',
      offset_days: -400,
      channel: 'email',
      template_id: 't',
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.kind).toBe('offset_days_out_of_range');

    const r4 = parseReminderStep({
      step_id: 's',
      offset_days: 400,
      channel: 'email',
      template_id: 't',
    });
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.error.kind).toBe('offset_days_out_of_range');
  });

  it('parseReminderStep — rejects invalid channel', () => {
    const r1 = parseReminderStep({
      step_id: 's',
      offset_days: 0,
      channel: 'sms',
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.error.kind).toBe('invalid_channel');
      if (r1.error.kind === 'invalid_channel') {
        expect(r1.error.raw).toBe('sms');
      }
    }

    const r2 = parseReminderStep({
      step_id: 's',
      offset_days: 0,
      channel: 42 as unknown as string,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.kind).toBe('invalid_channel');
  });

  it('parseReminderStep — email step missing template_id', () => {
    const r = parseReminderStep({
      step_id: 's',
      offset_days: 0,
      channel: 'email',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('email_step_missing_template_id');
  });

  it('parseReminderStep — email step with task fields rejected', () => {
    const r = parseReminderStep({
      step_id: 's',
      offset_days: 0,
      channel: 'email',
      template_id: 't',
      task_type: 'phone_call',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('email_step_has_task_fields');
  });

  it('parseReminderStep — task step missing fields', () => {
    const r1 = parseReminderStep({
      step_id: 's',
      offset_days: 0,
      channel: 'task',
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.kind).toBe('task_step_missing_task_type');

    const r2 = parseReminderStep({
      step_id: 's',
      offset_days: 0,
      channel: 'task',
      task_type: 'phone_call',
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.kind).toBe('task_step_missing_assignee_role');

    const r3 = parseReminderStep({
      step_id: 's',
      offset_days: 0,
      channel: 'task',
      task_type: 'phone_call',
      assignee_role: 'random_role',
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.kind).toBe('task_step_invalid_assignee_role');
  });

  it('parseReminderStep — task step with template_id rejected', () => {
    const r = parseReminderStep({
      step_id: 's',
      offset_days: 0,
      channel: 'task',
      task_type: 'phone_call',
      assignee_role: 'admin',
      template_id: 'renewal.t-30',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('task_step_has_template_id');
  });

  it('reminderStepToJson — round-trips email step', () => {
    const step: ReminderStep = {
      stepId: 't-30',
      offsetDays: -30,
      channel: 'email',
      templateId: 'renewal.t-30',
    };
    expect(reminderStepToJson(step)).toEqual({
      step_id: 't-30',
      offset_days: -30,
      channel: 'email',
      template_id: 'renewal.t-30',
    });
  });

  it('reminderStepToJson — round-trips task step', () => {
    const step: ReminderStep = {
      stepId: 't+30',
      offsetDays: 30,
      channel: 'task',
      taskType: 'phone_call',
      assigneeRole: 'admin',
    };
    expect(reminderStepToJson(step)).toEqual({
      step_id: 't+30',
      offset_days: 30,
      channel: 'task',
      task_type: 'phone_call',
      assignee_role: 'admin',
    });
  });
});
