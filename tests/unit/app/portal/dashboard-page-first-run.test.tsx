/**
 * 057 D1 review finding A2 — real-en.json render test for the Dashboard page
 * first-run / not-linked branch.
 *
 * When the session user is not linked to a member (`findByLinkedUserId` !ok),
 * the page renders a friendly localised empty hub BEFORE any stat section runs.
 * ~131 launch invitees all land here first, so a dangling t() ref here would
 * crash the very first member-facing screen. getTranslations is backed by the
 * real en.json so a missing key renders "MISSING_KEY:" (mirrors
 * dashboard-loading.test.tsx); the assertion catches it.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import en from '@/i18n/messages/en.json';

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
    return val.replace(/\{(\w+)[^}]*\}/g, (_, k: string) =>
      params[k] !== undefined ? String(params[k]) : `{${k}}`,
    );
  };
}

// --- mocks (block infra; the not-linked branch returns before sections) ----

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => makeRealTranslator(ns)),
}));

vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({
    user: { id: 'u1', email: 'invitee@example.com', displayName: 'Pat Invitee' },
  }),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));

// Not-linked: findByLinkedUserId returns !ok so the page renders the first-run
// empty hub and never reaches the member-number / stat-section path.
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: { findByLinkedUserId: vi.fn().mockResolvedValue({ ok: false }) },
    memberSettings: {},
  }),
}));

import MemberPortalHomePage from '@/app/(member)/portal/page';

describe('MemberPortalHomePage — first-run / not-linked branch (finding A2)', () => {
  it('renders the localised first-run hub with no MISSING_KEY refs', async () => {
    const tree = await MemberPortalHomePage();
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).not.toContain('MISSING_KEY:');
    expect(html).not.toContain('MISSING_NS:');
    expect(html).not.toContain('NOT_STRING:');
    // firstRun.exploreBenefits CTA + firstRun.body copy are present.
    expect(html).toContain(en.portal.dashboard.firstRun.exploreBenefits);
    expect(html).toContain(en.portal.dashboard.firstRun.body);
  });

  it('resolves the welcome greeting with the user display name', async () => {
    const tree = await MemberPortalHomePage();
    const html = renderToStaticMarkup(tree as ReactElement);
    // welcome = "Hi {name}" → "Hi Pat Invitee"
    expect(html).toContain('Pat Invitee');
  });
});
