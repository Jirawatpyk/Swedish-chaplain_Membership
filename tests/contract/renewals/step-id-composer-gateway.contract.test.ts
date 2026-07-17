import { describe, it, expect } from 'vitest';
import { composeStepId, composeTemplateId } from '@/app/(staff)/admin/settings/renewals/schedules/_components/step-id-composer';
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
});
