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
  }),
}));

vi.mock('@/modules/members', () => ({
  getMember: (...args: unknown[]) => getMemberMock(...args),
  formatMemberNumber: (prefix: string, n: number) =>
    `${prefix}-${String(n).padStart(4, '0')}`,
  resolveMemberNumberPrefix: (...args: unknown[]) =>
    resolveMemberNumberPrefixMock(...args),
}));

vi.mock('@/lib/env', () => ({
  env: { features: { f9Dashboard: false } },
}));

// next-intl server: identity translator (returns the key) + fixed locale.
const localeRef = { current: 'en' };
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((k: string) => k),
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
  website: null,
  description: null,
  foundedYear: 2010,
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

/** Walk the element tree collecting every node's `type` + flattened text. */
function collectByType(node: unknown, type: string, acc: ReactElement[]) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const c of node) collectByType(c, type, acc);
    return acc;
  }
  const el = node as ReactElement & { props?: { children?: unknown } };
  if (el.type === type) acc.push(el);
  if (el.props && 'children' in el.props) {
    collectByType(el.props.children, type, acc);
  }
  return acc;
}

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
});
