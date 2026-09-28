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
  getTranslations: vi.fn().mockImplementation(async (ns: string) => {
    const t = (key: string, vals?: Record<string, string>) =>
      `${ns}.${key}${vals ? `:${Object.values(vals).join('|')}` : ''}`;
    t.rich = (key: string, tags: { link: (c: string) => ReactElement }) => (
      <>
        {`${ns}.${key}`}
        {tags.link('link-text')}
      </>
    );
    return t;
  }),
  getLocale: vi.fn().mockResolvedValue('en'),
}));
vi.mock('@/lib/env', () => ({ env: { billingContactEmails: ['billing@chamber.example', 'second@chamber.example'] } }));
vi.mock('@/lib/auth-session', () => ({ requireSession: vi.fn().mockResolvedValue({ user: { id: 'u1' } }) }));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromRequest: () => ({ slug: 'tenant-a' }) }));
vi.mock('@/lib/request-id', () => ({ requestIdFromHeaders: () => null }));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: { findByLinkedUserId: async () => ({ ok: true, value: { memberId: 'm1' } }) },
  }),
}));
let originalDocuments: unknown = null;
vi.mock('@/modules/invoicing', () => ({
  makeGetCreditNoteDeps: () => ({}),
  getCreditNote: async () => ({
    ok: true,
    value: {
      creditNoteId: 'cn-1',
      originalInvoiceId: 'inv-9',
      documentNumber: { raw: 'CN-2026-000014' },
      issueDate: '2026-09-23',
      originalDocuments,
      creditAmount: { satang: 1_000_000n },
      vat: { satang: 70_000n },
      total: { satang: 1_070_000n },
      reason: 'Charged the Premium rate.',
    },
  }),
}));
vi.mock('@/components/layout/plan-breadcrumb-label', () => ({ PlanBreadcrumbLabel: () => null }));
vi.mock('@/components/invoices/credit-note-original-receipt', () => ({ CreditNoteOriginalReceipt: () => null }));
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

  it('the title reads "Credit note" before the mono number (`Portal-credit-note` board)', async () => {
    const html = await renderPage();
    expect(html).toMatch(/<h1>portal\.creditNotes\.detail\.title <span class="font-mono">CN-2026-000014<\/span><\/h1>/);
  });

  it('with an original receipt, a notice states that receipt is reduced by the credit note total', async () => {
    originalDocuments = { receiptNumberRaw: 'RC-2026-000038', related: null };
    try {
      const html = await renderPage();
      expect(html).toMatch(/data-testid="portal-credit-note-reduces"/);
      expect(html).toContain('portal.creditNotes.detail.reducesTitle:RC-2026-000038|10,700.00 THB');
      expect(html.indexOf('portal-credit-note-reduces')).toBeLessThan(html.indexOf('class="aura-card"'));
    } finally {
      originalDocuments = null;
    }
  });

  it('without one, there is no notice', async () => {
    expect(await renderPage()).not.toContain('portal-credit-note-reduces');
  });

  it('ends with the contact line, a mailto link to the first billing contact', async () => {
    const html = await renderPage();
    expect(html).toMatch(/data-testid="portal-credit-note-contact"/);
    expect(html).toContain('href="mailto:billing@chamber.example?subject=CN-2026-000014"');
    expect(html.lastIndexOf('portal-credit-note-contact')).toBeGreaterThan(html.lastIndexOf('reason.heading'));
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
