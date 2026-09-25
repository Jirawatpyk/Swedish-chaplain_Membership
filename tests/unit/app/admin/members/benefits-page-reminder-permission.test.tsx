/**
 * Staff member-benefits page (`/admin/members/[memberId]/benefits`) — the
 * "Send reminder" mailto is admin-only, and the under-use warning speaks
 * about the member in the third person.
 *
 * The page is gated by `members.read`, which manager and marketing also hold,
 * so the page gate alone rendered the reminder for every staff role. The
 * button now rides `members.write` through the permission evaluator (admin +
 * super_admin; super_admin's grant comes from the evaluator, not the bundle).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => {
    const t = (key: string, params?: Record<string, unknown>): string =>
      params ? `${key}:${JSON.stringify(params)}` : key;
    return t;
  }),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const session = vi.hoisted(() => ({
  user: { id: 'staff-1', email: 'staff@example.com', role: 'admin' as string },
}));
vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockImplementation(async () => session),
  getCurrentSession: vi.fn().mockImplementation(async () => session),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 't1' }),
}));
vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-1',
}));

const getMember = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    ok: true,
    value: {
      member: { memberId: 'm1', companyName: 'Acme Co' },
      contacts: [{ isPrimary: true, removedAt: null, email: 'primary@acme.example' }],
    },
  }),
);
vi.mock('@/modules/members', () => ({ getMember }));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({}),
}));

const computeBenefitUsage = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    ok: true,
    value: {
      membershipYear: 2026,
      elapsedYearPct: 62,
      quantifiable: [{ key: 'eblast', used: 1, entitlement: 10, lastUsedAt: null }],
      active: [],
      aggregateConsumedPct: 10,
      underUseWarning: true,
    },
  }),
);
vi.mock('@/modules/insights', () => ({
  computeBenefitUsage,
  makeComputeBenefitUsageDeps: () => ({}),
  recordStaffBenefitView: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/load-membership-access', () => ({
  loadMembershipAccess: vi.fn().mockResolvedValue({ access: 'full', reason: 'in_good_standing' }),
}));

import MemberBenefitsPage from '@/app/(staff)/admin/members/[memberId]/benefits/page';

const MEMBER_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

async function renderAs(role: string) {
  session.user.role = role;
  const ui = await MemberBenefitsPage({
    params: Promise.resolve({ memberId: MEMBER_ID }),
  });
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const reminder = () => screen.queryByRole('link', { name: 'staffActions.sendReminder' });

describe('Admin MemberBenefitsPage — send reminder is admin-only', () => {
  afterEach(() => vi.clearAllMocks());

  it.each(['admin', 'super_admin'])('%s gets the send-reminder mailto', async (role) => {
    await renderAs(role);
    expect(reminder()).toHaveAttribute(
      'href',
      expect.stringMatching(/^mailto:primary@acme\.example\?subject=/),
    );
  });

  it.each(['manager', 'marketing'])('%s does NOT get the send-reminder action', async (role) => {
    await renderAs(role);
    expect(reminder()).toBeNull();
  });
});

describe('Admin MemberBenefitsPage — staff wording on the under-use warning', () => {
  afterEach(() => vi.clearAllMocks());

  it('names the member company instead of addressing the viewer as "you"', async () => {
    await renderAs('manager');
    expect(screen.getByText('Under-using their benefits')).toBeInTheDocument();
    expect(
      screen.getByText('At 62% of the year, Acme Co has used 10% of its benefits.'),
    ).toBeInTheDocument();
    expect(screen.queryByText("You're not using all your benefits")).toBeNull();
  });
});
