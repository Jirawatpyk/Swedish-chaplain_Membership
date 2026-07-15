/**
 * 088 FIX 5 (regression) — /admin/invoices/[invoiceId]/credit-notes/new
 * page-level fail-fast guard for §105 `receipt_separate` receipts.
 *
 * The page's creditability guard was `!invoice.total ||
 * !displayDocumentNumber(invoice)`. After 088 widened `displayDocumentNumber`
 * to fall back to `receiptDocumentNumberRaw`, a β no-TIN §105 `receipt_separate`
 * row (documentNumber NULL, receiptDocumentNumberRaw set) now PASSES that guard
 * and renders the form — but `issueCreditNote` rejects it with
 * `receipt_not_creditable` (§86/10: a §105 receipt has no input VAT to reverse),
 * producing a dead-end form. Pre-088 the `!invoice.documentNumber` guard 404'd
 * it.
 *
 * This suite pins the fix: the page mirrors `issueCreditNote`'s legal gate
 * (`inferEventDocumentKind(subject, buyerTin) === 'receipt_separate'`) BEFORE
 * the total/display-number guard, so a §105 receipt 404s at the page (fail-fast)
 * while a paid 088 bill and a legacy §86/4 tax invoice still render.
 *
 * The async RSC default export is invoked directly with mocked boundaries; the
 * `notFound()` mock throws a `NEXT_NOT_FOUND` sentinel (matching Next's real
 * control-flow throw) so a fail-fast path surfaces as a rejected promise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

// --- mocks ----------------------------------------------------------------

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));

vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({ user: { role: 'admin' } }),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromHeaders: () => ({ slug: 'tenant-a' }),
}));

const getInvoiceMock = vi.fn();
vi.mock('@/modules/invoicing', () => ({
  getInvoice: (...args: unknown[]) => getInvoiceMock(...args),
  makeGetInvoiceDeps: () => ({}),
  // Faithful reimplementations of the two pure Domain helpers the page reads
  // (the barrel pulls in Drizzle infra factories, so it is fully replaced — the
  // real helpers are unit-tested in their own suites). Behaviour is byte-
  // identical to `src/modules/invoicing/domain/{invoice,document-kind}.ts`.
  displayDocumentNumber: (inv: {
    documentNumber?: { raw: string } | null;
    receiptDocumentNumberRaw?: string | null;
  }) => inv.documentNumber?.raw ?? inv.receiptDocumentNumberRaw ?? undefined,
  // 059 / PR-A Task 6a — re-keyed onto the buyer's VAT-REGISTRANT status. These
  // two mirror `src/modules/invoicing/domain/document-kind.ts` exactly (matched
  // member → the RECORDED flag; walk-in → TIN presence, unchanged).
  inferEventDocumentKind: (
    subject: 'membership' | 'event',
    buyerIsVatRegistrant: boolean,
  ) => (subject === 'event' && !buyerIsVatRegistrant ? 'receipt_separate' : 'invoice'),
  resolveBuyerIsVatRegistrant: (
    memberId: string | null,
    buyer: { tax_id?: string | null; buyer_is_vat_registrant?: boolean } | null | undefined,
  ) => {
    if (!buyer) return false;
    if (memberId === null) return (buyer.tax_id ?? '').trim() !== '';
    return buyer.buyer_is_vat_registrant === true;
  },
}));

// Presentation stubs — the guard runs before render; the form marker echoes the
// resolved documentNumber so the render-path cases can assert the page reached
// the form (not a fail-fast 404).
vi.mock('@/components/layout', () => ({
  FormContainer: ({ children }: { children?: unknown }) => children as ReactElement,
}));
vi.mock('@/components/layout/page-header', () => ({
  PageHeader: () => null,
}));
vi.mock('@/components/ui/card', () => ({
  Card: ({ children }: { children?: unknown }) => children as ReactElement,
  CardContent: ({ children }: { children?: unknown }) => children as ReactElement,
}));
vi.mock(
  '@/app/(staff)/admin/invoices/[invoiceId]/credit-notes/new/_components/credit-note-form',
  () => ({
    CreditNoteForm: ({ documentNumber }: { documentNumber: string }) => (
      <div data-testid="cn-form" data-doc={documentNumber} />
    ),
  }),
);
vi.mock('next/link', () => ({
  default: ({ children }: { children?: unknown }) => children as ReactElement,
}));
vi.mock('lucide-react', () => ({ ArrowLeftIcon: () => null }));

import NewCreditNotePage from '@/app/(staff)/admin/invoices/[invoiceId]/credit-notes/new/page';

function bigMoney(satang: bigint) {
  return { satang };
}

/** Minimal structural stand-in for the loaded `Invoice` the page reads. */
function invoice(overrides: Record<string, unknown>) {
  return {
    status: 'paid',
    total: bigMoney(100_000n),
    creditedTotal: bigMoney(0n),
    documentNumber: null,
    receiptDocumentNumberRaw: null,
    billDocumentNumberRaw: null,
    invoiceSubject: 'membership',
    // 059 / PR-A Task 6a — `memberId` now DISCRIMINATES the buyer shape (matched
    // member → the recorded registrant flag; walk-in → TIN presence), so it must
    // be present on the fixture. `null` = the walk-in / non-member default.
    memberId: null,
    memberIdentitySnapshot: { tax_id: null },
    ...overrides,
  };
}

