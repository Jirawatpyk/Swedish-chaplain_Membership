/**
 * F4 `discardMemberDraftInvoices` — unit tests.
 *
 * Added by 107-auto-invoice flag-flip item 1 (whole-branch verdict §6.2): the
 * GDPR Art.17 / PDPA §33 erasure cascade must DISCARD a member's pending
 * `draft` invoices and RETAIN everything `issued` and beyond (Thai RD §87/3
 * legal-obligation carve-out, GDPR Art.17(3)(b)).
 *
 * The load-bearing contracts pinned here:
 *   - the candidate read is narrowed to `status='draft'` for THIS member and
 *     opts drafts in explicitly — an issued/paid document must never enter the
 *     work-list (the whole retention decision rides on this predicate);
 *   - every delete goes through F4's own `deleteInvoiceDraft`, whose SQL
 *     re-asserts `status='draft'`, so a row promoted between the scan and the
 *     delete is REPORTED, never silently counted as discarded;
 *   - `expectMayHaveVanished` is set (ids come from our own tenant-scoped
 *     scan), so losing that race does not pollute the `invoice_cross_tenant_probe`
 *     intrusion signal;
 *   - one row throwing does not abandon the rest of the work-list.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  discardMemberDraftInvoices,
  type DiscardMemberDraftInvoicesDeps,
} from '@/modules/invoicing/application/use-cases/discard-member-draft-invoices';

const TENANT = 'test-tenant';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const DRAFT_A = '11111111-1111-4111-8111-11111111111a';
const DRAFT_B = '11111111-1111-4111-8111-11111111111b';

type Page = {
  readonly rows: ReadonlyArray<{ invoiceId: string }>;
  readonly nextCursor: string | null;
};

function makeDeps(opts: {
  readonly pages: readonly Page[];
  /** Per-invoice-id status the guarded delete sees. Absent ⇒ 'draft'. */
  readonly statusById?: Readonly<Record<string, string>>;
  /** Invoice ids whose delete should throw (fault-isolation probe). */
  readonly throwOn?: readonly string[];
}): {
  readonly deps: DiscardMemberDraftInvoicesDeps;
  readonly list: ReturnType<typeof vi.fn>;
  readonly deleteDraft: ReturnType<typeof vi.fn>;
  readonly emit: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const list = vi.fn(async () => opts.pages[call++] ?? { rows: [], nextCursor: null });
  const deleteDraft = vi.fn(async (_tx: unknown, invoiceId: string) => {
    if (opts.throwOn?.includes(invoiceId)) throw new Error('boom');
    return (opts.statusById?.[invoiceId] ?? 'draft') === 'draft';
  });
  const emit = vi.fn(async () => undefined);
  const deps = {
    invoiceRepo: {
      list,
      withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      findByIdInTx: vi.fn(async (_tx: unknown, invoiceId: string) => ({
        status: opts.statusById?.[invoiceId] ?? 'draft',
      })),
      deleteDraft,
    },
    audit: { emit },
  } as unknown as DiscardMemberDraftInvoicesDeps;
  return { deps, list, deleteDraft, emit };
}

const input = {
  tenantId: TENANT,
  memberId: MEMBER_ID,
  actorUserId: 'user-1',
  requestId: 'req-1',
};

describe('discardMemberDraftInvoices', () => {
  it('narrows the candidate read to this member’s DRAFTS only', async () => {
    const { deps, list } = makeDeps({
      pages: [{ rows: [{ invoiceId: DRAFT_A }], nextCursor: null }],
    });

    await discardMemberDraftInvoices(deps, input);

    expect(list).toHaveBeenCalledTimes(1);
    // The retention decision (discard drafts, retain issued) rides entirely on
    // this predicate — pin all three parts.
    expect(list.mock.calls[0]?.[0]).toBe(TENANT);
    expect(list.mock.calls[0]?.[1]).toMatchObject({
      memberId: MEMBER_ID,
      status: 'draft',
      includeDrafts: true,
    });
  });

  it('discards every draft it finds and reports the count', async () => {
    const { deps, deleteDraft } = makeDeps({
      pages: [{ rows: [{ invoiceId: DRAFT_A }, { invoiceId: DRAFT_B }], nextCursor: null }],
    });

    const out = await discardMemberDraftInvoices(deps, input);

    expect(out.discardedCount).toBe(2);
    expect(out.skippedCount).toBe(0);
    expect(out.failedCount).toBe(0);
    expect(deleteDraft).toHaveBeenCalledTimes(2);
  });

  it('follows the cursor so drafts beyond the first page are not stranded', async () => {
    const { deps, deleteDraft } = makeDeps({
      pages: [
        { rows: [{ invoiceId: DRAFT_A }], nextCursor: `|${DRAFT_A}` },
        { rows: [{ invoiceId: DRAFT_B }], nextCursor: null },
      ],
    });

    const out = await discardMemberDraftInvoices(deps, input);

    expect(out.discardedCount).toBe(2);
    expect(deleteDraft).toHaveBeenCalledTimes(2);
  });

  it('counts a row promoted between scan and delete as SKIPPED, not discarded', async () => {
    // A concurrent issue won the race. F4's guarded DELETE matches 0 rows and
    // reports `not_draft`. The erasure must never report having discarded a
    // document that is now an issued §87-numbered tax record.
    const { deps } = makeDeps({
      pages: [{ rows: [{ invoiceId: DRAFT_A }, { invoiceId: DRAFT_B }], nextCursor: null }],
      statusById: { [DRAFT_B]: 'issued' },
    });

    const out = await discardMemberDraftInvoices(deps, input);

    expect(out.discardedCount).toBe(1);
    expect(out.skippedCount).toBe(1);
    expect(out.failedCount).toBe(0);
  });

  it('sets expectMayHaveVanished so the intrusion signal is not polluted', async () => {
    // The ids came from our OWN tenant-scoped scan above; losing the race to a
    // concurrent discard/prune is benign, NOT a cross-tenant probe.
    const { deps, emit } = makeDeps({
      pages: [{ rows: [{ invoiceId: DRAFT_A }], nextCursor: null }],
    });
    // Force the not-found arm inside deleteInvoiceDraft.
    (deps.invoiceRepo as unknown as { findByIdInTx: ReturnType<typeof vi.fn> }).findByIdInTx =
      vi.fn(async () => null);

    const out = await discardMemberDraftInvoices(deps, input);

    expect(out.skippedCount).toBe(1);
    expect(
      emit.mock.calls.some((c) => (c[1] as { eventType?: string })?.eventType === 'invoice_cross_tenant_probe'),
      'a self-inflicted scan race must not emit the cross-tenant intrusion event',
    ).toBe(false);
  });

  it('isolates a throwing row so the rest of the work-list still runs', async () => {
    const { deps, deleteDraft } = makeDeps({
      pages: [{ rows: [{ invoiceId: DRAFT_A }, { invoiceId: DRAFT_B }], nextCursor: null }],
      throwOn: [DRAFT_A],
    });

    const out = await discardMemberDraftInvoices(deps, input);

    expect(out.failedCount).toBe(1);
    expect(out.discardedCount).toBe(1);
    expect(deleteDraft).toHaveBeenCalledTimes(2);
  });

  it('is a clean no-op when the member has no drafts', async () => {
    const { deps, deleteDraft } = makeDeps({ pages: [{ rows: [], nextCursor: null }] });

    const out = await discardMemberDraftInvoices(deps, input);

    expect(out).toMatchObject({ discardedCount: 0, skippedCount: 0, failedCount: 0 });
    expect(deleteDraft).not.toHaveBeenCalled();
  });
});
