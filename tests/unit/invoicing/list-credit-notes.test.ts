/**
 * `listCreditNotes` — the admin credit-note list surfaces the ORIGINAL RECEIPT
 * (RC-, or a legacy INV-) and the related bill, and marks refund-origin notes.
 */
import { describe, expect, it, vi } from 'vitest';
import { listCreditNotes, type ListCreditNotesDeps } from '@/modules/invoicing/application/use-cases/list-credit-notes';
import { asSatang } from '@/lib/money';

type RepoRow = Awaited<
  ReturnType<ListCreditNotesDeps['creditNoteRepo']['listPaged']>
>['rows'][number];

function repoRow(overrides: Partial<RepoRow>): RepoRow {
  return {
    creditNoteId: 'cn-1',
    documentNumberRaw: 'CN-2026-000014',
    issueDate: '2026-09-23',
    originalInvoiceId: 'inv-1',
    originalReceiptDocumentNumberRaw: 'RC-2026-000038',
    originalDocumentNumberRaw: null,
    originalBillDocumentNumberRaw: 'SC-2026-000102',
    sourceRefundId: null,
    memberLegalName: 'Siam Nordic Trading Co., Ltd.',
    totalSatang: asSatang(1_070_000n),
    reason: 'difference credited',
    ...overrides,
  };
}

describe('listCreditNotes', () => {
  it('maps each row to its original receipt, related document and refund flag', async () => {
    const deps: ListCreditNotesDeps = {
      creditNoteRepo: {
        listPaged: vi.fn(async () => ({
          rows: [
            repoRow({}),
            repoRow({
              creditNoteId: 'cn-2',
              originalReceiptDocumentNumberRaw: null,
              originalDocumentNumberRaw: 'INV-2026-000052',
              originalBillDocumentNumberRaw: null,
              sourceRefundId: 'refund-1',
            }),
          ],
          total: 2,
        })),
      },
    };
    const result = await listCreditNotes(deps, { tenantId: 't', offset: 0, pageSize: 25 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [bill, legacy] = result.value.rows;
    expect(bill?.original).toEqual({
      receiptNumberRaw: 'RC-2026-000038',
      related: { kind: 'bill', numberRaw: 'SC-2026-000102' },
    });
    expect(bill?.isRefund).toBe(false);
    expect(legacy?.original).toEqual({
      receiptNumberRaw: 'INV-2026-000052',
      related: { kind: 'combined' },
    });
    expect(legacy?.isRefund).toBe(true);
    expect(bill?.totalSatang).toBe('1070000');
  });
});
