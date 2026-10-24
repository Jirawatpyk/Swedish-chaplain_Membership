/**
 * 057 G4 — PortalProfileBody RSC unit test.
 *
 * Invokes the async RSC body directly (no live session) with mocked deps and
 * inspects the returned element tree. Pattern mirrors
 * members-page-sort-wiring.test.tsx (JSON-stringify the tree + walk children).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

// --- Boundary mocks ---------------------------------------------------------

// Prevent db.ts from crashing on env.database.url (no live Neon in unit tests).
vi.mock('@/lib/db', () => ({
  db: {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runInTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<any>) =>
    fn({} as unknown),
}));

// F114 (PR-1): the profile page imports `@/lib/logger` at module scope for the
// decision-banner read; pino would read `env.log.level` from the partial env
// mock below and crash the import.
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// …and `@/lib/members-change-request-deps` (for `asMembersUserId`), whose
// module graph boots the Upstash client via `@/lib/auth-deps` at import.
vi.mock('@/lib/members-change-request-deps', () => ({
  asMembersUserId: (id: string) => id,
  buildChangeRequestDeps: () => ({ changeRequestRepo: {} }),
}));
const listPortalChangeRequestsMock = vi.fn();

const findByLinkedUserIdMock = vi.fn();
const getMemberMock = vi.fn();
const getPlanMock = vi.fn();
const resolveMemberNumberPrefixMock = vi.fn();

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: {
      findByLinkedUserId: (...args: unknown[]) =>
        findByLinkedUserIdMock(...args),
    },
    contactRepo: {},
    audit: {},
    memberSettings: {},
    plans: { getPlan: (...args: unknown[]) => getPlanMock(...args) },
    // F114: the tenant takes changes directly, so no pending/decided banner read.
    memberChangeGate: { resolve: async () => 'direct' },
  }),
}));

vi.mock('@/modules/members', () => ({
  getMember: (...args: unknown[]) => getMemberMock(...args),
  formatMemberNumber: (prefix: string, n: number) =>
    `${prefix}-${String(n).padStart(4, '0')}`,
  resolveMemberNumberPrefix: (...args: unknown[]) =>
    resolveMemberNumberPrefixMock(...args),
  // 108 PR-D — the page derives the OWN contact's marketing state.
  deriveMarketingState: () => 'on',
  // #239 — the profile's recent change requests (the history page's use case).
  listPortalChangeRequests: (...args: unknown[]) => listPortalChangeRequestsMock(...args),
}));
// 108 PR-D — the suppression lookup composes the broadcasts barrel (whose
// logger reads env.log); stub it so this page-boundary test stays DB- and
// env-free. The toggle is a client component — stubbed like the other children.
vi.mock('@/lib/contact-marketing-deps', () => ({
  makeMarketingSuppressionLookup: () => ({ isSuppressed: async () => false }),
}));
vi.mock('@/components/members/portal-marketing-toggle', () => ({
  PortalMarketingToggle: ({ state }: { state: string }) => (
    <div data-testid="portal-marketing" data-marketing-state={state} />
  ),
}));

vi.mock('@/lib/env', () => ({
  env: { features: { f9Dashboard: false, memberChangeApproval: false } },
}));

// next-intl server: identity translator (returns the key) + fixed locale.
// 059 / PR-A Task 3b — the identity translator ALSO needs a `.has()` method:
// `resolveLegalEntityTypeLabel` (portal profile page) calls
// `tTypes.has(key)` before resolving a legal_entity_type label. Always
// `false` here so the resolver falls back to the RAW stored value — the
// same behaviour this file's fixtures already relied on before this
// resolver was wired in (member.legalEntityType = 'limited', which is not
// one of the 12 catalogue codes anyway).
const localeRef = { current: 'en' };
function identityTranslator(k: string): string {
  return k;
}
identityTranslator.has = () => false;
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue(identityTranslator),
  getLocale: vi.fn().mockImplementation(async () => localeRef.current),
}));

// next-intl client hooks used by CountryDisplay + CopyButton (rendered to markup).
vi.mock('next-intl', () => ({
  useLocale: () => localeRef.current,
  useTranslations: () => (k: string) => k,
}));

const now = new Date('2026-04-16T10:00:00Z');

const member = {
  memberId: 'mem-a',
  companyName: 'Alpha Corp',
  legalEntityType: 'limited',
  country: 'TH',
  // 067 I5(c) — the member's own tax_id is surfaced on the profile (the §86/4
  // buyer TIN they can verify). A real value so the rendered cell is asserted.
  taxId: '0105558012345',
  website: null,
  description: null,
  foundedYear: 2010,
  // 069 — address parts surfaced read-only on the portal (the §86/4 buyer
  // address the member can verify). Composed sub-district → city → province →
  // postcode after the two street lines.
  addressLine1: '123 Sukhumvit Rd',
  addressLine2: null,
  subDistrict: 'Khlong Toei',
  city: 'Khlong Toei',
  province: 'Bangkok',
  postalCode: '10110',
  memberNumber: 42,
  planId: 'corporate',
  planYear: 2026,
  registrationDate: now,
  lastActivityAt: null,
  status: 'active' as const,
};

const ownContact = {
  contactId: 'con-a',
  firstName: 'Test',
  lastName: 'User',
  email: 'member@a.example',
  phone: null,
  roleTitle: null,
  isPrimary: true,
  linkedUserId: 'user-a',
  removedAt: null,
};

import { PortalProfileBody } from '@/app/(member)/portal/profile/page';

beforeEach(() => {
  vi.clearAllMocks();
  localeRef.current = 'en';
  findByLinkedUserIdMock.mockResolvedValue({ ok: true, value: member });
  getMemberMock.mockResolvedValue({
    ok: true,
    value: { member, contacts: [ownContact] },
  });
  getPlanMock.mockResolvedValue({
    ok: true,
    value: { planNameEn: 'Corporate' },
  });
  resolveMemberNumberPrefixMock.mockResolvedValue('SCCM');
});

describe('PortalProfileBody — heading order + DetailField + dates (057 G4)', () => {
  it('renders section titles as real <h2>, never CardTitle (a11y-6)', async () => {
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const html = renderToStaticMarkup(tree as ReactElement);
    // Three section <h2>s: Organisation, Membership, Contacts (F9 dir off).
    const h2Count = (html.match(/<h2/g) ?? []).length;
    expect(h2Count).toBe(3);
    // The section-title keys render inside <h2>, proving they are NOT divs.
    expect(html).toContain('organisationSection');
    expect(html).toContain('membershipSection');
    expect(html).toContain('contactsSection');
    // No <h3> in this tree — no h2→h(skip) and no admin h1→h3 pattern.
    expect(html).not.toContain('<h3');
  });

  it('draws each section as an AURA card labelled by its h2, with a status pill and AURA badges (spec 122 US3)', async () => {
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const el = document.createElement('div');
    el.innerHTML = renderToStaticMarkup(tree as ReactElement);
    for (const id of ['portal-profile-org-heading', 'portal-profile-membership-heading', 'portal-profile-contacts-heading']) {
      const card = el.querySelector(`section[aria-labelledby="${id}"]`);
      expect(card).toHaveClass('aura-card');
      expect(card?.querySelector(`h2#${id}`)).toHaveClass('aura-card__title');
    }
    const pill = [...el.querySelectorAll('.aura-pill')].find((n) => n.textContent === 'statusBadge.active');
    expect(pill).toHaveClass('aura-pill--ready');
    expect(el.querySelector('.aura-badge.is-outline.font-mono')?.textContent).toBe('SCCM-0042');
    const edit = el.querySelector('a[href="/portal/edit"]');
    expect(edit).toHaveClass('aura-btn', 'aura-btn--primary');
  });

  it('uses DetailField label keys for organisation rows', async () => {
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).toContain('fields.memberNumber');
    expect(html).toContain('fields.companyName');
    expect(html).toContain('fields.planName');
    // DetailField renders a <dt>/<dd> pair (its signature contract).
    expect(html).toContain('<dt');
    expect(html).toContain('<dd');
    // The formatted member number flows through formatMemberNumber.
    expect(html).toContain('SCCM-0042');
  });

  it('renders the status badge label via statusBadge.<status>', async () => {
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).toContain('statusBadge.active');
  });

  it('renders registration date in Buddhist Era for th (display-only, 2026→2569)', async () => {
    localeRef.current = 'th';
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const html = renderToStaticMarkup(tree as ReactElement);
    // 2026 CE + 543 = 2569 BE — the localised helper maps th → buddhist cal.
    // The registrationDate (2026-04-16) must render as BE year 2569.
    expect(html).toContain('2569');
    // The Gregorian year '2026' may still appear in planYear (integer field),
    // but the date string itself must contain '2569', not '2026 Apr' etc.
    // Verify the date cell specifically: it must NOT contain an English month.
    expect(html).not.toContain('Apr');
    expect(html).not.toContain('April');
  });

  it('CROSS-TENANT: resolves memberId from the session user via findByLinkedUserId (never a URL param)', async () => {
    await PortalProfileBody({ user: { id: 'user-a' } });
    expect(findByLinkedUserIdMock).toHaveBeenCalledTimes(1);
    // 2nd arg is the session user id — the ONLY input that scopes the member.
    expect(findByLinkedUserIdMock.mock.calls[0]![1]).toBe('user-a');
    // getMember is then called with the member id returned by that lookup,
    // not with any externally supplied id.
    expect(getMemberMock.mock.calls[0]![0]).toBe('mem-a');
  });

  it('shows the not-linked message when findByLinkedUserId fails', async () => {
    findByLinkedUserIdMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'repo.not_found' },
    });
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).toContain('notLinked');
  });

  it('f9Dashboard:true — renders 4 <h2> sections including the Directory section', async () => {
    // Flip the feature flag on for this test only.
    const envMod = await import('@/lib/env');
    // @ts-expect-error — override readonly features for test isolation
    envMod.env.features.f9Dashboard = true;
    try {
      const tree = await PortalProfileBody({ user: { id: 'user-a' } });
      const html = renderToStaticMarkup(tree as ReactElement);
      // Organisation + Membership + Contacts + Directory = 4 headings.
      const h2Count = (html.match(/<h2/g) ?? []).length;
      expect(h2Count).toBe(4);
      // The Directory section heading key comes from directorySettings.title.
      expect(html).toContain('title');
    } finally {
      // @ts-expect-error — restore
      envMod.env.features.f9Dashboard = false;
    }
  });

  it('isPrimary:false — Invite Colleague button is absent', async () => {
    const nonPrimaryContact = { ...ownContact, isPrimary: false };
    getMemberMock.mockResolvedValueOnce({
      ok: true,
      value: { member, contacts: [nonPrimaryContact] },
    });
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const html = renderToStaticMarkup(tree as ReactElement);
    // The invite button renders only when ownContact.isPrimary === true.
    expect(html).not.toContain('inviteColleague');
  });

  // 067 I5(c) — the member's own tax_id is surfaced unconditionally so they can
  // verify the §86/4 buyer TIN the chamber has on file. (The field renders for
  // both company and individual members.)
  it('renders the Tax ID field with the member tax_id value', async () => {
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const html = renderToStaticMarkup(tree as ReactElement);
    // The label key (identity translator returns the key string) …
    expect(html).toContain('fields.taxId');
    // … and the actual value (DetailField renders `String(value)`).
    expect(html).toContain('0105558012345');
  });

  // 069 — the §86/4 buyer address is surfaced read-only so the member can
  // verify what prints on their tax invoices. Composed exactly like the admin
  // detail page: street lines, then sub-district → city → province → postcode.
  it('renders the Address field composed from the member address parts', async () => {
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).toContain('fields.address');
    expect(html).toContain('123 Sukhumvit Rd');
    expect(html).toContain('Khlong Toei Khlong Toei Bangkok 10110');
  });

  it('Address field shows the "—" fallback when no address is on file', async () => {
    const noAddress = {
      ...member,
      addressLine1: null,
      addressLine2: null,
      subDistrict: null,
      city: null,
      province: null,
      postalCode: null,
    };
    getMemberMock.mockResolvedValueOnce({
      ok: true,
      value: { member: noAddress, contacts: [ownContact] },
    });
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const html = renderToStaticMarkup(tree as ReactElement);
    // The label still renders; the value cell falls back to the em dash.
    expect(html).toContain('fields.address');
    expect(html).toContain('—');
  });

  /**
   * 067 I5(b) — company-only field hiding by member TYPE (memberTypeScope).
   *
   * `isIndividual = planLookup.ok && plan.memberTypeScope === 'individual'`
   * gates `legalEntityType` + `foundedYear` behind `!isIndividual`. The default
   * getPlan mock has NO memberTypeScope, so the existing tests only ever
   * exercise the company branch — inverting the guard to `isIndividual` would
   * NOT fail any of them. These two cases drive BOTH scopes so the guard's
   * direction is locked: the individual case below FAILS if `!isIndividual`
   * were inverted (the company-only fields would then render for an individual).
   */
  describe('company-only field hiding by memberTypeScope (067 I5(b))', () => {
    it('individual plan → legalEntityType + foundedYear fields are ABSENT', async () => {
      getPlanMock.mockResolvedValueOnce({
        ok: true,
        value: { planNameEn: 'Individual', memberTypeScope: 'individual' },
      });
      const tree = await PortalProfileBody({ user: { id: 'user-a' } });
      const html = renderToStaticMarkup(tree as ReactElement);
      // Company-only rows are hidden for a natural-person member.
      expect(html).not.toContain('fields.legalEntityType');
      expect(html).not.toContain('fields.foundedYear');
      // The non-company-gated rows still render (sanity: not an empty tree).
      expect(html).toContain('fields.companyName');
      expect(html).toContain('fields.taxId');
    });

    it('company plan → legalEntityType + foundedYear fields are PRESENT', async () => {
      getPlanMock.mockResolvedValueOnce({
        ok: true,
        value: { planNameEn: 'Corporate', memberTypeScope: 'company' },
      });
      const tree = await PortalProfileBody({ user: { id: 'user-a' } });
      const html = renderToStaticMarkup(tree as ReactElement);
      expect(html).toContain('fields.legalEntityType');
      expect(html).toContain('fields.foundedYear');
    });
  });
});

