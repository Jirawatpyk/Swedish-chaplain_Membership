/**
 * F4 `deleteInvoiceDraft` — unit tests.
 *
 * Added by 107-auto-invoice Task 9 (review Minor 6): this use-case had NO
 * unit or contract coverage at all, which is how the unguarded-DELETE TOCTOU
 * (an unconditional `DELETE` that could destroy an *issued* tax document plus
 * its burned §87 sequence number) survived. These tests pin the contract that
 * fix depends on:
 *
 *   - the repo's status-guarded DELETE reporting `false` (a concurrent issue
 *     promoted the row between our read and the delete) MUST surface as
 *     `not_draft` — never a silent success reporting a delete that never
 *     happened;
 *   - the not-found `invoice_cross_tenant_probe` intrusion audit fires for an
 *     unknown id, but is SUPPRESSED for a caller that passed
 *     `expectMayHaveVanished` (Task 9's own-tenant sweep), so the alerting
 *     signal is not polluted with self-inflicted noise.
 */
import { describe, expect, it, vi } from 'vitest';
import { deleteInvoiceDraft } from '@/modules/invoicing/application/use-cases/delete-invoice-draft';
import type { DeleteInvoiceDraftDeps } from '@/modules/invoicing/application/use-cases/delete-invoice-draft';

const TENANT = 'test-tenant';
const INVOICE_ID = '11111111-1111-4111-8111-111111111111';

function makeDeps(overrides: {
  readonly row: { status: string } | null;
  readonly deleteResult?: boolean;
}): {
  readonly deps: DeleteInvoiceDraftDeps;
  readonly deleteDraft: ReturnType<typeof vi.fn>;
  readonly emit: ReturnType<typeof vi.fn>;
} {
  const deleteDraft = vi.fn(async () => overrides.deleteResult ?? true);
  const emit = vi.fn(async () => undefined);
  const deps = {
    invoiceRepo: {
      // The use-case runs everything inside `withTx`; a pass-through is enough
      // for the branch logic under test.
      withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      findByIdInTx: vi.fn(async () => overrides.row),
      deleteDraft,
    },
    audit: { emit },
  } as unknown as DeleteInvoiceDraftDeps;
  return { deps, deleteDraft, emit };
}

const input = {
  tenantId: TENANT,
  actorUserId: 'user-1',
  requestId: null,
  invoiceId: INVOICE_ID,
};

describe('deleteInvoiceDraft', () => {
  it('deletes a draft and emits invoice_draft_deleted', async () => {
    const { deps, deleteDraft, emit } = makeDeps({ row: { status: 'draft' } });

    const result = await deleteInvoiceDraft(deps, input);

    expect(result.ok).toBe(true);
    expect(deleteDraft).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      eventType: 'invoice_draft_deleted',
    });
  });

  it('refuses a non-draft row without touching the repo delete', async () => {
    const { deps, deleteDraft } = makeDeps({ row: { status: 'issued' } });

    const result = await deleteInvoiceDraft(deps, input);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_draft');
    expect(deleteDraft).not.toHaveBeenCalled();
  });

  it('maps a guarded-DELETE miss to not_draft (concurrent promotion race)', async () => {
    // The read saw `draft`, but by the time the status-guarded DELETE ran a
    // concurrent issue had promoted the row — 0 rows matched. This MUST NOT
    // report success: the caller would otherwise believe it deleted a row
    // that is now an issued tax document.
    const { deps, deleteDraft, emit } = makeDeps({
      row: { status: 'draft' },
      deleteResult: false,
    });

    const result = await deleteInvoiceDraft(deps, input);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_draft');
    expect(deleteDraft).toHaveBeenCalledTimes(1);
    // No success audit for a delete that did not happen.
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits invoice_cross_tenant_probe when the invoice is not found', async () => {
    const { deps, emit } = makeDeps({ row: null });

    const result = await deleteInvoiceDraft(deps, input);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invoice_not_found');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      eventType: 'invoice_cross_tenant_probe',
    });
  });

  it('SUPPRESSES the probe audit when the caller passed expectMayHaveVanished', async () => {
    // Task 9's sweep enumerates ids from its own tenant-scoped read, then
    // deletes them one by one; losing that race is benign. Emitting the
    // intrusion event here would flood an alerting signal with self-inflicted
    // noise and destroy its value.
    const { deps, emit } = makeDeps({ row: null });

    const result = await deleteInvoiceDraft(deps, {
      ...input,
      expectMayHaveVanished: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invoice_not_found');
    expect(emit).not.toHaveBeenCalled();
  });
});
