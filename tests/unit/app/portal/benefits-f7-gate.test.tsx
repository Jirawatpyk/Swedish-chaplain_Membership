/**
 * 058 / C1 (CRITICAL) — page-level F7 kill-switch lock for the Benefits page.
 *
 * THE THREAT (xhigh #12): the Next proxy is PATHNAME-based. It blocks
 * `/portal/broadcasts/**` + `/portal/benefits/e-blasts`, but the broadcasts
 * CONTENT now lives at `/portal/benefits?tab=broadcasts` — a QUERY param the
 * proxy cannot see. So when F7 is OFF (operator break-glass,
 * `env.features.f7Broadcasts === false`), the ONLY thing that stops a
 * hand-crafted `?tab=broadcasts` from building the broadcasts panel + running
 * the quota/history DB reads is this line in page.tsx:
 *
 *     const activeTab = f7Enabled ? resolveBenefitsTab(tab) : BENEFITS_TAB.benefits;
 *     const broadcastsPanel =
 *       activeTab === BENEFITS_TAB.broadcasts ? <BroadcastsPanel … /> : null;
 *
 * If someone dropped the `f7Enabled ?` ternary, EVERY existing test stays green
 * (they assert the F7-ON path or the component in isolation), but a `?tab=
 * broadcasts` under F7-OFF would (a) force activeTab to broadcasts, (b) build
 * the panel, (c) run computeQuotaCounter + listMemberBroadcasts. This test is
 * the regression net for exactly that.
 *
 * SECURITY ASSERTION: under f7=false + ?tab=broadcasts, the broadcasts
 * use-cases (computeQuotaCounter, listMemberBroadcasts — owned by
 * BroadcastsPanel, reachable only when the page builds the panel) are NOT
 * invoked, and the rendered DOM has NO Broadcasts tab/panel.
 *
 * Harness: mirrors account-hub.test.tsx — getTranslations backed by the real
 * en.json (so a dangling t() surfaces as a MISSING_KEY sentinel rather than
 * passing silently), all server-only infra stubbed, and the broadcasts module
 * mocked so its reads are observable spies even on the (correct) path where
 * the panel is never built.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

// ---------------------------------------------------------------------------
// Real-en.json translator for the RSC body's next-intl/server calls.
// (Identical pattern to account-hub.test.tsx / dashboard-loading.test.tsx.)
// ---------------------------------------------------------------------------
type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined),
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
  getTranslations: vi.fn().mockImplementation(async (ns: string) => makeRealTranslator(ns)),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

// Client children (BenefitsTabs) call useRouter() — stub the navigation hooks.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/portal/benefits',
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

// F7 kill-switch OFF — the system-under-test condition. f9Dashboard included
// only because the env object may be touched elsewhere in the import graph.
vi.mock('@/lib/env', () => ({
  env: { features: { f7Broadcasts: false, f9Dashboard: true } },
}));

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/log-id', () => ({ errKind: () => 'err' }));
vi.mock('@/lib/metrics', () => ({ insightsMetrics: { benefitViewed: vi.fn() } }));

// Member lookup → a linked member (so the page proceeds past the empty card).
const findByLinkedUserId = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: { memberId: 'm1' } }),
);
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: { findByLinkedUserId } }),
}));

// 059-membership-suspension — the page now also resolves membership access
// for the "benefits paused" banner. Mocked to `full` (no banner) so this
// pre-existing F7-kill-switch gate test stays isolated from the real
// renewals DB read; the suspended-banner behaviour itself is covered by
// `tests/unit/app/portal/benefits-suspended-banner.test.tsx`.
vi.mock('@/lib/load-membership-access', () => ({
  loadMembershipAccess: vi.fn().mockResolvedValue({ access: 'full', reason: 'in_good_standing' }),
}));

// Benefits-tab usage compute → a minimal valid usage (the benefits arm always
// runs under F7-off; BenefitUsageCard is stubbed below so the shape can be
// minimal — `quantifiable` must be an array because the page `.map`s it).
const computeBenefitUsage = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    ok: true,
    value: {
      membershipYear: 2026,
      elapsedYearPct: 50,
      // Include the E-Blast benefit so the page's eblast `actionHref` branch
      // actually runs (an empty array never exercised it → the leak hid here).
      quantifiable: [{ key: 'eblast', label: 'E-Blast', consumed: 0, limit: 5 }],
      active: [],
      aggregateConsumedPct: null,
      underUseWarning: false,
    },
  }),
);
vi.mock('@/modules/insights', () => ({
  computeBenefitUsage,
  makeComputeBenefitUsageDeps: () => ({}),
}));

// THE SECURITY SPIES. These belong to BroadcastsPanel (the page never imports
// them directly). They are observable here so that IF the page-level gate
// regressed and the panel were built, the call would be captured and the
// NOT-called assertion would fail. The `make*Deps` factories are stubbed so a
// (regressed) BroadcastsPanel render wouldn't crash before reaching the reads.
const computeQuotaCounter = vi.hoisted(() => vi.fn());
const listMemberBroadcasts = vi.hoisted(() => vi.fn());
vi.mock('@/modules/broadcasts', () => ({
  computeQuotaCounter,
  listMemberBroadcasts,
  makeComputeQuotaDeps: () => ({}),
  makeListMemberBroadcastsDeps: () => ({}),
  // Consumed at MODULE scope by quota-banner.ts (re-exported as
  // formatNextResetAt), which is in broadcasts-panel.tsx's import graph and is
  // therefore loaded eagerly even on the (correct) path where the panel never
  // renders. Stubbed so the module graph resolves without pulling the real
  // broadcasts barrel.
  nextResetAtFor: () => '2027-01-01T00:00:00.000Z',
}));

// Stub the leaf benefit card — its internals (locale/i18n surface) are not the
// subject of this gate test; the page's OWN t() calls still resolve via the
// real-en.json translator above. The stub renders a sentinel testid AND
// captures the props the page passes it — the E-Blast Compose `actionHref` /
// `warningActionHref` leak the earlier version of this test could not see
// (it stubbed the card with no prop capture AND used an empty `quantifiable`,
// so the eblast branch never ran).
const benefitCardProps = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('@/components/benefits/benefit-usage-card', () => ({
  BenefitUsageCard: (props: unknown) => {
    benefitCardProps.value = props;
    return <div data-testid="benefit-usage-card">benefit usage</div>;
  },
}));

// Stub BroadcastsPanel with a SYNCHRONOUS render-spy. The real panel is an
// `async` server component whose body never executes under RTL's `render()` in
// jsdom (async children aren't awaited) — so a regressed gate that BUILDS the
// panel would not, on its own, fire the use-case spies in this environment.
// A synchronous stub closes that blind spot: it renders ONLY when the page
// actually constructs `<BroadcastsPanel/>` (i.e. when the gate forced the
// broadcasts tab active), making "the page never builds the panel" a directly
// observable, mutation-sensitive signal. If page.tsx's `f7Enabled ?` ternary
// is removed, this stub renders and `broadcastsPanelRendered` flips true.
const broadcastsPanelRender = vi.hoisted(() => vi.fn());
vi.mock('@/app/(member)/portal/benefits/_components/broadcasts-panel', () => ({
  BroadcastsPanel: () => {
    broadcastsPanelRender();
    return <div data-testid="broadcasts-panel-stub">broadcasts panel</div>;
  },
}));

import PortalBenefitsPage from '@/app/(member)/portal/benefits/page';

async function renderPage(searchParams: { tab?: string; page?: string }) {
  const ui = await PortalBenefitsPage({
    searchParams: Promise.resolve(searchParams),
  });
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('PortalBenefitsPage — page-level F7 kill-switch (C1, xhigh #12)', () => {
  beforeEach(() => {
    computeQuotaCounter.mockClear();
    listMemberBroadcasts.mockClear();
    computeBenefitUsage.mockClear();
    broadcastsPanelRender.mockClear();
    benefitCardProps.value = undefined;
    findByLinkedUserId.mockResolvedValue({ ok: true, value: { memberId: 'm1' } });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // THE security assertion — no broadcasts data fetched under F7-off, even
  // with a hand-crafted ?tab=broadcasts. Enforced on two layers:
  //   1. The page never BUILDS the broadcasts panel (broadcastsPanelRender
  //      stub never renders) — the mutation-sensitive, jsdom-observable signal.
  //      Removing the `f7Enabled ?` ternary in page.tsx forces activeTab to
  //      broadcasts, the page constructs <BroadcastsPanel/>, the stub renders,
  //      and this FAILS.
  //   2. The broadcasts use-cases (computeQuotaCounter / listMemberBroadcasts)
  //      are never invoked — they live INSIDE the panel, so "panel never built"
  //      implies "reads never run". Belt-and-suspenders for the data-fetch
  //      contract the task pins.
  // -------------------------------------------------------------------------
  it('f7=false + ?tab=broadcasts → never builds the broadcasts panel', async () => {
    await renderPage({ tab: 'broadcasts' });
    expect(broadcastsPanelRender).not.toHaveBeenCalled();
    expect(screen.queryByTestId('broadcasts-panel-stub')).toBeNull();
  });

  it('f7=false + ?tab=broadcasts → does NOT fetch any broadcasts data', async () => {
    await renderPage({ tab: 'broadcasts' });
    expect(computeQuotaCounter).not.toHaveBeenCalled();
    expect(listMemberBroadcasts).not.toHaveBeenCalled();
  });

  it('f7=false + ?tab=broadcasts → renders NO Broadcasts tab and NO broadcasts panel', async () => {
    await renderPage({ tab: 'broadcasts' });
    // Exactly one tab (Benefits) — the Broadcasts trigger is gated off.
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.queryByRole('tab', { name: /broadcasts/i })).toBeNull();
    // The broadcasts panel heading (rendered by BroadcastsPanel) is absent.
    expect(screen.queryByText(/broadcasts/i, { selector: 'h2' })).toBeNull();
  });

  it('f7=false + ?tab=broadcasts → still computes + shows the BENEFITS panel (active forced to benefits)', async () => {
    await renderPage({ tab: 'broadcasts' });
    // The benefits arm runs (active was forced back to benefits) — the usage
    // compute fired and the (stubbed) benefit card rendered.
    expect(computeBenefitUsage).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('benefit-usage-card')).toBeInTheDocument();
    // The single visible tab is the Benefits tab.
    expect(screen.getByRole('tab', { name: 'Benefits' })).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // The E-Blast Compose leak (reported 2026-07-15): the Broadcasts *tab* is
  // gated, but the E-Blast benefit card lives on the always-visible Benefits
  // tab. Its Compose `actionHref` (+ the under-use `warningActionHref`) point
  // at /portal/broadcasts/new, which the proxy 503s when F7 is off — a dead
  // link a member can still click. Under F7-off the card must receive NEITHER.
  // -------------------------------------------------------------------------
  it('f7=false → the E-Blast benefit card gets NO Compose actionHref and NO warningActionHref (no dead link)', async () => {
    await renderPage({ tab: 'benefits' });
    const props = benefitCardProps.value as {
      quantifiable: ReadonlyArray<{ key: string; actionHref?: string }>;
      warningActionHref?: string;
    };
    const eblast = props.quantifiable.find((b) => b.key === 'eblast');
    expect(eblast).toBeDefined();
    expect(eblast?.actionHref).toBeUndefined();
    expect(props.warningActionHref).toBeUndefined();
  });

  it('f7=false + ?tab=broadcasts → also passes a numeric ?page= without fetching broadcasts', async () => {
    // A hand-crafted ?page= alongside ?tab=broadcasts must STILL not trigger
    // any broadcasts read (the page clamps page eagerly, but the gate keeps
    // the panel null so the page value is never used by a DB call).
    await renderPage({ tab: 'broadcasts', page: '7' });
    expect(computeQuotaCounter).not.toHaveBeenCalled();
    expect(listMemberBroadcasts).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // i18n MISSING_KEY/MISSING_NS/NOT_STRING sentinel sweep — any dropped key
  // backed by the real-en.json translator surfaces as a sentinel string, not
  // a thrown error. (Mirrors account-hub.test.tsx.)
  // -------------------------------------------------------------------------
  it('renders no MISSING_KEY/MISSING_NS/NOT_STRING sentinels anywhere on the page', async () => {
    const { container } = await renderPage({ tab: 'broadcasts' });
    expect(container.textContent ?? '').not.toMatch(/MISSING_KEY|MISSING_NS|NOT_STRING/);
  });
});
