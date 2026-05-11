/**
 * T040 spec — TenantRenewalSchedulePolicy parser + step lookup.
 */
import { describe, expect, it } from 'vitest';
import {
  parseSchedulePolicySteps,
  findStepForDate,
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

  it('returns null when no step matches today', () => {
    const anchor = new Date('2026-06-30T12:00:00Z');
    const today = new Date('2026-04-01T12:00:00Z'); // way too early
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
});
