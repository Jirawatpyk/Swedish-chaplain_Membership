import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

// Client children (DataExportPanel) call useRouter(), which throws "expected
// app router to be mounted" outside a Next.js app shell. Stub the navigation
// hooks the app-router would provide. (063: the in-hub PortalSignOutButton —
// which also used useRouter — was removed; sign-out is top-bar-only now.)
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
  // 016 T027 — swept pages gate via requirePagePermission, which reads
  // getCurrentSession. Same session as requireSession so the case is unchanged.
  getCurrentSession: vi.fn().mockResolvedValue({
    user: { id: 'u1', email: 'jane@example.com', role: 'member' },
  }),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 't1' }),
}));
vi.mock('@/lib/env', () => ({ env: { features: { f9Dashboard: true } } }));
vi.mock('@/lib/db', () => ({ runInTenant: async (_t: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
// Hoisted logger spy so the throw-path suites can assert which level fired
// (warn vs error) on each best-effort seed failure.
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger }));

// Hoist the controllable mocks so the throw-path suites can mutate them
// (reject / return a non-not_found error) without vi.doMock + dynamic-import
// churn (matches the env-mutation pattern above).
const getMemberPreferredLocale = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: 'en' }),
);
vi.mock('@/modules/members', () => ({
  getMemberPreferredLocale,
  f3DrizzleMemberRepo: {},
}));
const findByLinkedUserId = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: { memberId: 'm1' } }),
);
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: { findByLinkedUserId },
  }),
}));
const readRenewalRemindersOptedOut = vi.hoisted(() =>
  vi.fn().mockResolvedValue(false),
);
vi.mock('@/modules/renewals', () => ({
  makeRenewalsDeps: () => ({
    memberRenewalFlagsRepo: { readRenewalRemindersOptedOut },
  }),
}));
const listMemberDataExports = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('@/modules/insights', () => ({ listMemberDataExports }));

import MemberAccountPage from '@/app/(member)/portal/account/page';

async function renderHub() {
  const ui = await MemberAccountPage();
  return render(<NextIntlClientProvider locale="en" messages={enMessages}>{ui}</NextIntlClientProvider>);
}

