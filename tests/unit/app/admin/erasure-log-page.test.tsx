/**
 * Spec 122 US10b (T1017; boards `Admin-erasure-log`, `Admin-state-erasure-breach`)
 * — the erasure-log frame on AURA: the breach banner and the all-clear notice
 * are AURA alerts (the breach still announced as an alert), and the empty
 * state sits in an AURA card with its test id. What each state says, and when,
 * is today's.
 *
 * The async RSC default export is invoked directly with mocked boundaries and
 * rendered with renderToStaticMarkup (as audit-page-load-error.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import en from '@/i18n/messages/en.json';

type Messages = Record<string, unknown>;
const getPath = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined), obj);
function makeRealTranslator(ns: string) {
  return (key: string, params?: Record<string, unknown>): string => {
    const val = getPath(getPath(en as unknown, ns), key);
    if (typeof val !== 'string') return `MISSING_KEY:${ns}.${key}`;
    if (!params) return val;
    // ICU plural → the `other` arm, enough for these assertions
    const flat = val.replace(/\{(\w+), plural,[^{]*(?:\{[^}]*\}[^{]*)*other \{([^}]*)\}\}/g, (_, k: string, other: string) =>
      other.replace('#', String(params[k])),
    );
    return flat.replace(/\{(\w+)\}/g, (_, k: string) => (params[k] !== undefined ? String(params[k]) : `{${k}}`));
  };
}

const { logMock } = vi.hoisted(() => ({ logMock: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => makeRealTranslator(ns)),
  getLocale: vi.fn().mockResolvedValue('en'),
}));
vi.mock('@/lib/rbac', () => ({ requirePagePermission: vi.fn().mockResolvedValue({ user: { id: 'u1' } }) }));
vi.mock('@/lib/env', () => ({ env: { tenant: { timezone: 'Asia/Bangkok' } } }));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromRequest: () => ({ slug: 'tenant-a' }) }));
vi.mock('@/modules/insights', () => ({
  getErasureEvidenceLog: (...args: unknown[]) => logMock(...args),
  makeGetErasureEvidenceLogDeps: () => ({}),
  DEFAULT_DISPLAY_CAP: 200,
}));
vi.mock('@/modules/members', () => ({
  resolveMemberNumberPrefix: async () => 'SCCM',
  drizzleMemberSettingsRepo: {},
  parseMemberNumberQuery: () => null,
  formatMemberNumber: (p: string, n: number) => `${p}-${String(n).padStart(4, '0')}`,
  asMemberNumber: (n: number) => n,
}));
// Client / hook components — irrelevant to the frame these tests assert.
vi.mock('@/app/(staff)/admin/compliance/erasure-log/_components/erasure-filter-tabs', () => ({ ErasureFilterTabs: () => null }));
vi.mock('@/app/(staff)/admin/compliance/erasure-log/_components/erasure-search-form', () => ({ ErasureSearchForm: () => null }));
vi.mock('@/app/(staff)/admin/compliance/erasure-log/_components/evidence-card', () => ({
  EvidenceCard: () => <div data-testid="evidence-card" />,
}));

import ErasureLogPage from '@/app/(staff)/admin/compliance/erasure-log/page';

async function renderPage(searchParams: Record<string, string> = {}): Promise<HTMLElement> {
  const tree = await ErasureLogPage({ searchParams: Promise.resolve(searchParams) });
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(tree as ReactElement);
  return root;
}

/** The innermost element whose text includes `text`. */
function holding(root: HTMLElement, text: string): HTMLElement {
  const all = Array.from(root.querySelectorAll<HTMLElement>('*')).filter((el) => el.textContent?.includes(text));
  expect(all.length, `"${text.slice(0, 40)}" is on the page`).toBeGreaterThan(0);
  return all.at(-1)!;
}

const e = en.admin.compliance.erasureLog;
const summary = (over: Partial<{ total: number; overdue: number; inProgress: number; complete: number }> = {}) => ({
  total: 2,
  overdue: 0,
  inProgress: 0,
  complete: 2,
  ...over,
});
const row = { memberId: 'm1' };

beforeEach(() => logMock.mockReset());

describe('ErasureLogPage on AURA', () => {
  it('the breach banner is an AURA danger alert, announced as an alert', async () => {
    logMock.mockResolvedValue({ rows: [row], summary: summary({ overdue: 1, total: 1, complete: 0 }), capped: false });
    const root = await renderPage();
    const alert = holding(root, '1 erasure').closest('.aura-alert')!;
    expect(alert).not.toBeNull();
    expect(alert).toHaveAttribute('role', 'alert');
  });

  it('the all-clear notice is an AURA alert', async () => {
    logMock.mockResolvedValue({ rows: [row, row], summary: summary(), capped: false });
    const root = await renderPage();
    expect(holding(root, e.allClear).closest('.aura-alert')).not.toBeNull();
  });

  it('the empty state sits in an AURA card, keeping its test id', async () => {
    logMock.mockResolvedValue({ rows: [], summary: summary({ total: 0, complete: 0 }), capped: false });
    const root = await renderPage();
    expect(root.querySelector('[data-testid="erasure-log-empty"]')!.closest('.aura-card')).not.toBeNull();
  });
});
