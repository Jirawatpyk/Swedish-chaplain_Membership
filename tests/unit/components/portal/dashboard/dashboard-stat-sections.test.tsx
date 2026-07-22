/**
 * 057 D1 review finding A2 — real-en.json render tests for the three Dashboard
 * stat sections (one assertion per `stat.kind`) + the page first-run branch.
 *
 * Why: next-intl is normally mocked as an identity fn `(key) => key` in unit
 * tests, so a mistyped/renamed t('key') silently renders the key string and the
 * test still passes — the MISSING_MESSAGE class that has bitten this project
 * twice. These tests back `getTranslations` with the REAL en.json (a dangling
 * ref renders "MISSING_KEY:<ns>.<key>") and drive every `stat.kind` so EVERY
 * rendered key in the sections is resolved at least once. Pairs with the
 * parity lock in i18n-keys.test.tsx (keys present in all 3 locales).
 *
 * Approach mirrors dashboard-loading.test.tsx: async RSC bodies are invoked
 * directly and rendered with renderToStaticMarkup. The read layer
 * (`dashboard-reads`) is mocked so each branch is driven deterministically;
 * the REAL `deriveXStat` + REAL `StatCard` + REAL translator run, so the
 * assertions exercise the actual key-rendering code path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import en from '@/i18n/messages/en.json';
import { env } from '@/lib/env';
import type { RenewalCycle } from '@/modules/renewals';
import type { BenefitUsage } from '@/modules/insights';
import type { DashboardOutstandingRead } from '@/app/(member)/portal/_components/dashboard-reads';

type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined),
    obj,
  );
}

function makeRealTranslator(ns: string) {
  return (key: string, params?: Record<string, unknown>): string => {
    const nsObj = getPath(en as unknown, ns);
    if (!nsObj) return `MISSING_NS:${ns}`;
    const val = getPath(nsObj, key);
    if (val === undefined || val === null) return `MISSING_KEY:${ns}.${key}`;
    if (typeof val !== 'string') return `NOT_STRING:${ns}.${key}`;
    if (!params) return val;
    // Minimal ICU: {name}, {days}, {amount}, {date}, and {count, plural, ...}.
    let out = val.replace(
      /\{(\w+),\s*plural,\s*([^}]*(?:\{[^}]*\}[^}]*)*)\}/g,
      (_, k: string, body: string) => {
        const n = Number(params[k] ?? 0);
        const form = n === 1 ? 'one' : 'other';
        const m = new RegExp(`${form}\\s*\\{([^}]*)\\}`).exec(body);
        const text = m?.[1] ?? '';
        return text.replace(/#/g, String(n));
      },
    );
    out = out.replace(/\{(\w+)[^}]*\}/g, (_, k: string) =>
      params[k] !== undefined ? String(params[k]) : `{${k}}`,
    );
    return out;
  };
}

// --- mocks ----------------------------------------------------------------

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => makeRealTranslator(ns)),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

const renewalRead = vi.fn();
const outstandingRead = vi.fn();
const benefitRead = vi.fn();

vi.mock('@/app/(member)/portal/_components/dashboard-reads', () => ({
  loadDashboardRenewalCycle: (...a: unknown[]) => renewalRead(...a),
  loadDashboardOutstanding: (...a: unknown[]) => outstandingRead(...a),
  loadDashboardBenefitUsage: (...a: unknown[]) => benefitRead(...a),
}));

import { MembershipStatSection } from '@/app/(member)/portal/_components/membership-stat-section';
import { OutstandingStatSection } from '@/app/(member)/portal/_components/outstanding-stat-section';
import { BenefitsStatSection } from '@/app/(member)/portal/_components/benefits-stat-section';

const TENANT_CTX = { slug: 'tenant-a' } as never;

async function renderMembership(): Promise<string> {
  const tree = await MembershipStatSection({ tenantId: 'tenant-a', memberId: 'm1' });
  return renderToStaticMarkup(tree as ReactElement);
}
async function renderOutstanding(): Promise<string> {
  const tree = await OutstandingStatSection({ tenantId: 'tenant-a', memberId: 'm1' });
  return renderToStaticMarkup(tree as ReactElement);
}
async function renderBenefits(): Promise<string> {
  const tree = await BenefitsStatSection({ ctx: TENANT_CTX, memberId: 'm1' });
  return renderToStaticMarkup(tree as ReactElement);
}

function cycle(overrides: Partial<RenewalCycle>): RenewalCycle {
  return {
    tenantId: 't',
    cycleId: 'c1',
    memberId: 'm1',
    status: 'awaiting_payment',
    periodFrom: '2026-01-01T00:00:00.000Z',
    periodTo: '2026-12-31T00:00:00.000Z',
    expiresAt: '2026-12-31T00:00:00.000Z',
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular',
    planIdAtCycleStart: 'p1',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB',
    createdAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    closedReason: null,
    ...overrides,
  } as RenewalCycle;
}

function outstanding(overrides: Partial<DashboardOutstandingRead>): DashboardOutstandingRead {
  return { inputs: [], total: 0, partial: false, error: false, ...overrides };
}

// 059-membership-suspension — `MembershipStatSection` now ALSO calls
// `loadDashboardOutstanding` (mocked as `outstandingRead`) whenever the
// derived stat is `suspended`, to find an unpaid membership invoice for the
// smart CTA. Default every test to an empty (invoice-less) read so tests
// that don't care about the invoice-linking branch don't have to mock it
// themselves; the dedicated CTA tests below override with
// `.mockResolvedValueOnce`.
beforeEach(() => {
  outstandingRead.mockReset();
  outstandingRead.mockResolvedValue(outstanding({}));
});

function usage(overrides: Partial<BenefitUsage>): BenefitUsage {
  return {
    membershipYear: 2026,
    elapsedYearPct: 50,
    quantifiable: [],
    active: [],
    aggregateConsumedPct: null,
    gapPct: null,
    underUseWarning: false,
    ...overrides,
  };
}

const noMissing = (html: string) => {
  expect(html).not.toContain('MISSING_KEY:');
  expect(html).not.toContain('MISSING_NS:');
  expect(html).not.toContain('NOT_STRING:');
};

describe('MembershipStatSection — every stat.kind resolves real en keys', () => {
  beforeEach(() => renewalRead.mockReset());

  it('empty (no cycle)', async () => {
    renewalRead.mockResolvedValue(null);
    const html = await renderMembership();
    noMissing(html);
    expect(html).toContain(en.portal.dashboard.membership.emptyValue);
  });

  it('error (read failed)', async () => {
    renewalRead.mockResolvedValue('error');
    const html = await renderMembership();
    noMissing(html);
    expect(html).toContain(en.portal.dashboard.membership.errorValue);
  });

  it('active (far off / completed)', async () => {
    renewalRead.mockResolvedValue(cycle({ status: 'completed', expiresAt: '2030-12-31T00:00:00.000Z' }));
    const html = await renderMembership();
    noMissing(html);
    expect(html).toContain(en.portal.dashboard.membership.activeValue);
  });

  it('due (renew-soon within threshold, not yet invoiced) — informational headline', async () => {
    // 059-membership-suspension — `awaiting_payment` now ALWAYS resolves to
    // `suspended` (see below), so the `due` state now only applies to the
    // pre-invoice `upcoming`/`reminded` statuses.
    // plan-change-ux seam 2 — that whole `due` cohort is NOT yet payable, so
    // the card shows the DESCRIPTIVE `renewUpcomingValue` headline (not the
    // imperative `renewDueValue`), which is reserved for the payable state
    // that also carries the "Renew now" button.
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
    renewalRead.mockResolvedValue(cycle({ status: 'upcoming', expiresAt: soon }));
    const html = await renderMembership();
    noMissing(html);
    expect(html).toContain(en.portal.dashboard.membership.renewUpcomingValue);
    expect(html).not.toContain(en.portal.dashboard.membership.renewDueValue);
  });

  it('suspended, reason unpaid (expired non-terminal cycle, no invoice on file yet)', async () => {
    // 059-membership-suspension — the old destructive `overdue` state (an
    // expired-but-non-terminal cycle) is now `suspended`/`unpaid` (amber,
    // not red). No invoice is mocked, so the copy falls back to the
    // no-due-date variant and the smart CTA links to the self-serve renewal
    // flow.
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    renewalRead.mockResolvedValue(cycle({ status: 'upcoming', expiresAt: past }));
    const html = await renderMembership();
    noMissing(html);
    expect(html).toContain(en.portal.dashboard.membership.suspended.unpaidValue);
    expect(html).toContain(en.portal.dashboard.membership.suspended.unpaidSubNoDueDate);
  });

  it('suspended, reason pending_review (paid, awaiting admin verification)', async () => {
    renewalRead.mockResolvedValue(
      cycle({
        status: 'pending_admin_reactivation',
        enteredPendingAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    const html = await renderMembership();
    noMissing(html);
    expect(html).toContain(en.portal.dashboard.membership.suspended.pendingReviewValue);
    // React HTML-escapes the apostrophe in "We're" — check a substring either side of it.
    expect(html).toContain('verifying your payment');
  });

  it('lapsed (terminal, ended)', async () => {
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    renewalRead.mockResolvedValue(cycle({ status: 'lapsed', expiresAt: past }));
    const html = await renderMembership();
    noMissing(html);
    expect(html).toContain(en.portal.dashboard.membership.lapsedValue);
  });
});

/**
 * 067 I5(a) — the in-portal "Renew now" CTA gating per `stat.kind`.
 *
 * The CTA links to /portal/renewal/[memberId] (the in-portal renewal flow).
 *
 * plan-change-ux seam 2 — the button is now gated on the SAME payability
 * predicate the renewal page uses (`shouldOfferRenewNow` → `isRenewalPayable`),
 * NOT on `stat.kind` alone. A `due` card (an `upcoming`/`reminded` cycle whose
 * period has NOT yet ended) is NOT yet payable — the page answers "renewal
 * window not yet open" — so the button is WITHHELD and the card shows only the
 * informational countdown. The button surfaces once the cycle is genuinely
 * payable; at that point the cycle is `suspended`, which carries its OWN
 * "pay to restore" CTA (covered below). `lapsed` remains a load-bearing
 * ABSENT case: that route's `findActiveForMember` rejects terminal cycles →
 * redirect('/portal'), a dead-end. `renderMembership()` uses memberId 'm1' →
 * href /portal/renewal/m1.
 */