async function renderPage(): Promise<string> {
  const tree = await NewCreditNotePage({ params: Promise.resolve({ invoiceId: 'inv-1' }) });
  return renderToStaticMarkup(tree as ReactElement);
}

beforeEach(() => {
  getInvoiceMock.mockReset();
});

describe('NewCreditNotePage — §105 receipt_separate fail-fast guard (088 FIX 5)', () => {
  it('paid §105 receipt_separate β row (event + no TIN) → notFound() (dead-end form averted)', async () => {
    getInvoiceMock.mockResolvedValue({
      ok: true,
      value: invoice({
        invoiceSubject: 'event',
        memberIdentitySnapshot: { tax_id: null },
        documentNumber: null,
        receiptDocumentNumberRaw: 'RE-2026-000001',
      }),
    });
    // The page must 404 BEFORE rendering the form — issueCreditNote would only
    // reject this row with `receipt_not_creditable`.
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('paid 088 membership bill (documentNumber NULL, RC set) → renders the form', async () => {
    getInvoiceMock.mockResolvedValue({
      ok: true,
      value: invoice({
        invoiceSubject: 'membership',
        documentNumber: null,
        billDocumentNumberRaw: 'SC-2026-000009',
        receiptDocumentNumberRaw: 'RC-2026-000009',
      }),
    });
    const html = await renderPage();
    expect(html).toContain('cn-form');
    // displayDocumentNumber falls back to the RC for the "against invoice {n}" label.
    expect(html).toContain('RC-2026-000009');
  });

  it('legacy §86/4 tax invoice (WALK-IN event + 13-digit TIN, documentNumber set) → renders the form', async () => {
    // A walk-in (memberId null) still keys on TIN presence — unchanged by the
    // 6a re-key, so this §86/4 stays creditable.
    getInvoiceMock.mockResolvedValue({
      ok: true,
      value: invoice({
        invoiceSubject: 'event',
        memberId: null,
        memberIdentitySnapshot: { tax_id: '1234567890123' },
        documentNumber: { raw: 'IN-2026-0001' },
        receiptDocumentNumberRaw: null,
      }),
    });
    const html = await renderPage();
    expect(html).toContain('cn-form');
    expect(html).toContain('IN-2026-0001');
  });

  it('059: MATCHED-MEMBER event, NON-registrant holding a passport → notFound() (the §105 receipt is not creditable)', async () => {
    // Their document is a §105 ใบเสร็จรับเงิน (no input VAT to reverse), so a
    // §86/10 ใบลดหนี้ against it is legally void. Under the old TIN-keyed gate the
    // non-blank passport made this page render a form that the use-case would then
    // always reject with `receipt_not_creditable`. The page must now 404 fail-fast,
    // in lockstep with the re-keyed use-case gate.
    getInvoiceMock.mockResolvedValue({
      ok: true,
      value: invoice({
        invoiceSubject: 'event',
        memberId: 'member-77',
        memberIdentitySnapshot: {
          tax_id: 'AA1234567',
          buyer_is_vat_registrant: false,
        },
        documentNumber: null,
        receiptDocumentNumberRaw: 'RE-2026-000007',
      }),
    });
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('059: MATCHED-MEMBER event, RECORDED registrant → renders the form (§86/4 is creditable)', async () => {
    getInvoiceMock.mockResolvedValue({
      ok: true,
      value: invoice({
        invoiceSubject: 'event',
        memberId: 'member-77',
        memberIdentitySnapshot: {
          tax_id: '1234567890123',
          buyer_is_vat_registrant: true,
        },
        documentNumber: { raw: 'IN-2026-0002' },
        receiptDocumentNumberRaw: null,
      }),
    });
    const html = await renderPage();
    expect(html).toContain('cn-form');
    expect(html).toContain('IN-2026-0002');
  });
});
