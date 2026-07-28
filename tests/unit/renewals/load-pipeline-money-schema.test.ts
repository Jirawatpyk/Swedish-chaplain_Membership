/**
 * `loadPipelineMoneyInputSchema.nowIso` — fix round 2 #7.
 *
 * Relaxed from `z.string().datetime()` (strict RFC3339, rejects a bare
 * `YYYY-MM-DD`) to a `Date.parse` refinement so this schema accepts EXACTLY
 * the same `nowIso` shapes the `/admin/renewals` page's own gate accepts
 * (`page.tsx` validates with `!Number.isNaN(Date.parse(v))`). Pure schema
 * behaviour — no DB, no deps — so this is a fast unit test, not integration.
 */
import { describe, expect, it } from 'vitest';
import { loadPipelineMoneyInputSchema } from '@/modules/renewals';

describe('loadPipelineMoneyInputSchema.nowIso', () => {
  it('accepts a full ISO instant (the normal `new Date().toISOString()` shape)', () => {
    const result = loadPipelineMoneyInputSchema.safeParse({
      tenantId: 't',
      nowIso: '2026-07-15T03:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a bare date-only string (page.tsx gate accepts this via Date.parse; strict .datetime() would have rejected it)', () => {
    const result = loadPipelineMoneyInputSchema.safeParse({
      tenantId: 't',
      nowIso: '2026-07-15',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a value Date.parse cannot parse', () => {
    const result = loadPipelineMoneyInputSchema.safeParse({
      tenantId: 't',
      nowIso: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });
});