/**
 * #239 — the history card lists the member's two most recent change requests
 * as one-line rows (field, status, date; never the values), read with the
 * history page's own use case, limit 2. Best-effort: a failed read leaves the
 * card with its link only, never a broken page.
 */
describe('recent change requests on the history card (#239)', () => {
  function request(id: string, over: Record<string, unknown>) {
    return {
      request: {
        id,
        memberId: 'mem-a',
        scope: 'company',
        state: 'pending',
        outcome: null,
        withdrawnReason: null,
        withdrawnAt: null,
        submittedAt: new Date('2026-10-20T03:00:00Z'),
        submittedByUserId: 'user-a',
        submittedByContactId: 'con-a',
        decidedAt: null,
        decisionReason: null,
        outcomeAcknowledgedAt: null,
        fields: [
          { key: 'address_line1', target: null, seen: 'Old', proposed: 'New', affectsTaxDocuments: true, outcome: null, appliedAt: null },
        ],
        ...over,
      },
      submitter: { displayName: 'Test User' },
    };
  }

  async function withApprovalFlag<T>(fn: () => Promise<T>): Promise<T> {
    const envMod = await import('@/lib/env');
    // @ts-expect-error — override readonly features for test isolation
    envMod.env.features.memberChangeApproval = true;
    try {
      return await fn();
    } finally {
      // @ts-expect-error — restore
      envMod.env.features.memberChangeApproval = false;
    }
  }

  it('reads the two most recent requests and draws one row each: field, "+N more", status', async () => {
    listPortalChangeRequestsMock.mockResolvedValueOnce({
      ok: true,
      value: {
        items: [
          request('cr-1', {
            state: 'decided',
            outcome: 'approved',
            decidedAt: new Date('2026-10-21T03:00:00Z'),
            fields: [
              { key: 'phone', target: null, seen: '1', proposed: '2', affectsTaxDocuments: false, outcome: 'approved', appliedAt: null },
              { key: 'website', target: null, seen: 'a', proposed: 'b', affectsTaxDocuments: false, outcome: 'approved', appliedAt: null },
            ],
          }),
          request('cr-2', {}),
        ],
        nextCursor: 'next',
      },
    });
    const html = await withApprovalFlag(async () =>
      renderToStaticMarkup((await PortalProfileBody({ user: { id: 'user-a' } })) as ReactElement),
    );
    expect(listPortalChangeRequestsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'user-a', memberId: 'mem-a', cursor: null, limit: 2 }),
    );
    const el = document.createElement('div');
    el.innerHTML = html;
    const rows = el.querySelectorAll('[data-testid="profile-recent-request"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('labels.phone');
    expect(rows[0]?.textContent).toContain('profileCard.moreFields');
    expect(rows[0]?.querySelector('[data-outcome="approved"]')).not.toBeNull();
    expect(rows[1]?.textContent).toContain('labels.address_line1');
    // each row opens its request on the history page, a 44px target
    const link = rows[0]?.querySelector('a');
    expect(link).toHaveAttribute('href', '/portal/change-requests#request-cr-1');
    expect(link).toHaveClass('min-h-11');
    expect(rows[1]?.textContent).not.toContain('profileCard.moreFields');
    // the values stay on the history page
    expect(html).not.toContain('New');
    expect(el.querySelectorAll('[data-testid="profile-history-link"]')).toHaveLength(1);
  });

  it('keeps the card with its link when the read fails', async () => {
    listPortalChangeRequestsMock.mockResolvedValueOnce({ ok: false, error: { type: 'server_error', message: 'x' } });
    const html = await withApprovalFlag(async () =>
      renderToStaticMarkup((await PortalProfileBody({ user: { id: 'user-a' } })) as ReactElement),
    );
    const el = document.createElement('div');
    el.innerHTML = html;
    expect(el.querySelectorAll('[data-testid="profile-recent-request"]')).toHaveLength(0);
    expect(el.querySelectorAll('[data-testid="profile-history-link"]')).toHaveLength(1);
    expect(html).toContain('contactsSection');
  });
});

