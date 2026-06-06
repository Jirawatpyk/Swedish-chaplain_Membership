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

// next-intl client hook used by CountryDisplay (rendered to markup below).
vi.mock('next-intl', () => ({
  useLocale: () => localeRef.current,
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
    expect(html).toContain('2569');
    expect(html).not.toContain('2026');
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
});
