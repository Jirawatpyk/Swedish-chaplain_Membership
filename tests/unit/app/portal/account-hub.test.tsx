import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

// ---------------------------------------------------------------------------
// Real-en.json translator for the RSC body's next-intl/server calls.
//
// The page calls getTranslations()/getLocale() from 'next-intl/server',
// which throws "not supported in Client Components" in the Vitest env.
// We back the mock with a resolver against the REAL en.json so the
// structural assertions render genuine text (e.g. "Account",
// "Renewal preferences") AND a dangling t() reference surfaces as a
// "MISSING_KEY:" string — the MISSING_MESSAGE defence. The CLIENT
// children (forms/toggle/theme) get their strings from the
// NextIntlClientProvider below. (Pattern mirrors dashboard-loading.test.tsx.)
// ---------------------------------------------------------------------------
type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) =>
        acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined,
      obj,
    );
}

function makeRealTranslator(ns: string) {
  return (key: string, params?: Record<string, unknown>): string => {
    const nsObj = getPath(enMessages as unknown, ns);
    if (!nsObj) return `MISSING_NS:${ns}`;
    const val = getPath(nsObj, key);
    if (val === undefined || val === null) return `MISSING_KEY:${ns}.${key}`;
    if (typeof val !== 'string') return `NOT_STRING:${ns}.${key}`;
    if (!params) return val;
    return val.replace(/\{(\w+)[^}]*\}/g, (_, k: string) =>
      params[k] !== undefined ? String(params[k]) : `{${k}}`,
    );
  };
}

vi.mock('next-intl/server', () => ({
  getTranslations: vi
    .fn()
    .mockImplementation(async (ns: string) => makeRealTranslator(ns)),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

// Client children (DataExportPanel, PortalSignOutButton) call useRouter(),
// which throws "expected app router to be mounted" outside a Next.js app
// shell. Stub the navigation hooks the app-router would provide.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/portal/account',
}));

// Server-only deps stubbed so the RSC body is pure JSX in the test.
vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({
    user: { id: 'u1', email: 'jane@example.com', role: 'member' },
  }),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 't1' }),
}));
vi.mock('@/lib/env', () => ({ env: { features: { f9Dashboard: true } } }));
vi.mock('@/lib/db', () => ({ runInTenant: async (_t: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/members', () => ({
  getMemberPreferredLocale: vi.fn().mockResolvedValue({ ok: true, value: 'en' }),
  f3DrizzleMemberRepo: {},
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: { findByLinkedUserId: vi.fn().mockResolvedValue({ ok: true, value: { memberId: 'm1' } }) },
  }),
}));
vi.mock('@/modules/renewals', () => ({
  makeRenewalsDeps: () => ({
    memberRenewalFlagsRepo: { readRenewalRemindersOptedOut: vi.fn().mockResolvedValue(false) },
  }),
}));
vi.mock('@/modules/insights', () => ({ listMemberDataExports: vi.fn().mockResolvedValue([]) }));

import MemberAccountPage from '@/app/(member)/portal/account/page';

async function renderHub() {
  const ui = await MemberAccountPage();
  return render(<NextIntlClientProvider locale="en" messages={enMessages}>{ui}</NextIntlClientProvider>);
}

describe('Account hub — sectioned IA (G2)', () => {
  it('renders a real <h2> for each of the four sections', async () => {
    await renderHub();
    for (const name of [/^Account$/, /Renewal preferences/, /Data & privacy/, /Appearance/]) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
  });

  it('anchors the renewal + data-privacy sections with scroll-mt offsets', async () => {
    const { container } = await renderHub();
    const renewal = container.querySelector('#renewal-prefs');
    const privacy = container.querySelector('#data-privacy');
    expect(renewal).not.toBeNull();
    expect(privacy).not.toBeNull();
    expect(renewal?.className).toMatch(/scroll-mt-/);
    expect(privacy?.className).toMatch(/scroll-mt-/);
  });

  it('shows the member email and a Forgot-your-password link to /forgot-password', async () => {
    await renderHub();
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /forgot your password/i }))
      .toHaveAttribute('href', '/forgot-password');
  });

  // I1: Whole-page MISSING_KEY sentinel guard — any dropped i18n key that
  // makeRealTranslator backs (portal.account.*, portal.preferredLocale.*,
  // shell.roleBadge.*, dataExport.*) surfaces as a sentinel string in the
  // rendered container, not a thrown error.  This assertion catches them.
  it('renders no MISSING_KEY/MISSING_NS/NOT_STRING sentinels anywhere in the hub', async () => {
    const { container } = await renderHub();
    expect(container.textContent ?? '').not.toMatch(/MISSING_KEY|MISSING_NS|NOT_STRING/);
  });
});

// M2: f9Dashboard gated-OFF path.
//
// vi.mock('@/lib/env') is module-level (hoisted), so we cannot override it per-test
// in the same describe. The established repo pattern (snapshot-refresh-tenant-guard.test.ts)
// mutates the mocked env object directly inside try/finally to avoid vi.doMock + dynamic
// import churn. We use that same pattern here.
describe('Account hub — f9Dashboard gated OFF', () => {
  let envModule: { env: { features: { f9Dashboard: boolean } } };

  beforeEach(async () => {
    envModule = (await import('@/lib/env')) as { env: { features: { f9Dashboard: boolean } } };
    envModule.env.features.f9Dashboard = false;
  });

  afterEach(() => {
    envModule.env.features.f9Dashboard = true;
  });

  it('hides #data-privacy and still renders the other three sections', async () => {
    const { container } = await renderHub();
    // Data & privacy section must be absent when the flag is off.
    expect(container.querySelector('#data-privacy')).toBeNull();
    // The three remaining sections must still render.
    expect(container.querySelector('#account')).not.toBeNull();
    expect(container.querySelector('#renewal-prefs')).not.toBeNull();
    expect(container.querySelector('#appearance')).not.toBeNull();
  });
});
