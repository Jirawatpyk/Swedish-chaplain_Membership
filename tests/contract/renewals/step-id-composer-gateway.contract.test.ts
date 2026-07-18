import { describe, it, expect } from 'vitest';
import {
  composeStepId,
  composeTemplateId,
  composeUniqueStepId,
} from '@/app/(staff)/admin/settings/renewals/schedules/_components/step-id-composer';
import { daysFromOffsetKey, TIER_REMINDER_OFFSETS } from '@/modules/renewals/domain/value-objects/reminder-offsets';
import { TIER_BUCKETS } from '@/modules/renewals/client';
import {
  deriveOffsetFromStepId,
  deriveTierFromTemplateId,
} from '@/modules/renewals/infrastructure/resend-transactional-renewal-gateway';

describe('composer output resolves through the dispatch gateway parsers', () => {
  it('every per-tier email offset round-trips to non-null offset + tier', () => {
    for (const tier of TIER_BUCKETS) {
      for (const offsetKey of TIER_REMINDER_OFFSETS[tier]) {
        const days = daysFromOffsetKey(offsetKey);
        const stepId = composeStepId({ offsetDays: days, channel: 'email' });
        const templateId = composeTemplateId(days, tier);

        expect(deriveOffsetFromStepId(stepId)).toBe(offsetKey);
        expect(deriveTierFromTemplateId(templateId)).toBe(tier);
      }
    }
  });

  // v2 rework Issue 3(b) — pins the safety claim that lets
  // `composeUniqueStepId` append a disambiguator to step_id: the
  // gateway's `deriveOffsetFromStepId` only reads the FIRST dot-segment,
  // so a trailing ".2" suffix must never break offset resolution.
  it('a disambiguated (collision-suffixed) step_id still resolves to the correct offset', () => {
    const stepId = composeUniqueStepId(
      { offsetDays: -30, channel: 'email' },
      new Set(['t-30.email']),
    );
    expect(stepId).toBe('t-30.email.2');
    expect(deriveOffsetFromStepId(stepId)).toBe('t-30');
  });

  // F8 follow-up (`.superpowers/sdd/followup-tasktype-brief.md`, RS-Task-3
  // close) — the composer↔gateway round-trip above only ever exercised
  // EMAIL-channel step_ids (`<offset>.email`). A TASK-channel step_id
  // appends a THIRD dot-segment (`<offset>.task.<taskType>`), and the
  // StepCard's task-type Combobox now allows arbitrary custom task types
  // — including multi-underscore ones (e.g. `quarterly_review_meeting`,
  // one of the shared catalogue's own entries). Pin that the gateway's
  // `deriveOffsetFromStepId` (which only reads the FIRST dot-segment)
  // still resolves the correct offset regardless of how many underscores
  // or dots-worth of content the task type itself contains.
  it('a task-channel step_id (multi-underscore task_type) round-trips to the correct offset', () => {
    const stepId = composeStepId({
      offsetDays: -30,
      channel: 'task',
      taskType: 'quarterly_review_meeting',
    });
    expect(stepId).toBe('t-30.task.quarterly_review_meeting');
    expect(deriveOffsetFromStepId(stepId)).toBe('t-30');
  });
});
