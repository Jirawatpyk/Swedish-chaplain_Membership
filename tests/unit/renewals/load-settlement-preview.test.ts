/**
 * 059-membership-suspension Task 9 — `loadSettlementPreview` unit test
 * (mocked repo).
 *
 * Backs the future bulk "Mark paid" confirm dialog (⑨): the use-case must
 * sum ONLY previewable (live-linked-invoice) rows into `totalThbMinor` —
 * a non-previewable row (no link yet, or a stale link pointing at an
 * already-paid/void/credited invoice) NEVER contributes money, so an
 * operator never sees an inflated bulk bank-transfer total.
 *
 * Real-DB coverage (the previewable JOIN gate itself, incl. the stale-link
 * guard) lives in the integration test; this test only proves the pure
 * summation + input-bounds guard against a mocked repo.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadSettlementPreview } from '@/modules/renewals';

function makeDeps(rows: unknown) {
  return {
    renewalCycleRepo: {
      loadSettlementPreview: vi.fn().mockResolvedValue(rows),
    },
  } as never;
}

describe('loadSettlementPreview', () => {
  it('sums only previewable (live-invoice) rows into total_thb_minor', async () => {
    const deps = makeDeps([
      { cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1', amountThbMinor: 1070_00, currency: 'THB', previewable: true },
      { cycleId: 'c2', companyName: 'Beta', invoiceId: null, amountThbMinor: null, currency: null, previewable: false },
    ]);
    const res = await loadSettlementPreview(deps, { tenantId: 't', cycleIds: ['c1', 'c2'] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.totalThbMinor).toBe(1070_00);
    expect(res.value.items).toHaveLength(2);
  });

  // Review round 1 fix B — pins the `previewable &&` guard in the reduce.
  // Every OTHER row in this file that is `previewable:false` also carries
  // `amountThbMinor:null`, so a mutant that deletes `r.previewable &&`
  // from the reduce would still pass every test above (the `!== null`
  // check alone would already exclude those rows). This row is NOT
  // previewable but DOES carry a real, non-null amount — only the
  // `previewable` guard itself can exclude it from the total.
  it('excludes a non-previewable row from the total even when it carries a non-null amount', async () => {
    const deps = makeDeps([
      { cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1', amountThbMinor: 1070_00, currency: 'THB', previewable: true },
      { cycleId: 'c3', companyName: 'Gamma', invoiceId: 'inv3', amountThbMinor: 99999, currency: 'THB', previewable: false },
    ]);
    const res = await loadSettlementPreview(deps, { tenantId: 't', cycleIds: ['c1', 'c3'] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.totalThbMinor).toBe(1070_00);
    expect(res.value.totalThbMinor).not.toBe(1070_00 + 99999);
    expect(res.value.items).toHaveLength(2);
  });

  it('rejects empty / oversized cycleIds with invalid_input', async () => {
    const deps = makeDeps([]);
    const empty = await loadSettlementPreview(deps, { tenantId: 't', cycleIds: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.kind).toBe('invalid_input');
    const over = await loadSettlementPreview(deps, { tenantId: 't', cycleIds: Array.from({ length: 101 }, (_, i) => `c${i}`) });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.kind).toBe('invalid_input');
  });

  // Review round 1 fix B — the accepted boundaries: 1 and 100 are the
  // edges of the ACCEPTED range (MAX_CYCLES = 100), the opposite edge from
  // the rejection test above (0 and 101).
  it('accepts the 1 and 100 cycleId boundaries', async () => {
    const one = await loadSettlementPreview(makeDeps([]), {
      tenantId: 't',
      cycleIds: ['c0'],
    });
    expect(one.ok).toBe(true);

    const oneHundred = await loadSettlementPreview(makeDeps([]), {
      tenantId: 't',
      cycleIds: Array.from({ length: 100 }, (_, i) => `c${i}`),
    });
    expect(oneHundred.ok).toBe(true);
  });
});
