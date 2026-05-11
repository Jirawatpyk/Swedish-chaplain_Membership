/**
 * F8 Phase 9 retrofit (PR #25) — `pruneConsumedTokens` unit tests.
 *
 * Covers happy path, retention cutoff math (60 days), zero-rows
 * idempotency, repo-throw mapping to `server_error`, and input
 * validation (invalid_input on missing fields).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  pruneConsumedTokens,
  PRUNE_RETENTION_DAYS,
} from '@/modules/renewals/application/use-cases/prune-consumed-tokens';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';

const TENANT_ID = 'tenantA';
const FROZEN_NOW = new Date('2026-05-11T00:00:00.000Z');

function fakeDeps(args: {
  pruneImpl?: (cutoff: Date) => Promise<{ readonly pruned: number }>;
}): {
  deps: RenewalsDeps;
  pruneMock: ReturnType<typeof vi.fn>;
} {
  const pruneMock = vi.fn(
    args.pruneImpl ?? (async () => ({ pruned: 0 })),
  );
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    consumedLinkTokensRepo: {
      markConsumed: vi.fn(),
      pruneOlderThan: pruneMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, pruneMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  correlationId: 'corr-prune-1',
  now: FROZEN_NOW,
};

describe('pruneConsumedTokens (Phase 9 retrofit)', () => {
  it('happy path — returns pruned count + cutoff ISO at the 60-day window', async () => {
    const { deps, pruneMock } = fakeDeps({
      pruneImpl: async () => ({ pruned: 42 }),
    });
    const r = await pruneConsumedTokens(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.pruned).toBe(42);
      // Cutoff = now - 60 days. Verify the use-case computes UTC
      // boundary correctly + forwards it to the adapter unchanged.
      const expectedCutoff = new Date(
        FROZEN_NOW.getTime() - 60 * 24 * 60 * 60 * 1000,
      );
      expect(r.value.cutoffIso).toBe(expectedCutoff.toISOString());
      expect(r.value.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(pruneMock).toHaveBeenCalledTimes(1);
    const passedCutoff = pruneMock.mock.calls[0]?.[0] as Date;
    expect(passedCutoff.toISOString()).toBe(
      new Date(FROZEN_NOW.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it('exposes PRUNE_RETENTION_DAYS constant = 60 (data-model.md § 2.8)', () => {
    expect(PRUNE_RETENTION_DAYS).toBe(60);
  });

  it('zero pruned rows is a valid steady-state (idempotency)', async () => {
    // A re-run on the same cutoff (or empty table) returns 0. Verify
    // the use-case treats 0 as success, not failure — cron-job.org
    // dashboards expect 0 most weeks.
    const { deps } = fakeDeps({ pruneImpl: async () => ({ pruned: 0 }) });
    const r = await pruneConsumedTokens(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.pruned).toBe(0);
  });

  it('maps adapter throw to server_error (preserves message)', async () => {
    const { deps } = fakeDeps({
      pruneImpl: async () => {
        throw new Error('connection terminated by server');
      },
    });
    const r = await pruneConsumedTokens(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('server_error');
      if (r.error.kind === 'server_error') {
        expect(r.error.message).toContain('connection terminated');
      }
    }
  });

  it('invalid_input on missing correlationId', async () => {
    const { deps } = fakeDeps({});
    const r = await pruneConsumedTokens(deps, {
      ...baseInput,
      correlationId: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('invalid_input on missing tenantId', async () => {
    const { deps } = fakeDeps({});
    const r = await pruneConsumedTokens(deps, {
      ...baseInput,
      tenantId: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('invalid_input on missing `now` (must be Date)', async () => {
    const { deps } = fakeDeps({});
    // Cast away type-safety to verify the runtime zod check
    // (TypeScript-only callers can't reach this path, but
    // serialized inputs from route handlers could in theory).
    const r = await pruneConsumedTokens(deps, {
      ...baseInput,
      now: 'not-a-date' as unknown as Date,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('cutoff is exclusive — pruneOlderThan called with cutoff < now', async () => {
    // Sanity check that the cutoff is in the past relative to `now`.
    // Without this guard a refactor that flipped sign would prune
    // future-dated rows (impossible in practice but tests catch the
    // class of bug).
    const { deps, pruneMock } = fakeDeps({});
    await pruneConsumedTokens(deps, baseInput);
    const cutoff = pruneMock.mock.calls[0]?.[0] as Date;
    expect(cutoff.getTime()).toBeLessThan(FROZEN_NOW.getTime());
    expect(cutoff.getTime()).toBe(
      FROZEN_NOW.getTime() - 60 * 24 * 60 * 60 * 1000,
    );
  });
});
