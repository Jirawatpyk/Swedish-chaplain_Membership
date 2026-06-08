/**
 * 058 — BenefitsTabs F7 kill-switch regression lock + tab-nav assertions.
 *
 * Guards the `showBroadcastsTab` prop contract (now a DISCRIMINATED UNION on
 * `showBroadcastsTab` — I6):
 *   - true  → both Benefits + Broadcasts tabs rendered (F7 on, normal);
 *             `broadcastsPanel` is a required prop on this arm.
 *   - false → only Benefits tab rendered; Broadcasts trigger + panel absent
 *             (F7 kill-switch, env.features.f7Broadcasts === false). On this
 *             arm `active` is pinned to `'benefits'` and `broadcastsPanel`
 *             is OMITTED ENTIRELY by the type.
 *
 * The R2-4 kill-switch lock is now protected on FOUR fronts:
 *   1. COMPILE-TIME (the primary guarantee, I6): a `@ts-expect-error` proves
 *      the illegal combo `{ showBroadcastsTab: false, active: 'broadcasts' }`
 *      is rejected by the discriminated union — the illegal state is
 *      unrepresentable, so the page-level invariant is enforced by the
 *      compiler, not just JSDoc + caller discipline.
 *   2. RUNTIME (valid F7-off arm): `{ showBroadcastsTab: false }` renders no
 *      broadcasts trigger + no panel — fails if the component's runtime
 *      `props.showBroadcastsTab ?` guard is deleted.
 *   3. DEFENCE-IN-DEPTH (cast-forced illegal combo): a `as never` cast forces
 *      the unrepresentable `{ showBroadcastsTab: false, active: 'broadcasts',
 *      broadcastsPanel }` through (simulating a JS / `any` caller that bypasses
 *      the union) — the component's inner runtime guard MUST still suppress the
 *      panel. Proves robustness even when the type is circumvented.
 *   4. POSITIVE CONTROL: `{ showBroadcastsTab: true, active: 'broadcasts' }`
 *      DOES render the panel — proves the suppression tests above aren't
 *      always-null (passing for the wrong reason).
 *
 * I4 — tab navigation: BenefitsTabs writes `?tab=` via router.replace on tab
 * switch (history-replace, drops `?page=`). The mocked `replaceSpy` is now
 * ASSERTED (it was previously wired but never checked): activating Broadcasts
 * navigates to `/portal/benefits?tab=broadcasts`; activating Benefits to
 * `/portal/benefits?tab=benefits` (the `?page=` is intentionally dropped).
 *
 * Provider pattern: NextIntlClientProvider backed by real en.json so
 * `t('benefits')` / `t('broadcasts')` / `t('ariaLabel')` resolve to their
 * actual label strings ("Benefits", "Broadcasts", "Benefits sections").
 * A dangling t() ref would surface as a MISSING_MESSAGE error rather than
 * passing silently — identical reasoning to the portal-sign-out-button test.
 *
 * Fake-timers note: setup.ts installs fake timers globally. BenefitsTabs
 * uses `useTransition` (React internals) + `router.replace` (mocked). The
 * real timers bracket (useRealTimers/useFakeTimers in beforeEach/afterEach)
 * is applied to keep waitFor-style promise resolution reliable, matching the
 * pattern in portal-sign-out-button.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  BenefitsTabs,
  type BenefitsTabsProps,
} from '@/app/(member)/portal/benefits/_components/benefits-tabs';
import {
  BENEFITS_TAB,
  type BenefitsTab,
} from '@/app/(member)/portal/benefits/_helpers/tabs';

// ---------------------------------------------------------------------------
// next/navigation mock — BenefitsTabs calls useRouter().replace on tab change
// ---------------------------------------------------------------------------
const replaceSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceSpy }),
}));

// ---------------------------------------------------------------------------
// Render helpers
//
// `renderTabs` builds a VALID discriminated-union arm:
//   - showBroadcastsTab: false → false-arm (active pinned to benefits, no
//     broadcastsPanel); the helper ignores any `active`/`broadcastsPanel`
//     passed because the false-arm type forbids them.
//   - showBroadcastsTab: true  → true-arm (active either; broadcastsPanel
//     required, defaulted to the `bp` testid stub).
// The defence-in-depth illegal combo is rendered separately via `renderRaw`
// with an `as never` cast (it is, by design, not expressible through the
// typed helper).
// ---------------------------------------------------------------------------

const benefitsBody = <div data-testid="benefits-body">benefits body</div>;

function renderTabs(
  args:
    | { showBroadcastsTab: false }
    | {
        showBroadcastsTab: true;
        active?: BenefitsTab;
        broadcastsPanel?: React.ReactNode;
      },
) {
  const props: BenefitsTabsProps = args.showBroadcastsTab
    ? {
        showBroadcastsTab: true,
        active: args.active ?? BENEFITS_TAB.benefits,
        benefitsPanel: benefitsBody,
        broadcastsPanel:
          args.broadcastsPanel ?? <div data-testid="bp">broadcasts panel</div>,
      }
    : {
        showBroadcastsTab: false,
        active: BENEFITS_TAB.benefits,
        benefitsPanel: benefitsBody,
      };
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BenefitsTabs {...props} />
    </NextIntlClientProvider>,
  );
}

/** Escape hatch for the cast-forced defence-in-depth case ONLY — renders props
 *  the union forbids (simulating a JS / `any` caller). */
