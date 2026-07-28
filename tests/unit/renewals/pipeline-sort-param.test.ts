/**
 * Wave 2 Task 8 — `loadPipelineInputSchema` additive `sort` param.
 *
 * The `?sort` query param (expiry/tier, both directions) is purely
 * ADDITIVE: an absent `sort` still parses (server default `expires_at_asc`
 * is applied downstream), a valid value parses, and an unknown value is
 * REJECTED (zod strips unknown OBJECT keys by default, so the enum guard is
 * what makes `bogus` a parse failure rather than a silently-dropped field
 * that would then mis-page the keyset cursor). Pure schema behaviour — no
 * DB, no deps — so this is a fast unit test.
 */
import { describe, expect, it } from 'vitest';
import { loadPipelineInputSchema } from '@/modules/renewals';

describe('loadPipeline input — additive sort param', () => {
  it('accepts every valid sort value', () => {
    for (const sort of [
      'expires_at_asc',
      'expires_at_desc',
      'tier_asc',
      'tier_desc',
    ] as const) {
      expect(
        loadPipelineInputSchema.safeParse({ tenantId: 't', sort }).success,
      ).toBe(true);
    }
  });

  it('omitting sort still parses (server default order preserved)', () => {
    const r = loadPipelineInputSchema.safeParse({ tenantId: 't' });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown sort value', () => {
    expect(
      loadPipelineInputSchema.safeParse({ tenantId: 't', sort: 'bogus' }).success,
    ).toBe(false);
  });
});
