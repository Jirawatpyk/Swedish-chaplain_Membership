import { describe, it, expect } from 'vitest';
import { composeStepId, composeTemplateId } from '@/app/(staff)/admin/settings/renewals/schedules/_components/step-id-composer';

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
