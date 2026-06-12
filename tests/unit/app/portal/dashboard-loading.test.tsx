/**
 * 057 — portal/loading.tsx render test using the real en.json.
 *
 * Motivation: next-intl is normally mocked as an identity function
 * `(key) => key` in unit tests, which means a mistyped t('missingKey')
 * silently renders the key string and the test still passes. This test
 * replaces getTranslations with a resolver backed by the real
 * `src/i18n/messages/en.json` so a dangling reference produces
 * `"MISSING_KEY:<ns>.<key>"` in the output, which the assertion catches.
 *
 * Server component approach: async RSC bodies can be called directly
 * (no render framework needed). The pattern mirrors portal-profile-body.test.tsx.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

// ---------------------------------------------------------------------------
// Real-en.json translator factory
// ---------------------------------------------------------------------------

import en from '@/i18n/messages/en.json';

type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, k) =>
      acc && typeof acc === 'object'
        ? (acc as Messages)[k]
        : undefined,
    obj,
  );
}

/**
 * Creates a translator bound to a namespace that resolves against the
 * real en.json. Missing keys are returned as "MISSING_KEY:<ns>.<key>"
 * strings rather than throwing, so the test can assert on the output.
 */
function makeRealTranslator(ns: string) {
  return (key: string, params?: Record<string, unknown>): string => {
    const nsObj = getPath(en as unknown, ns);
    if (!nsObj) return `MISSING_NS:${ns}`;
    const val = getPath(nsObj, key);
    if (val === undefined || val === null) return `MISSING_KEY:${ns}.${key}`;
    if (typeof val !== 'string') return `NOT_STRING:${ns}.${key}`;
    if (!params) return val;
    return val.replace(
      /\{(\w+)[^}]*\}/g,
      (_, k: string) =>
        params[k] !== undefined ? String(params[k]) : `{${k}}`,
    );
  };
}

// ---------------------------------------------------------------------------
// Mocks — block infra so loading.tsx can run in a pure unit context
// ---------------------------------------------------------------------------

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({} as unknown),
}));

// getTranslations is backed by the real en.json so dangling t() refs
// surface as "MISSING_KEY:" strings instead of passing silently.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) =>
    makeRealTranslator(ns),
  ),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));

import PortalDashboardLoading from '@/app/(member)/portal/(home)/loading';

describe('portal/loading.tsx — CLS-stable skeleton (057 redesign)', () => {
  it('renders without any MISSING_KEY or MISSING_NS references', async () => {
    const tree = await PortalDashboardLoading();
    const html = renderToStaticMarkup(tree as ReactElement);
    // If any t('key') call references a non-existent key the real translator
    // embeds "MISSING_KEY:<ns>.<key>" in the output — assert none are present.
    expect(html).not.toContain('MISSING_KEY:');
    expect(html).not.toContain('MISSING_NS:');
    expect(html).not.toContain('NOT_STRING:');
  });

  it('contains a role=status live region for screen-reader announcement', async () => {
    const tree = await PortalDashboardLoading();
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).toContain('role="status"');
  });

  it('renders exactly 3 stat-card skeletons (matching the 3-up stat grid)', async () => {
    const tree = await PortalDashboardLoading();
    const html = renderToStaticMarkup(tree as ReactElement);
    // StatSkeleton renders CardContent with class "flex flex-col gap-2 py-5"
    // — one per stat card. Three independent instances = three occurrences.
    const statMatches = html.match(/flex flex-col gap-2 py-5/g);
    expect(statMatches).toHaveLength(3);
  });

  it('renders the 2-col panel skeleton cards (invoices + benefits)', async () => {
    const tree = await PortalDashboardLoading();
    const html = renderToStaticMarkup(tree as ReactElement);
    // The 2-col panel uses lg:grid-cols-2. Both panel cards are aria-hidden
    // (stat cards + panel cards = ≥5 aria-hidden occurrences).
    const ariaHiddenCount = (html.match(/aria-hidden="true"/g) ?? []).length;
    expect(ariaHiddenCount).toBeGreaterThanOrEqual(5);
  });

  it('uses portal.dashboard.intro as the subtitle — real en.json text, no MISSING_KEY', async () => {
    const tree = await PortalDashboardLoading();
    const html = renderToStaticMarkup(tree as ReactElement);
    // "Here's your membership at a glance." — from the real en.json.
    // renderToStaticMarkup HTML-encodes the apostrophe as &#x27;
    expect(html).toContain('Here&#x27;s your membership at a glance.');
  });
});