function renderRaw(props: unknown) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BenefitsTabs {...(props as BenefitsTabsProps)} />
    </NextIntlClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('<BenefitsTabs> — showBroadcastsTab F7 kill-switch (058)', () => {
  beforeEach(() => {
    // Real timers: setup.ts fakes setTimeout/clearTimeout globally; waitFor
    // and promise-resolution need real timers during async assertions.
    // Matches portal-sign-out-button.test.tsx pattern.
    vi.useRealTimers();
    replaceSpy.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useFakeTimers();
  });

  // -------------------------------------------------------------------------
  // Case 1 — F7 ON: both tabs visible
  // -------------------------------------------------------------------------

  it('showBroadcastsTab=true → renders 2 tabs (Benefits + Broadcasts)', () => {
    renderTabs({ showBroadcastsTab: true });
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(screen.getByRole('tab', { name: /benefits/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /broadcasts/i })).toBeInTheDocument();
  });

  it('showBroadcastsTab=true → benefits panel body is present', () => {
    renderTabs({ showBroadcastsTab: true });
    expect(screen.getByTestId('benefits-body')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Case 2 — F7 OFF (kill-switch): only Benefits tab, no Broadcasts tab/panel
  // -------------------------------------------------------------------------

  it('showBroadcastsTab=false → renders exactly 1 tab (Benefits only)', () => {
    renderTabs({ showBroadcastsTab: false });
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });

  it('showBroadcastsTab=false → Broadcasts tab is NOT rendered', () => {
    renderTabs({ showBroadcastsTab: false });
    expect(screen.queryByRole('tab', { name: /broadcasts/i })).toBeNull();
  });

  // R2-4 facet 2 — RUNTIME trigger/panel suppression on the VALID F7-off arm.
  // The false-arm pins `active` to benefits (the union forbids 'broadcasts'),
  // so this exercises the production-shaped F7-off render: no broadcasts
  // trigger AND no broadcasts panel. Fails if the component's runtime
  // `props.showBroadcastsTab ?` guard is deleted.
  it('showBroadcastsTab=false (valid arm) → no broadcasts trigger AND no broadcasts panel', () => {
    renderTabs({ showBroadcastsTab: false });
    expect(screen.queryByRole('tab', { name: /broadcasts/i })).toBeNull();
    expect(screen.queryByTestId('bp')).toBeNull();
  });

  // R2-4 facet 3 — DEFENCE-IN-DEPTH. The discriminated union makes
  // `{ showBroadcastsTab: false, active: 'broadcasts' }` a COMPILE error, so a
  // TS caller can never reach this state. But a JS / `any` caller could. Force
  // the illegal combo through with `as never` and prove the component's inner
  // runtime guard STILL suppresses the panel + trigger (robust against a type
  // bypass). If the component's `props.showBroadcastsTab ?` guards were
  // deleted, the panel `bp` would leak here.
  it('showBroadcastsTab=false + active=broadcasts FORCED via cast → inner guard still hides BOTH panel AND trigger', () => {
    renderRaw({
      showBroadcastsTab: false,
      active: BENEFITS_TAB.broadcasts,
      benefitsPanel: benefitsBody,
      broadcastsPanel: <div data-testid="bp">broadcasts panel</div>,
    } as never);
    expect(screen.queryByTestId('bp')).toBeNull();
    expect(screen.queryByRole('tab', { name: /broadcasts/i })).toBeNull();
  });

  // R2-4 facet 4 — POSITIVE CONTROL. Proves the suppression tests above aren't
  // always-null: with the kill-switch ON (showBroadcastsTab=true) and the
  // broadcasts tab active, the panel DOES render.
  it('showBroadcastsTab=true + active=broadcasts → broadcasts panel content IS rendered', () => {
    renderTabs({
      showBroadcastsTab: true,
      active: BENEFITS_TAB.broadcasts,
      broadcastsPanel: <div data-testid="bp">broadcasts panel</div>,
    });
    expect(screen.getByTestId('bp')).toBeInTheDocument();
  });

  it('showBroadcastsTab=false → benefits panel body is still present', () => {
    renderTabs({ showBroadcastsTab: false });
    expect(screen.getByTestId('benefits-body')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // R2-4 facet 1 — COMPILE-TIME kill-switch lock (the new PRIMARY guarantee).
  //
  // These never execute at runtime; the `@ts-expect-error` directives ARE the
  // assertion. If the discriminated union were weakened back to 4 independent
  // fields, these lines would stop erroring and tsc would flag the now-unused
  // `@ts-expect-error` — failing typecheck. That is the compile-time lock.
  // -------------------------------------------------------------------------

  it('TYPE: the illegal { showBroadcastsTab:false, active:"broadcasts" } combo is unrepresentable', () => {
    // Typed identity so each `@ts-expect-error` pins to the precise call line:
    // a whole-object union-assignability failure reports at the call argument,
    // not on an inner property. `accept` is never invoked (compile-only).
    const accept = (_props: BenefitsTabsProps): void => {};

    // The false (F7-off) arm pins `active` to 'benefits' — 'broadcasts' is rejected.
    // @ts-expect-error active is pinned to 'benefits' on the false (F7-off) arm
    accept({
      showBroadcastsTab: false,
      active: BENEFITS_TAB.broadcasts,
      benefitsPanel: benefitsBody,
    });

    // The false (F7-off) arm OMITS `broadcastsPanel` — supplying it is rejected.
    // (Excess-property check reports on the property line, so the directive sits
    // immediately above it rather than on the `accept(` call line.)
    accept({
      showBroadcastsTab: false,
      active: BENEFITS_TAB.benefits,
      benefitsPanel: benefitsBody,
      // @ts-expect-error broadcastsPanel does not exist on the false (F7-off) arm
      broadcastsPanel: <div data-testid="bp" />,
    });

    // The true (F7-on) arm REQUIRES `broadcastsPanel` — omitting it is rejected.
    // @ts-expect-error broadcastsPanel is required on the true (F7-on) arm
    accept({
      showBroadcastsTab: true,
      active: BENEFITS_TAB.broadcasts,
      benefitsPanel: benefitsBody,
    });

    // The @ts-expect-error directives above ARE the assertion; this keeps the
    // test body non-empty and the suite runnable.
    expect(accept).toBeTypeOf('function');
  });

  // -------------------------------------------------------------------------
  // Case 3 — I4 tab navigation: router.replace is asserted (was wired, unread)
  // -------------------------------------------------------------------------

  it('activating the Broadcasts tab navigates to ?tab=broadcasts (replace, no ?page=)', async () => {
    renderTabs({ showBroadcastsTab: true });
    fireEvent.click(screen.getByRole('tab', { name: /broadcasts/i }));
    await waitFor(() =>
      expect(replaceSpy).toHaveBeenCalledWith('/portal/benefits?tab=broadcasts'),
    );
    // History-replace (not push) so Back leaves the Benefits page; and the
    // URL carries ONLY ?tab= — the broadcast-scoped ?page= is dropped.
    expect(replaceSpy).toHaveBeenCalledTimes(1);
  });

  it('activating the Benefits tab navigates to ?tab=benefits (replace, no ?page=)', async () => {
    // Start on the broadcasts tab so clicking Benefits is a real value change.
    renderTabs({ showBroadcastsTab: true, active: BENEFITS_TAB.broadcasts });
    fireEvent.click(screen.getByRole('tab', { name: /benefits/i }));
    await waitFor(() =>
      expect(replaceSpy).toHaveBeenCalledWith('/portal/benefits?tab=benefits'),
    );
    expect(replaceSpy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Case 4 — tab labels resolve against real en.json (no MISSING_MESSAGE)
  // -------------------------------------------------------------------------

  it('tab labels resolve from real en.json — no raw key strings rendered', () => {
    renderTabs({ showBroadcastsTab: true });
    // If t() produced a raw key string, the tab text would contain 'benefits'
    // or 'broadcasts' literally but NOT as capitalized display strings.
    // Assert the resolved labels match the canonical en.json values.
    expect(screen.getByRole('tab', { name: 'Benefits' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Broadcasts' })).toBeInTheDocument();
  });
});
