/**
 * Spec 122 US4 (T404, `Portal-credit-note` board) — the member credit note
 * on AURA: "← Back to invoices" above the title, the number in mono, Download
 * PDF as the primary button, a Details card (issue date, original receipt,
 * then the credit / VAT / total list) and a Reason card. Figures and labels
 * are unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children?: unknown; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children as ReactElement}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Map()) }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => (key: string) => `${ns}.${key}`),
  getLocale: vi.fn().mockResolvedValue('en'),
}));
vi.mock('@/lib/auth-session', () => ({ requireSession: vi.fn().mockResolvedValue({ user: { id: 'u1' } }) }));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromRequest: () => ({ slug: 'tenant-a' }) }));
vi.mock('@/lib/request-id', () => ({ requestIdFromHeaders: () => null }));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: { findByLinkedUserId: async () => ({ ok: true, value: { memberId: 'm1' } }) },
  }),
}));
vi.mock('@/modules/invoicing', () => ({
  makeGetCreditNoteDeps: () => ({}),
  getCreditNote: async () => ({
    ok: true,
    value: {
      creditNoteId: 'cn-1',
      originalInvoiceId: 'inv-9',
      documentNumber: { raw: 'CN-2026-000014' },
      issueDate: '2026-09-23',
      originalDocuments: null,
      creditAmount: { satang: 1_000_000n },
      vat: { satang: 70_000n },
      total: { satang: 1_070_000n },
      reason: 'Charged the Premium rate.',
    },
  }),
}));
vi.mock('@/components/layout/plan-breadcrumb-label', () => ({ PlanBreadcrumbLabel: () => null }));
vi.mock('@/components/layout/page-header', () => ({
  PageHeader: ({ title, subtitle, actions }: { title?: unknown; subtitle?: unknown; actions?: unknown }) => (
    <header>
      <h1>{title as ReactElement}</h1>
      <p>{subtitle as ReactElement}</p>
      <div>{actions as ReactElement}</div>
    </header>
  ),
}));

import PortalCreditNoteDetailPage from '@/app/(member)/portal/credit-notes/[creditNoteId]/page';

async function renderPage(): Promise<string> {
  const tree = await PortalCreditNoteDetailPage({ params: Promise.resolve({ creditNoteId: 'cn-1' }) });
  return renderToStaticMarkup(tree as ReactElement);
}

describe('Portal credit note — AURA layout (spec 122 US4)', () => {
  it('opens with "Back to invoices" before the title, which sets the number in mono', async () => {
    const html = await renderPage();
    expect(html).toContain('href="/portal/invoices"');
    expect(html.indexOf('portal.invoices.detail.backToList')).toBeLessThan(html.indexOf('<h1>'));
    expect(html).toMatch(/<span class="font-mono">CN-2026-000014<\/span>/);
  });

  it('Download PDF is the primary AURA button', async () => {
    const html = await renderPage();
    expect(html).toMatch(/<a href="\/api\/portal\/credit-notes\/cn-1\/pdf"[^>]*class="aura-btn aura-btn--primary/);
  });

  it('a Details card with the facts and the unchanged totals, then a Reason card', async () => {
    const html = await renderPage();
    const cards = html.split('class="aura-card"');
    expect(cards).toHaveLength(3);
    expect(cards[1]).toContain('portal.invoices.detail.detailsHeading');
    for (const key of ['fields.issueDate', 'fields.originalReceipt', 'fields.creditAmount', 'fields.vat', 'fields.total']) {
      expect(cards[1]).toContain(`portal.creditNotes.detail.${key}`);
    }
    expect(cards[1]).toContain('10,000.00');
    expect(cards[1]).toContain('700.00');
    expect(cards[1]).toContain('10,700.00');
    expect(cards[2]).toContain('portal.creditNotes.detail.reason.heading');
    expect(cards[2]).toContain('Charged the Premium rate.');
  });
});