/**
 * #239 — a shorter profile on phones. Below 768px (where the Organisation
 * grid is one column) the record keeps the invoice fields in view and folds
 * legal entity, country, website, founded year and description into a
 * "More details" disclosure; from 768px the grid shows them as before. Email
 * and phone share one wrapping row on phones, each still a 44px target.
 */
describe('a shorter profile on phones (#239)', () => {
  const FOLDED = ['fields.legalEntityType', 'fields.country', 'fields.website', 'fields.foundedYear'];

  async function renderEl() {
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const el = document.createElement('div');
    el.innerHTML = renderToStaticMarkup(tree as ReactElement);
    return el;
  }

  it('folds the secondary Organisation fields into a phone-only disclosure', async () => {
    const el = await renderEl();
    const org = el.querySelector('section[aria-labelledby="portal-profile-org-heading"]')!;
    const details = org.querySelector('details');
    expect(details).toHaveClass('md:hidden');
    const summary = details!.querySelector('summary');
    expect(summary?.textContent).toBe('moreDetails');
    // AURA 5.59 linkClass: accent text, 44px on touch (#172)
    expect(summary).toHaveClass('aura-link', 'aura-link--touch');
    // AURA 5.60 (#173): the summary hugs its text itself; no layout of our own
    for (const c of ['inline-flex', 'flex', 'items-center', 'min-w-0', 'max-w-full', 'w-fit', 'justify-start', 'list-none']) expect(summary).not.toHaveClass(c);
    for (const key of FOLDED) {
      const inDisclosure = [...details!.querySelectorAll('dt')].find((dt) => dt.textContent === key);
      expect(inDisclosure, `${key} in the disclosure`).toBeDefined();
      const inGrid = [...org.querySelectorAll('dl')[0]!.children].find((c) => c.querySelector('dt')?.textContent === key);
      expect(inGrid, `${key} in the grid`).toHaveClass('max-md:hidden');
    }
    // the invoice fields stay in view on phones
    for (const key of ['fields.memberNumber', 'fields.companyName', 'fields.taxId', 'fields.address', 'fields.billingAddress']) {
      const inGrid = [...org.querySelectorAll('dl')[0]!.children].find((c) => c.querySelector('dt')?.textContent === key);
      expect(inGrid, key).not.toHaveClass('max-md:hidden');
    }
  });

  it('puts email and phone on one wrapping row on phones, each a 44px target', async () => {
    getMemberMock.mockResolvedValueOnce({
      ok: true,
      value: { member, contacts: [{ ...ownContact, phone: '+66 81 234 5678' }] },
    });
    const el = await renderEl();
    const email = el.querySelector('a[href="mailto:member@a.example"]')!;
    const phone = el.querySelector('a[href^="tel:"]')!;
    expect(email.parentElement).toBe(phone.parentElement);
    expect(email.parentElement).toHaveClass('flex-wrap');
    expect(email).toHaveClass('aura-link', 'aura-link--touch');
    expect(phone).toHaveClass('aura-link', 'aura-link--touch');
    // AURA 5.60 (#173) keeps a stretched link's text at the start itself
    for (const link of [email, phone]) expect(link).not.toHaveClass('justify-start');
  });
});
