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
  inferEventDocumentKind: (
    subject: 'membership' | 'event',
    taxId: string | null | undefined,
  ) => (subject === 'event' && (taxId ?? '').trim() === '' ? 'receipt_separate' : 'invoice'),
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

  it('legacy §86/4 tax invoice (event + TIN, documentNumber set) → renders the form', async () => {
    getInvoiceMock.mockResolvedValue({
      ok: true,
      value: invoice({
        invoiceSubject: 'event',
        memberIdentitySnapshot: { tax_id: '1234567890123' },
        documentNumber: { raw: 'IN-2026-0001' },
        receiptDocumentNumberRaw: null,
      }),
    });
    const html = await renderPage();
    expect(html).toContain('cn-form');
    expect(html).toContain('IN-2026-0001');
  });
});
