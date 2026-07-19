import { describe, it, expect } from 'vitest';
import {
  composeStepId,
  composeTemplateId,
  composeUniqueStepId,
} from '@/app/(staff)/admin/settings/renewals/schedules/_components/step-id-composer';

describe('composeStepId', () => {
  it('email: offset-first, channel suffix', () => {
    expect(composeStepId({ offsetDays: -30, channel: 'email' })).toBe('t-30.email');
    expect(composeStepId({ offsetDays: 0, channel: 'email' })).toBe('t+0.email');
  });
  it('task: offset-first, task + taskType', () => {
    expect(composeStepId({ offsetDays: -60, channel: 'task', taskType: 'phone_call' }))
      .toBe('t-60.task.phone_call');
  });
});

describe('composeTemplateId', () => {
  it('renewal.<offset>.<tier> with underscore tier', () => {
    expect(composeTemplateId(-30, 'thai_alumni')).toBe('renewal.t-30.thai_alumni');
    expect(composeTemplateId(7, 'regular')).toBe('renewal.t+7.regular');
  });
});

// v2 rework Issue 3(b) — collision-safe disambiguation. Two "Add step"
// clicks previously produced two `t-30.email` steps (duplicate React
// key + 422 from the Domain's bucket-wide `parseSchedulePolicySteps`
// uniqueness check). `composeUniqueStepId` appends a deterministic
// numeric suffix to the step_id ONLY when the base id already exists.
describe('composeUniqueStepId', () => {
  it('returns the base id unchanged when there is no collision', () => {
    expect(composeUniqueStepId({ offsetDays: -30, channel: 'email' }, new Set())).toBe(
      't-30.email',
    );
  });

  it('appends a deterministic ".2" suffix on the first collision', () => {
    expect(
      composeUniqueStepId({ offsetDays: -30, channel: 'email' }, new Set(['t-30.email'])),
    ).toBe('t-30.email.2');
  });

  it('advances past already-taken suffixes (".3", ".4", …)', () => {
    expect(
      composeUniqueStepId(
        { offsetDays: -30, channel: 'email' },
        new Set(['t-30.email', 't-30.email.2', 't-30.email.3']),
      ),
    ).toBe('t-30.email.4');
  });

  it('disambiguates task step_ids (offset+channel+taskType base) the same way', () => {
    expect(
      composeUniqueStepId(
        { offsetDays: -60, channel: 'task', taskType: 'phone_call' },
        new Set(['t-60.task.phone_call']),
      ),
    ).toBe('t-60.task.phone_call.2');
  });

  it('is deterministic — same inputs always produce the same output (no Math.random/Date.now)', () => {
    const existing = new Set(['t-30.email']);
    const a = composeUniqueStepId({ offsetDays: -30, channel: 'email' }, existing);
    const b = composeUniqueStepId({ offsetDays: -30, channel: 'email' }, existing);
    expect(a).toBe(b);
  });
});