describe('Account hub — sectioned IA (G2)', () => {
  it('renders a real <h2> in the CardHeader for each of the five self-titled cards', async () => {
    await renderHub();
    // Each title is a real <h2> (NOT the shadcn CardTitle <div>) so it lands in
    // the SR heading tree — mirrors benefit-usage-card.tsx 056 fix #1. The
    // language card's title comes from `portal.preferredLocale.title`
    // ("Notification language"), moved up from the old body <p>.
    for (const name of [
      /^Account$/,
      /Notification language/,
      /Renewal preferences/,
      /Data & privacy/,
    ]) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
  });

  it('each titled card heading sits inside its AURA card head', async () => {
    await renderHub();
    // Guards the "title INSIDE the card" fix: the h2 must be a descendant of
    // the card head, not a bare sibling above the card (the old empty-pt-6
    // shape). Spec 122 US3: AURA card markup.
    const heading = screen.getByRole('heading', { level: 2, name: /^Account$/ });
    expect(heading).toHaveClass('aura-card__title');
    expect(heading.closest('.aura-card__head')).not.toBeNull();
  });

  it('anchors the language + renewal + data-privacy sections with scroll-mt offsets', async () => {
    const { container } = await renderHub();
    const language = container.querySelector('#language');
    const renewal = container.querySelector('#renewal-prefs');
    const privacy = container.querySelector('#data-privacy');
    expect(language).not.toBeNull();
    expect(renewal).not.toBeNull();
    expect(privacy).not.toBeNull();
    expect(language?.className).toMatch(/scroll-mt-/);
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

// M3: Unlinked user — no member row (findByLinkedUserId → repo.not_found).
//
// The page treats `!memberLookup.ok && error.code === 'repo.not_found'` as the
// normal "pending invite / unlinked account" case: memberId stays null and the
// gate at `{memberId ? ... : null}` hides both #renewal-prefs and #data-privacy.
// We override the `buildMembersDeps` factory mock in beforeEach using the same
// module-mutation technique as the f9Dashboard block above.
describe('Account hub — unlinked user (no member row)', () => {
  // Mutate the hoisted findByLinkedUserId mock to return the unlinked result.
  // The vi.hoisted() reference is stable across calls, so beforeEach/afterEach
  // can flip it without vi.doMock + dynamic-import churn (same pattern as the
  // env-mutation block below for f9Dashboard).
  beforeEach(() => {
    findByLinkedUserId.mockResolvedValue({
      ok: false,
      error: { code: 'repo.not_found' },
    });
  });

  afterEach(() => {
    // Restore the default "linked member" result for subsequent suites.
    findByLinkedUserId.mockResolvedValue({ ok: true, value: { memberId: 'm1' } });
  });

  it('still renders #account (sign-out is now top-bar-only, not in-hub) when memberId is null', async () => {
    const { container } = await renderHub();
    expect(container.querySelector('#account')).not.toBeNull();
    expect(
      within(container).queryByRole('button', { name: /^sign out$/i }),
    ).toBeNull();
  });

  it('hides #renewal-prefs when the user has no linked member', async () => {
    const { container } = await renderHub();
    expect(container.querySelector('#renewal-prefs')).toBeNull();
  });

  it('hides #data-privacy when the user has no linked member', async () => {
    const { container } = await renderHub();
    expect(container.querySelector('#data-privacy')).toBeNull();
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
    expect(
      within(container).queryByRole('button', { name: /^sign out$/i }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// I3: never-500 contract — the hub MUST keep rendering Account + Sign out
// (the account-management / sign-out surface) even when a member-data seed
// read fails transiently. Each test drives one seed path into a throw/genuine-
// error and asserts: (a) the page still returns markup (NOT a thrown error —
// remove the corresponding try/catch and `await MemberAccountPage()` would
// reject, failing the render); (b) the expected log level fired on the
// expected key; (c) the dependent section degrades.
//
// Reuses the file's hoisted-mock-mutation harness. Each suite restores the
// happy-path default in afterEach so later suites stay green.
// ---------------------------------------------------------------------------
describe('Account hub — never-500 throw paths (I3)', () => {
  beforeEach(() => {
    logger.warn.mockClear();
    logger.error.mockClear();
  });

  describe('member lookup returns a genuine (non-not_found) error', () => {
    beforeEach(() => {
      // A real Neon/RLS fault wrapped as a Result error — NOT repo.not_found.
      findByLinkedUserId.mockResolvedValue({
        ok: false,
        error: { code: 'repo.unexpected', cause: new Error('connection reset') },
      });
    });
    afterEach(() => {
      findByLinkedUserId.mockResolvedValue({ ok: true, value: { memberId: 'm1' } });
    });

    it('still renders #account (sign-out top-bar-only), logs error, drops member sections', async () => {
      // If the seed try/catch were removed this `await` would reject and the
      // assertions below would never run — the test would error, not pass.
      const { container } = await renderHub();
      expect(container.querySelector('#account')).not.toBeNull();
      expect(
      within(container).queryByRole('button', { name: /^sign out$/i }),
    ).toBeNull();
      // memberId stays null → member-specific sections absent.
      expect(container.querySelector('#renewal-prefs')).toBeNull();
      expect(container.querySelector('#data-privacy')).toBeNull();
      // I1: genuine fault is alertable at ERROR (not warn).
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ errKind: expect.any(String) }),
        'portal.account.member_lookup_failed',
      );
    });
  });

  describe('member lookup rejects (throws)', () => {
    beforeEach(() => {
      findByLinkedUserId.mockRejectedValue(new Error('socket hang up'));
    });
    afterEach(() => {
      findByLinkedUserId.mockResolvedValue({ ok: true, value: { memberId: 'm1' } });
    });

    it('still renders #account (sign-out top-bar-only) and logs the outer hub-seed error', async () => {
      const { container } = await renderHub();
      expect(container.querySelector('#account')).not.toBeNull();
      expect(
      within(container).queryByRole('button', { name: /^sign out$/i }),
    ).toBeNull();
      expect(container.querySelector('#renewal-prefs')).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ errKind: expect.any(String) }),
        'portal.account.hub_seed_failed',
      );
    });
  });

  describe('readRenewalRemindersOptedOut throws', () => {
    beforeEach(() => {
      readRenewalRemindersOptedOut.mockRejectedValue(new Error('RLS denied'));
    });
    afterEach(() => {
      readRenewalRemindersOptedOut.mockResolvedValue(false);
    });

    it('still renders the hub, fires the dedicated renewal-read log, safe-defaults the toggle', async () => {
      const { container } = await renderHub();
      // The member IS linked, so the renewal section still renders (with the
      // safe-default initialOptedOut=false) — the read failure must not drop it.
      expect(container.querySelector('#account')).not.toBeNull();
      expect(container.querySelector('#renewal-prefs')).not.toBeNull();
      expect(
      within(container).queryByRole('button', { name: /^sign out$/i }),
    ).toBeNull();
      // S-renewal-breadcrumb: independently observable on its own key.
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ errKind: expect.any(String) }),
        'portal.account.renewal_flags_read_failed',
      );
    });
  });

  describe('listMemberDataExports throws', () => {
    beforeEach(() => {
      listMemberDataExports.mockRejectedValue(new Error('blob list timeout'));
    });
    afterEach(() => {
      listMemberDataExports.mockResolvedValue([]);
    });

    it('still renders the hub + the data-privacy section, with a role=status "could not load your exports" alert in place of the empty state, logged under its own errorId (PR-3 S-6)', async () => {
      const { container } = await renderHub();
      expect(container.querySelector('#account')).not.toBeNull();
      expect(
      within(container).queryByRole('button', { name: /^sign out$/i }),
    ).toBeNull();
      // f9 ON + linked member → the section renders; a read FAULT is its own
      // state — never the empty state that says "you have not requested one"
      const section = container.querySelector('#data-privacy');
      expect(section).not.toBeNull();
      const alert = within(section as HTMLElement).getByTestId('portal-exports-unavailable');
      expect(alert.getAttribute('role')).toBe('status');
      expect(alert.textContent).toContain(enMessages.dataExport.loadFailed);
      expect(within(section as HTMLElement).queryByText(enMessages.dataExport.empty)).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        // `err`, the house field name for an error kind (PR-3 review C6) —
        // this line was the only F114 log in the file still on `errKind:`
        expect.objectContaining({ errorId: 'M114.portal.account.exports_read_failed', err: expect.any(String) }),
        'portal.account.data_export_list_failed',
      );
      expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), 'portal.account.data_export_list_failed');
    });
  });
});

