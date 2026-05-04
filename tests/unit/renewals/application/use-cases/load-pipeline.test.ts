/**
 * F8 Phase 3 Wave H2 · T056 spec — `loadPipeline` use-case.
 *
 * Unit-level coverage with mocked deps. The Drizzle adapter is
 * exercised end-to-end in the H5 integration test against live Neon.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  loadPipeline,
  loadPipelineInputSchema,
} from '@/modules/renewals/application/use-cases/load-pipeline';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { PipelineQueryResult } from '@/modules/renewals/application/ports/renewal-cycle-repo';

function emptyResult(): PipelineQueryResult {
  return {
    rows: [],
    nextCursor: null,
    summary: {
      totalInWindow: 0,
      byUrgency: {
        't-90': 0,
        't-60': 0,
        't-30': 0,
        't-14': 0,
        't-7': 0,
        't-0': 0,
        grace: 0,
        lapsed: 0,
      },
      lapsedCount: 0,
    },
  };
}

function fakeDeps(loadFn: () => Promise<PipelineQueryResult>): RenewalsDeps {
  return {
    cyclesRepo: {
      loadPipelinePage: vi.fn(loadFn),
    } as unknown as RenewalsDeps['cyclesRepo'],
  } as unknown as RenewalsDeps;
}

describe('loadPipeline (T056)', () => {
  it('input schema rejects limit > 200', () => {
    const result = loadPipelineInputSchema.safeParse({
      tenantId: 't',
      limit: 201,
    });
    expect(result.success).toBe(false);
  });

  it('input schema accepts canonical urgency + tier values', () => {
    expect(
      loadPipelineInputSchema.safeParse({
        tenantId: 't',
        tier: 'premium',
        urgency: 't-30',
      }).success,
    ).toBe(true);
  });

  it('forwards filters to cyclesRepo + returns result on ok', async () => {
    const expected = emptyResult();
    const deps = fakeDeps(async () => expected);
    const r = await loadPipeline(deps, {
      tenantId: 't',
      tier: 'premium',
      urgency: 't-30',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual(expected);
    }
    expect(deps.cyclesRepo.loadPipelinePage).toHaveBeenCalledWith(
      't',
      expect.objectContaining({
        tier: 'premium',
        urgency: 't-30',
        limit: 50,
      }),
    );
  });

  it('clamps limit default to 50', async () => {
    const deps = fakeDeps(async () => emptyResult());
    await loadPipeline(deps, { tenantId: 't' });
    expect(deps.cyclesRepo.loadPipelinePage).toHaveBeenCalledWith(
      't',
      expect.objectContaining({ limit: 50 }),
    );
  });

  it('returns invalid_input when zod parse fails', async () => {
    const deps = fakeDeps(async () => emptyResult());
    const r = await loadPipeline(deps, {
      tenantId: '',
    } as unknown as Parameters<typeof loadPipeline>[1]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid_input');
    }
  });
});
