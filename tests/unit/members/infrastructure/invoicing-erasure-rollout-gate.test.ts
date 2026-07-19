/**
 * `FEATURE_ERASURE_DISCARD_DRAFTS` — rollout gate on the erasure draft-discard
 * cascade (auto-invoice #2).
 *
 * Why this gate exists at all: `eraseMember` is ALREADY production-live (COMP-1,
 * plus the `reconcile-erasures` cron re-drives it), so this cascade is reachable
 * without `FEATURE_AUTO_INVOICE` and would go live the instant the branch
 * merges — and its deletes are irreversible.
 *
 * Two properties are load-bearing and both are asserted here:
 *   1. OFF genuinely SKIPS — it must not reach `discardMemberDraftInvoices`.
 *      A gate that still runs the deletes and merely reports zero would be
 *      worthless, and nothing else in the suite would notice.
 *   2. OFF reports a clean `'ok'`, never `'failed'`. A disabled cascade is not
 *      a failed one: `'failed'` flips `allCascadesClean`, permanently withholds
 *      the `member_erased` completion proof, and leaves the US2d reconciler
 *      re-driving the same member forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const discardMock = vi.fn();
vi.mock('@/modules/invoicing', () => ({
  discardMemberDraftInvoices: (...args: unknown[]) => discardMock(...args),
  makeDeleteInvoiceDraftDeps: vi.fn(() => ({})),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: (_ctx: unknown, fn: (tx: never) => unknown) => fn({} as never),
}));

import {
  disabledInvoicingErasureAdapter,
  invoicingErasureAdapter,
} from '@/modules/members/infrastructure/adapters/invoicing-erasure-adapter';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { asMemberId } from '@/modules/members';
import { buildEraseDeps } from '../application/erase-member.fixtures';

const TENANT = { slug: 'test-tenant' } as never;
const MEMBER = 'm-1' as never;
const META = { actorUserId: 'u-1', requestId: 'req-1' };

beforeEach(() => {
  discardMock.mockReset();
});

describe('FEATURE_ERASURE_DISCARD_DRAFTS — OFF (default)', () => {
  it('skips the discard entirely and reports a CLEAN ok', async () => {
    const r = await disabledInvoicingErasureAdapter.discardDraftsForMember(
      TENANT,
      MEMBER,
      META,
    );

    // Property 1 — genuinely skipped, not "ran and returned zero".
    expect(discardMock).not.toHaveBeenCalled();
    // Property 2 — clean, so `allCascadesClean` survives and `member_erased`
    // is still emitted.
    expect(r).toEqual({ outcome: 'ok', discardedCount: 0 });
    expect(r.outcome).not.toBe('failed');
  });

  it('still lets eraseMember emit member_erased (no reconciler loop)', async () => {
    // The property that actually matters, asserted end-to-end rather than
    // inferred from the outcome string: with the cascade disabled the erasure
    // must still COMPLETE. If OFF flipped `allCascadesClean`, `member_erased`
    // would be withheld forever and the US2d reconciler would re-drive this
    // member on every sweep.
    const deps = buildEraseDeps();
    deps.invoicingErasure = disabledInvoicingErasureAdapter;

    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(true);
    const types = deps.audit.recordInTx.mock.calls.map(
      (c: unknown[]) => (c[2] as { type: string }).type,
    );
    expect(types).toContain('member_erased');
    expect(discardMock).not.toHaveBeenCalled();
  });
});

describe('FEATURE_ERASURE_DISCARD_DRAFTS — ON', () => {
  it('runs the discard and reports the count', async () => {
    discardMock.mockResolvedValueOnce({
      discardedCount: 3,
      skippedCount: 0,
      failedCount: 0,
    });

    const r = await invoicingErasureAdapter.discardDraftsForMember(
      TENANT,
      MEMBER,
      META,
    );

    expect(discardMock).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ outcome: 'ok', discardedCount: 3 });
  });

  it('maps a non-zero failedCount to a failed outcome', async () => {
    discardMock.mockResolvedValueOnce({
      discardedCount: 1,
      skippedCount: 0,
      failedCount: 2,
    });

    const r = await invoicingErasureAdapter.discardDraftsForMember(
      TENANT,
      MEMBER,
      META,
    );

    expect(r.outcome).toBe('failed');
  });
});