describe('MembershipStatSection — renew-now CTA gating per stat.kind', () => {
  beforeEach(() => renewalRead.mockReset());

  const RENEW_HREF = '/portal/renewal/m1';
  const RENEW_LABEL = en.portal.dashboard.membership.renewNow; // "Renew now"

  function expectCta(html: string, present: boolean): void {
    noMissing(html);
    if (present) {
      expect(html).toContain(`href="${RENEW_HREF}"`);
      expect(html).toContain(RENEW_LABEL);
      // Cluster 4 a11y review-fix — the internal renew-now <Link> CTA carries
      // the ≥44px (min-h-11) tap target (buttonVariants size:'sm' is h-7/28px).
      expect(html).toContain('min-h-11');
    } else {
      expect(html).not.toContain(`href="${RENEW_HREF}"`);
      expect(html).not.toContain(RENEW_LABEL);
    }
  }

  it('due (upcoming, not yet payable) → NO renew-now CTA; shows the informational countdown instead', async () => {
    // plan-change-ux seam 2 — the whole `due` cohort is an `upcoming`/
    // `reminded` cycle whose period has NOT yet ended, so the renewal page is
    // NOT yet payable (it answers "renewal window not yet open"). The dashboard
    // must therefore WITHHOLD the "Renew now" button (it would dead-end) and
    // show only the informational "Renewal upcoming" headline + countdown. The
    // button returns once the cycle is genuinely payable — at which point the
    // cycle is `suspended` and carries its own pay-CTA (covered above).
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
    renewalRead.mockResolvedValue(cycle({ status: 'upcoming', expiresAt: soon }));
    const html = await renderMembership();
    expectCta(html, false);
    // The card still communicates the due state — but with the DESCRIPTIVE
    // informational headline (no button), never the imperative "Renew soon".
    expect(html).toContain(en.portal.dashboard.membership.renewUpcomingValue);
  });

  it('suspended (unpaid, no invoice on file) → smart CTA links to self-serve renewal, labelled "Pay to restore benefits"', async () => {
    // 059-membership-suspension — an expired non-terminal cycle is now
    // `suspended`, not `overdue`; the CTA label changes to the suspended
    // pay-CTA (NOT "Renew now") even though the href is the same renewal
    // route, because no unpaid membership invoice is on file yet.
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    renewalRead.mockResolvedValue(cycle({ status: 'upcoming', expiresAt: past }));
    const html = await renderMembership();
    noMissing(html);
    expect(html).toContain(`href="${RENEW_HREF}"`);
    expect(html).toContain(en.portal.dashboard.membership.suspended.payCta);
    expect(html).not.toContain(RENEW_LABEL);
    expect(html).toContain('min-h-11');
  });

  it('suspended (unpaid, invoice on file) → smart CTA links to the specific invoice instead', async () => {
    outstandingRead.mockResolvedValueOnce(
      outstanding({
        inputs: [
          { status: 'issued', totalSatang: 100_00n, dueDate: '2026-06-30', id: 'inv-abc', invoiceSubject: 'membership' },
        ],
        total: 1,
      }),
    );
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    renewalRead.mockResolvedValue(cycle({ status: 'upcoming', expiresAt: past }));
    const html = await renderMembership();
    noMissing(html);
    expect(html).toContain('href="/portal/invoices/inv-abc"');
    expect(html).not.toContain(`href="${RENEW_HREF}"`);
    expect(html).toContain(en.portal.dashboard.membership.suspended.payCta);
  });

  it('suspended (pending_review) → NO CTA at all (member already paid)', async () => {
    renewalRead.mockResolvedValue(
      cycle({
        status: 'pending_admin_reactivation',
        enteredPendingAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    const html = await renderMembership();
    noMissing(html);
    expect(html).not.toContain(en.portal.dashboard.membership.suspended.payCta);
    expect(html).not.toContain(`href="${RENEW_HREF}"`);
  });

  it('lapsed → NO renew-now CTA (terminal cycle → route redirect dead-end)', async () => {
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    renewalRead.mockResolvedValue(cycle({ status: 'lapsed', expiresAt: past }));
    expectCta(await renderMembership(), false);
  });

  it('lapsed → renders a contact-support mailto affordance (Cluster 4 — real next step, not a dead renew promise)', async () => {
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    renewalRead.mockResolvedValue(cycle({ status: 'lapsed', expiresAt: past }));
    const html = await renderMembership();
    noMissing(html);
    // A real mailto CTA (not the /portal/renewal dead-end) with the localized
    // "Contact us to reactivate" label. The address is deployment config
    // (`SUPPORT_EMAIL`, default info@swecham.se) — assert against the SAME
    // single-source-of-truth the component uses (`env.supportEmail`) rather
    // than a hardcoded address, so a per-deploy override (e.g. secretary@)
    // does not break this test.
    expect(html).toContain(`href="mailto:${env.supportEmail}`);
    expect(html).toContain(en.portal.dashboard.membership.contactToRenew);
    // Cluster 4 a11y review-fix — the external mailto <a> CTA carries the
    // ≥44px (min-h-11) tap target on the same footing as the internal <Link>.
    expect(html).toContain('min-h-11');
    // And NOT the self-serve renewal href (there is no member self-serve path).
    expect(html).not.toContain(`href="${RENEW_HREF}"`);
  });

  it('due → NO contact-support mailto (informational countdown, never the lapsed mailto path)', async () => {
    // The `due` card shows no button at all (seam 2) — and in particular NOT
    // the lapsed-cohort mailto affordance.
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
    renewalRead.mockResolvedValue(cycle({ status: 'upcoming', expiresAt: soon }));
    const html = await renderMembership();
    noMissing(html);
    expect(html).not.toContain('mailto:info@swecham.se');
  });

  it('active → NO renew-now CTA (not due yet)', async () => {
    renewalRead.mockResolvedValue(
      cycle({ status: 'completed', expiresAt: '2030-12-31T00:00:00.000Z' }),
    );
    expectCta(await renderMembership(), false);
  });

  it('empty (no cycle) → NO renew-now CTA', async () => {
    renewalRead.mockResolvedValue(null);
    expectCta(await renderMembership(), false);
  });

  it('error (read failed) → NO renew-now CTA', async () => {
    renewalRead.mockResolvedValue('error');
    expectCta(await renderMembership(), false);
  });
});

describe('OutstandingStatSection — every stat.kind resolves real en keys', () => {
  beforeEach(() => outstandingRead.mockReset());

  it('error (read failed)', async () => {
    outstandingRead.mockResolvedValue(outstanding({ error: true }));
    const html = await renderOutstanding();
    noMissing(html);
    expect(html).toContain(en.portal.dashboard.outstanding.errorValue);
  });

  it('clear (nothing owed)', async () => {
    outstandingRead.mockResolvedValue(outstanding({ inputs: [], total: 0 }));
    const html = await renderOutstanding();
    noMissing(html);
    expect(html).toContain(en.portal.dashboard.outstanding.clearValue);
  });

  it('due (owing, none past-due) — resolves dueSub + countSub', async () => {
    outstandingRead.mockResolvedValue(
      outstanding({
        inputs: [{ status: 'issued', totalSatang: 100_00n, dueDate: '2099-12-31', id: 'inv-1', invoiceSubject: 'membership' }],
        total: 1,
      }),
    );
    const html = await renderOutstanding();
    noMissing(html);
    // Earliest due present → dueSub form rendered; non-partial value.
    expect(html).toContain('Earliest due');
  });

  it('overdue (past-due present) — resolves overdueSub variantLabel', async () => {
    outstandingRead.mockResolvedValue(
      outstanding({
        inputs: [{ status: 'issued', totalSatang: 53_50n, dueDate: '2000-01-01', id: 'inv-2', invoiceSubject: 'membership' }],
        total: 1,
      }),
    );
    const html = await renderOutstanding();
    noMissing(html);
    expect(html).toContain('overdue invoice');
  });

  it('overdue + partial — resolves valuePartial + overdueSubPartial', async () => {
    outstandingRead.mockResolvedValue(
      outstanding({
        inputs: [{ status: 'issued', totalSatang: 53_50n, dueDate: '2000-01-01', id: 'inv-3', invoiceSubject: 'membership' }],
        total: 999, // clipped → partial floor
        partial: true,
      }),
    );
    const html = await renderOutstanding();
    noMissing(html);
    expect(html).toContain('or more overdue');
  });

  it('due + partial (no due date) — resolves countSubPartial', async () => {
    outstandingRead.mockResolvedValue(
      outstanding({
        inputs: [{ status: 'issued', totalSatang: 100_00n, dueDate: null, id: 'inv-4', invoiceSubject: 'membership' }],
        total: 999,
        partial: true,
      }),
    );
    const html = await renderOutstanding();
    noMissing(html);
    expect(html).toContain('or more unpaid');
  });
});

describe('BenefitsStatSection — every stat.kind resolves real en keys', () => {
  beforeEach(() => benefitRead.mockReset());

  it('error (compute failed sentinel)', async () => {
    benefitRead.mockResolvedValue('error');
    const html = await renderBenefits();
    noMissing(html);
    expect(html).toContain(en.portal.dashboard.benefits.errorValue);
  });

  it('empty (null benign no-plan)', async () => {
    benefitRead.mockResolvedValue(null);
    const html = await renderBenefits();
    noMissing(html);
    expect(html).toContain(en.portal.dashboard.benefits.emptyValue);
  });

  it('on-track (keeping pace)', async () => {
    benefitRead.mockResolvedValue(
      usage({ elapsedYearPct: 50, quantifiable: [{ key: 'eblast', used: 3, entitlement: 5, lastUsedAt: null }] }),
    );
    const html = await renderBenefits();
    noMissing(html);
    expect(html).toContain(en.portal.dashboard.benefits.onTrackValue);
  });

  it('under-use (lagging benefit) — resolves underUseValue plural', async () => {
    benefitRead.mockResolvedValue(
      usage({ elapsedYearPct: 80, quantifiable: [{ key: 'eblast', used: 0, entitlement: 5, lastUsedAt: null }] }),
    );
    const html = await renderBenefits();
    noMissing(html);
    expect(html).toContain('under-used');
  });
});