describe('Account hub on AURA (spec 122 US3)', () => {
  it('draws each section as an AURA card, the role as an AURA badge, and the renewal switch as an AURA switch', async () => {
    const { container } = await renderHub();
    for (const id of ['account', 'language', 'renewal-prefs', 'data-privacy']) {
      const section = container.querySelector(`#${id}`)!;
      expect(section).toHaveClass('aura-card');
      expect(section).toHaveAttribute('aria-labelledby', `${id}-heading`);
    }
    expect(screen.getByText(enMessages.shell.roleBadge.member)).toHaveClass('aura-badge');
    const renewal = within(container.querySelector('#renewal-prefs') as HTMLElement).getByRole('switch', {
      name: enMessages.portal.preferences.renewals.pauseLabel,
    });
    expect(renewal).toHaveClass('aura-switch');
  });

  it('lists data exports in an AURA table with a status badge and an AURA download button', async () => {
    listMemberDataExports.mockResolvedValueOnce([
      { id: 'job-1', status: 'ready', createdAt: new Date('2026-09-20T08:00:00Z') },
    ]);
    const { container } = await renderHub();
    const privacy = container.querySelector('#data-privacy') as HTMLElement;
    expect(within(privacy).getByRole('button', { name: enMessages.dataExport.requestButton })).toHaveClass(
      'aura-btn',
      'aura-btn--secondary',
    );
    expect(privacy.querySelector('table')).toHaveClass('aura-tbl');
    // AURA's table wrap carries the one border; no second box around it
    expect(privacy.querySelector('.aura-tbl-wrap')!.parentElement).not.toHaveClass('border');
    expect(within(privacy).getByText(enMessages.dataExport.statusReady)).toHaveClass('aura-badge', 'aura-badge--success');
    const download = within(privacy).getByRole('link', { name: new RegExp(enMessages.dataExport.download) });
    expect(download).toHaveClass('aura-btn', 'aura-btn--secondary');
    // below sm the link is its icon (still 44px); the aria-label keeps the name
    expect(within(download).getByText(enMessages.dataExport.download)).toHaveClass('max-sm:sr-only');
  });
});
