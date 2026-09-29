/**
 * 122 US5b-1 (T553) — the member detail page body as its board draws it
 * (`Admin-member-detail`), in one view function the page and the no-DB
 * preview route both render.
 *
 * - The header: the status, the member number and the auto-invoice badge
 *   above the company name; the plan and year below it.
 * - The header actions per role and state, as before: Benefits (F9), Erase,
 *   Archive and Edit for a writer; Archive and Edit hidden once archived;
 *   everything but Benefits hidden once erased or for a read-only viewer.
 * - The sticky "On this page" links name only the sections this viewer has,
 *   and every link lands on a section with that id.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createFormatter, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import type { Contact, Member } from '@/modules/members';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
  getLocale: async () => 'en',
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Bangkok' }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/members/m-1',
  useSearchParams: () => new URLSearchParams(),
}));
// The dialogs are their own tasks (T554 / T555); here only their triggers matter.
vi.mock('@/components/members/erase-member-button', () => ({
  EraseMemberButton: () => <button type="button">Erase (GDPR/PDPA)…</button>,
}));
vi.mock('@/components/members/archive-member-button', () => ({
  ArchiveMemberButton: () => <button type="button">Archive member</button>,
}));
vi.mock('@/components/members/contact-form-dialog', () => ({ ContactFormDialog: () => null }));
vi.mock('@/app/(staff)/admin/members/[memberId]/_components/add-contact-button', () => ({ AddContactButton: () => null }));
vi.mock('@/components/members/contact-actions', () => ({ ContactActions: () => null }));
vi.mock('@/components/members/marketing-switch', () => ({ MarketingSwitch: () => null }));
vi.mock('@/components/members/archived-banner', () => ({ ArchivedBanner: () => <div>archived-banner</div> }));
vi.mock('@/components/members/erased-banner', () => ({ ErasedBanner: () => <div>erased-banner</div> }));
vi.mock('@/components/members/no-primary-contact-banner', () => ({ NoPrimaryContactBanner: () => null }));

const { renderMemberDetailView } = await import(
  '@/app/(staff)/admin/members/[memberId]/_components/member-detail-view'
);

const L = enMessages.admin.members.detail.sectionLinks;

const member = {
  memberId: 'm-1',
  companyName: 'Siam Nordic Trading Co., Ltd.',
  status: 'active',
  planId: 'premium-corporate',
  planYear: 2026,
  memberNumber: 3,
  country: 'TH',
  legalEntityType: 'Company Limited',
  taxId: '0105561234567',
  website: 'https://siamnordic.example',
  foundedYear: 2008,
  turnoverThb: null,
  registeredCapitalThb: null,
  registrationDate: new Date('2021-03-01T00:00:00Z'),
  registrationFeePaid: true,
  lastActivityAt: new Date('2026-09-22T09:00:00Z'),
  archivedAt: null,
  autoInvoiceEnrolledAt: new Date('2026-01-10T00:00:00Z'),
  addressLine1: '99 Sukhumvit Rd',
  addressLine2: null,
  subDistrict: null,
  city: 'Khlong Toei',
  province: 'Bangkok',
  postalCode: '10110',
  billingAddressLine1: null,
  description: null,
  notes: null,
} as unknown as Member;

const contact = {
  contactId: 'c-1',
  firstName: 'Erik',
  lastName: 'Johansson',
  email: 'erik@siamnordic.example',
  phone: '+66 81 234 5678',
  roleTitle: 'Managing Director',
  preferredLanguage: 'en',
  isPrimary: true,
  linkedUserId: 'u-1',
  inviteBouncedAt: null,
  removedAt: null,
  marketing: { optedOut: false },
} as unknown as Contact;

type Props = Parameters<typeof renderMemberDetailView>[0];

const base: Props = {
  member,
  contacts: [contact],
  planDisplayName: 'Premium Corporate',
  memberNumberDisplay: 'TSCC-0003',
  legalEntityLabel: 'Company Limited',
  websiteHref: 'https://siamnordic.example',
  windowStatus: null,
  erasure: { erasedAt: null, completed: false },
  moneyEmailUndeliverable: false,
  pendingInvitations: new Map(),
  marketingStates: new Map([['c-1', 'on']]),
  verificationPending: new Set(),
  can: { write: true, marketing: false },
  features: { f9Dashboard: true, f7Broadcasts: false },
  locale: 'en',
  slots: {
    strip: <div data-testid="strip" />,
    renewal: <div data-testid="renewal" />,
    benefits: <div data-testid="benefits" />,
    invoices: <div data-testid="invoices" />,
    timeline: <div data-testid="timeline" />,
    changeRequests: <div data-testid="change-requests" />,
    pendingChangeRequest: <div data-testid="pending-change-request" />,
    dataExport: <div data-testid="data-export" />,
  },
};

async function renderView(over: Partial<Props> = {}) {
  const tree = await renderMemberDetailView({ ...base, ...over });
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      {tree as ReactElement}
    </NextIntlClientProvider>,
  );
}

describe('renderMemberDetailView — header (T553)', () => {
  it('puts the status, the member number and the auto-invoice badge above the company name', async () => {
    await renderView();
    const h1 = screen.getByRole('heading', { level: 1, name: member.companyName });
    const header = h1.closest('header')!;
    const eyebrow = header.querySelector('[data-slot="page-header-eyebrow"]')!;
    expect(eyebrow).toHaveTextContent('Active');
    expect(eyebrow).toHaveTextContent('TSCC-0003');
    expect(eyebrow).toHaveTextContent(enMessages.admin.members.detail.autoInvoiceEnrolledBadge);
    // above: the eyebrow precedes the heading in the document
    expect(eyebrow.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(header).toHaveTextContent('Premium Corporate');
  });

  it('a writer gets Benefits, Erase, Archive and Edit, in that order', async () => {
    await renderView();
    const header = screen.getByRole('heading', { level: 1 }).closest('header')!;
    const actions = [...header.querySelectorAll('a, button')];
    expect(actions.map((a) => a.textContent?.trim())).toEqual([
      enMessages.admin.members.detail.sections.benefits,
      'Erase (GDPR/PDPA)…',
      'Archive member',
      enMessages.admin.members.detail.editCta,
    ]);
  });

  it('an archived member keeps Erase but loses Archive and Edit', async () => {
    await renderView({ member: { ...member, status: 'archived' } as Member });
    const header = screen.getByRole('heading', { level: 1 }).closest('header')!;
    expect(within(header).getByText('Erase (GDPR/PDPA)…')).toBeInTheDocument();
    expect(within(header).queryByText('Archive member')).toBeNull();
    expect(within(header).queryByRole('link', { name: enMessages.admin.members.detail.editCta })).toBeNull();
  });

  it('an erased member, or a read-only viewer, gets Benefits only', async () => {
    await renderView({ erasure: { erasedAt: new Date('2026-09-01T00:00:00Z'), completed: true } });
    let header = screen.getByRole('heading', { level: 1 }).closest('header')!;
    expect(within(header).queryByText('Erase (GDPR/PDPA)…')).toBeNull();
    expect(within(header).queryByText('Archive member')).toBeNull();
    document.body.innerHTML = '';
    await renderView({ can: { write: false, marketing: false } });
    header = screen.getByRole('heading', { level: 1 }).closest('header')!;
    expect(within(header).getAllByRole('link').map((a) => a.textContent?.trim())).toEqual([
      enMessages.admin.members.detail.sections.benefits,
    ]);
  });
});

describe('renderMemberDetailView — sections and "On this page" (T553)', () => {
  it('links every section the viewer has, each to a section with that id', async () => {
    const { container } = await renderView();
    const nav = screen.getByRole('navigation', { name: L.label });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent?.trim())).toEqual([
      L.overview,
      L.contacts,
      L.invoices,
      L.changeRequests,
      L.timeline,
      L.dataExport,
    ]);
    for (const a of links) {
      const id = a.getAttribute('href')!.replace(/^#/, '');
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it('leaves out the links of sections this viewer does not get', async () => {
    await renderView({ slots: { ...base.slots, invoices: null, changeRequests: null, dataExport: null } });
    const nav = screen.getByRole('navigation', { name: L.label });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent?.trim())).toEqual([
      L.overview,
      L.contacts,
      L.timeline,
    ]);
  });

  it('renders the strip above the links, and the sections in the board order', async () => {
    const { container } = await renderView();
    const order = ['strip', 'renewal', 'benefits', 'invoices', 'change-requests', 'timeline', 'data-export'];
    const nodes = order.map((id) => container.querySelector(`[data-testid="${id}"]`)!);
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const nav = screen.getByRole('navigation', { name: L.label });
    expect(nodes[0]!.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the company card and the contacts card are real sections named by their headings', async () => {
    await renderView();
    expect(screen.getByRole('region', { name: enMessages.admin.members.detail.sections.company })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: enMessages.admin.members.detail.sections.contacts })).toBeInTheDocument();
  });

  // UX review M9 (the mobile board): a request awaiting review is flagged
  // above the figures, not only in the history far down the page.
  it('puts the pending change-request alert above the strip', async () => {
    await renderView();
    const alert = screen.getByTestId('pending-change-request');
    const strip = screen.getByTestId('strip');
    expect(alert.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // UX review (board): Organisation and Membership are h3 under the company
  // card's h2, so heading navigation reaches them.
  it('the company card groups are h3 headings', async () => {
    await renderView();
    const D = enMessages.admin.members.detail;
    expect(screen.getByRole('heading', { level: 3, name: D.sections.organisation })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: D.sections.membership })).toBeInTheDocument();
  });

  // Board `Admin-member-detail`: the labels already say "(THB)", so the
  // figures carry no currency; the website shows its host.
  it('turnover and capital read as plain figures; the website as its host', async () => {
    await renderView({ member: { ...member, turnoverThb: 184000000, registeredCapitalThb: 20000000 } });
    const company = screen.getByRole('region', { name: enMessages.admin.members.detail.sections.company });
    expect(company).toHaveTextContent('184,000,000');
    expect(company).not.toHaveTextContent(/THB\s?184|฿184/);
    expect(screen.getByRole('link', { name: /^siamnordic\.example/ })).toHaveAttribute('href', 'https://siamnordic.example');
  });

  // Board `Admin-member-detail`: Address and "Billing address (tax
  // documents)" are groups of their own; an unset billing address reads "—".
  it('shows the billing address group with a dash when none is set', async () => {
    await renderView();
    const D = enMessages.admin.members.detail;
    const heading = screen.getByRole('heading', { level: 3, name: D.fields.billingAddress });
    expect(heading.parentElement).toHaveTextContent('—');
    expect(screen.getByRole('heading', { level: 3, name: D.fields.address })).toBeInTheDocument();
  });

  // UX review M6 (2.5.3 Label in Name): the link's name starts with the
  // address it shows; "opens in a new tab" follows for screen readers.
  it('the website link is named by the address it shows', async () => {
    await renderView();
    const link = screen.getByRole('link', { name: /^siamnordic\.example/ });
    expect(link).toHaveAttribute('href', 'https://siamnordic.example');
    expect(link).toHaveAccessibleName(expect.stringContaining(enMessages.admin.members.detail.fields.websiteExternal));
  });
});
