/**
 * T040 spec — TenantRenewalSchedulePolicy parser + step lookup.
 */
import { describe, expect, it } from 'vitest';
import {
  parseSchedulePolicySteps,
  findStepForDate,
  findDueStepsForDate,
  REMINDER_CATCH_UP_LOOKBACK_DAYS,
  type TenantRenewalSchedulePolicy,
} from '@/modules/renewals/domain/tenant-renewal-schedule-policy';

describe('parseSchedulePolicySteps', () => {
  it('parses multi-step policy + sorts by offsetDays ascending', () => {
    const raw = [
      { step_id: 't+7.email', offset_days: 7, channel: 'email', template_id: 'late' },
      { step_id: 't-30.email', offset_days: -30, channel: 'email', template_id: 'early' },
      { step_id: 't-7.email', offset_days: -7, channel: 'email', template_id: 'mid' },
    ];
    const r = parseSchedulePolicySteps(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ids = r.value.map((s) => s.stepId);
      expect(ids).toEqual(['t-30.email', 't-7.email', 't+7.email']);
    }
  });

  it('rejects empty step list', () => {
    const r = parseSchedulePolicySteps([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('empty_steps');
  });

  it('rejects duplicate step_id', () => {
    const r = parseSchedulePolicySteps([
      { step_id: 'dup', offset_days: -30, channel: 'email', template_id: 't' },
      { step_id: 'dup', offset_days: -7, channel: 'email', template_id: 't' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'duplicate_step_id') {
      expect(r.error.stepId).toBe('dup');
    }
  });

  it('surfaces per-step parse failures with index', () => {
    const r = parseSchedulePolicySteps([
      { step_id: 'ok', offset_days: -30, channel: 'email', template_id: 't' },
      // Bad — channel='email' without template_id
      { step_id: 'bad', offset_days: -7, channel: 'email' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'step_parse_failed') {
      expect(r.error.index).toBe(1);
      expect(r.error.error.kind).toBe('email_step_missing_template_id');
    }
  });
});

describe('findStepForDate', () => {
  function policy(
    steps: TenantRenewalSchedulePolicy['steps'],
  ): TenantRenewalSchedulePolicy {
    return {
      tenantId: 't',
      tierBucket: 'regular',
      steps,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
  }

  it('matches step by anchor + offset_days alignment with today (UTC)', () => {
    // Cycle expires 2026-06-30; T-30 step fires on 2026-05-31 UTC.
    const anchor = new Date('2026-06-30T12:00:00Z');
    const today = new Date('2026-05-31T12:00:00Z');
    const p = policy([
      {
        stepId: 't-30',
        offsetDays: -30,
        channel: 'email',
        templateId: 'r.t-30',
      },
      {
        stepId: 't-7',
        offsetDays: -7,
        channel: 'email',
        templateId: 'r.t-7',
      },
    ]);
    const step = findStepForDate(p, anchor, today);
    expect(step?.stepId).toBe('t-30');
  });

  it('returns null when no step matches today (future step, not yet due)', () => {
    const anchor = new Date('2026-06-30T12:00:00Z');
    const today = new Date('2026-04-01T12:00:00Z'); // way too early — step is in the future
    const p = policy([
      {
        stepId: 't-30',
        offsetDays: -30,
        channel: 'email',
        templateId: 'r.t-30',
      },
    ]);
    expect(findStepForDate(p, anchor, today)).toBeNull();
  });

  it('matches T+0 step on the exact expiry date', () => {
    const anchor = new Date('2026-06-30T12:00:00Z');
    const today = new Date('2026-06-30T20:00:00Z'); // same UTC date
    const p = policy([
      {
        stepId: 't+0',
        offsetDays: 0,
        channel: 'email',
        templateId: 'r.t+0',
      },
    ]);
    const step = findStepForDate(p, anchor, today);
    expect(step?.stepId).toBe('t+0');
  });

  // -------------------------------------------------------------------------
  // 063 bounded catch-up — `findStepForDate` now resolves the MOST-RECENT
  // step whose due-date falls within `[today - LOOKBACK, today]` (was strict
  // day-equality). Fixes the missed-cron silent-drop: a step due YESTERDAY
  // still resolves so the dispatcher can catch up. A step older than the
  // lookback is intentionally NOT resolved (firing a stale T-90 reminder when
  // it is now T-30 is worse than skipping it). See spec.md:194 + FR-010.
  // -------------------------------------------------------------------------

  it('CATCH-UP: step due YESTERDAY (cron missed 1 day) still resolves', () => {
    // T-30 due 2026-05-31; cron runs 2026-06-01 (1 day late).
    const anchor = new Date('2026-06-30T12:00:00Z');
    const today = new Date('2026-06-01T08:00:00Z');
    const p = policy([
      { stepId: 't-30', offsetDays: -30, channel: 'email', templateId: 'r.t-30' },
      { stepId: 't-7', offsetDays: -7, channel: 'email', templateId: 'r.t-7' },
    ]);
    expect(findStepForDate(p, anchor, today)?.stepId).toBe('t-30');
  });

  it('CATCH-UP: step due exactly LOOKBACK days ago still resolves (inclusive bound)', () => {
    // T-30 due 2026-05-31; cron runs LOOKBACK days later.
    const anchor = new Date('2026-06-30T12:00:00Z');
    const dueUtc = new Date('2026-05-31T00:00:00Z').getTime();
    const ms = 24 * 60 * 60 * 1000;
    const today = new Date(dueUtc + REMINDER_CATCH_UP_LOOKBACK_DAYS * ms + 8 * 60 * 60 * 1000);
    const p = policy([
      { stepId: 't-30', offsetDays: -30, channel: 'email', templateId: 'r.t-30' },
    ]);
    expect(findStepForDate(p, anchor, today)?.stepId).toBe('t-30');
  });

  it('STALE: step due BEYOND the lookback window is NOT resolved', () => {
    // T-30 due 2026-05-31; cron runs LOOKBACK+1 days later → too stale.
    const anchor = new Date('2026-06-30T12:00:00Z');
    const dueUtc = new Date('2026-05-31T00:00:00Z').getTime();
    const ms = 24 * 60 * 60 * 1000;
    const today = new Date(dueUtc + (REMINDER_CATCH_UP_LOOKBACK_DAYS + 1) * ms + 8 * 60 * 60 * 1000);
    const p = policy([
      { stepId: 't-30', offsetDays: -30, channel: 'email', templateId: 'r.t-30' },
    ]);
    expect(findStepForDate(p, anchor, today)).toBeNull();
  });

  it('MOST-RECENT: two steps in the window → resolves the most recent (later due-date)', () => {
    // 7-day gap (tightest seed gap). T-14 due 2026-06-16, T-7 due 2026-06-23.
    // Cron runs 2026-06-23 (T-7 day) after missing the T-14 fire → fire T-7.
    const anchor = new Date('2026-06-30T12:00:00Z');
    const today = new Date('2026-06-23T08:00:00Z');
    const p = policy([
      { stepId: 't-14', offsetDays: -14, channel: 'email', templateId: 'r.t-14' },
      { stepId: 't-7', offsetDays: -7, channel: 'email', templateId: 'r.t-7' },
    ]);
    expect(findStepForDate(p, anchor, today)?.stepId).toBe('t-7');
  });
});

describe('findDueStepsForDate (bounded catch-up — most-recent first)', () => {
  function policy(
    steps: TenantRenewalSchedulePolicy['steps'],
  ): TenantRenewalSchedulePolicy {
    return {
      tenantId: 't',
      tierBucket: 'regular',
      steps,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
  }

  it('returns only the step due today when no earlier step is in the window', () => {
    const anchor = new Date('2026-06-30T12:00:00Z');
    const today = new Date('2026-06-23T08:00:00Z'); // T-7 day
    const p = policy([
      { stepId: 't-30', offsetDays: -30, channel: 'email', templateId: 'r.t-30' },
      { stepId: 't-7', offsetDays: -7, channel: 'email', templateId: 'r.t-7' },
    ]);
    const due = findDueStepsForDate(p, anchor, today);
    expect(due.map((s) => s.stepId)).toEqual(['t-7']);
  });

  it('returns window steps MOST-RECENT first (later due-date before earlier)', () => {
    // T-14 due 2026-06-16, T-7 due 2026-06-23. Window [today-7, today] on
    // 2026-06-23 includes both (7-day gap == lookback edge).
    const anchor = new Date('2026-06-30T12:00:00Z');
    const today = new Date('2026-06-23T08:00:00Z');
    const p = policy([
      { stepId: 't-14', offsetDays: -14, channel: 'email', templateId: 'r.t-14' },
      { stepId: 't-7', offsetDays: -7, channel: 'email', templateId: 'r.t-7' },
    ]);
    const due = findDueStepsForDate(p, anchor, today);
    // Most-recent (t-7) first so the caller fires the most relevant unfired step.
    expect(due[0]?.stepId).toBe('t-7');
    expect(due.map((s) => s.stepId)).toEqual(['t-7', 't-14']);
  });

  it('excludes future steps (target > today)', () => {
    const anchor = new Date('2026-06-30T12:00:00Z');
    const today = new Date('2026-04-01T08:00:00Z'); // before any step is due
    const p = policy([
      { stepId: 't-30', offsetDays: -30, channel: 'email', templateId: 'r.t-30' },
    ]);
    expect(findDueStepsForDate(p, anchor, today)).toEqual([]);
  });

  it('excludes stale steps (target < today - lookback)', () => {
    const anchor = new Date('2026-06-30T12:00:00Z');
    // T-30 due 2026-05-31; today far beyond lookback.
    const today = new Date('2026-06-20T08:00:00Z');
    const p = policy([
      { stepId: 't-30', offsetDays: -30, channel: 'email', templateId: 'r.t-30' },
    ]);
    expect(findDueStepsForDate(p, anchor, today)).toEqual([]);
  });

  it('LOOKBACK constant is 7 (tightest seed step gap T-14→T-7)', () => {
    expect(REMINDER_CATCH_UP_LOOKBACK_DAYS).toBe(7);
  });
});
