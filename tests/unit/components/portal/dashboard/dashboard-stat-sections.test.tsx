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

  it('due (renew-soon within threshold)', async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
    renewalRead.mockResolvedValue(cycle({ status: 'awaiting_payment', expiresAt: soon }));
    const html = await renderMembership();
    noMissing(html);
    expect(html).toContain(en.portal.dashboard.membership.renewDueValue);
  });

  it('overdue (expired, non-terminal)', async () => {
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    renewalRead.mockResolvedValue(cycle({ status: 'awaiting_payment', expiresAt: past }));
    const html = await renderMembership();
    noMissing(html);
    expect(html).toContain(en.portal.dashboard.membership.overdueValue);
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
 * The CTA links to /portal/renewal/[memberId] (the in-portal renewal flow). It
 * MUST appear ONLY for the renewable cohort (`due`/`overdue` — a non-terminal
 * cycle that route can actually resolve) and MUST be ABSENT for everything
 * else. `lapsed` is the load-bearing case: that route's `findActiveForMember`
 * rejects terminal cycles → redirect('/portal'), a dead-end, so offering the
 * button there would no-op. These assertions FAIL if `lapsed` (or any terminal
 * kind) were re-added to the `renewable` predicate, locking the just-fixed
 * dead-end. `renderMembership()` uses memberId 'm1' → href /portal/renewal/m1.
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
    } else {
      expect(html).not.toContain(`href="${RENEW_HREF}"`);
      expect(html).not.toContain(RENEW_LABEL);
    }
  }

  it('due → renders the renew-now link to /portal/renewal/[memberId]', async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
    renewalRead.mockResolvedValue(cycle({ status: 'awaiting_payment', expiresAt: soon }));
    expectCta(await renderMembership(), true);
  });

  it('overdue → renders the renew-now link', async () => {
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    renewalRead.mockResolvedValue(cycle({ status: 'awaiting_payment', expiresAt: past }));
    expectCta(await renderMembership(), true);
  });

  it('lapsed → NO renew-now CTA (terminal cycle → route redirect dead-end)', async () => {
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    renewalRead.mockResolvedValue(cycle({ status: 'lapsed', expiresAt: past }));
    expectCta(await renderMembership(), false);
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
        inputs: [{ status: 'issued', totalSatang: 100_00n, dueDate: '2099-12-31' }],
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
        inputs: [{ status: 'issued', totalSatang: 53_50n, dueDate: '2000-01-01' }],
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
        inputs: [{ status: 'issued', totalSatang: 53_50n, dueDate: '2000-01-01' }],
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
        inputs: [{ status: 'issued', totalSatang: 100_00n, dueDate: null }],
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
