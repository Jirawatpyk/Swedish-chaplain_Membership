/**
 * Spec 122 US10b (T1013) — the /admin/audit frame on AURA: Export CSV as an
 * AURA button link (same href), the list in an AURA card with the count in
 * the filter bar (no second sr-only count), the board's retention line under
 * the table, and the keyset pager as AURA button links.
 *
 * Harness copied from audit-page-load-error.test.tsx:
 *
 * The page used to map every non-`forbidden` outcome of the audit read to the
 * "Invalid filter" card, and a THROWN read (Neon outage, pool exhaustion) fell
 * out of the page entirely. Either way an infrastructure failure never said
 * "we couldn't load this" — it told the admin their filter was wrong, or gave
 * them a generic boundary with no audit context.
 *
 * Contract pinned here:
 *   - a thrown repo error → the shared load-error card ("Couldn't load the
 *     audit log…", Try again + Go back, a reference id) and an error log that
 *     carries the errorId + the same reference id;
 *   - a genuine validation failure (`invalid_range`, or a malformed URL param
 *     caught before the read) → "Invalid filter", naming the offending field.
 *
 * The async RSC default export is invoked directly with mocked boundaries and
 * rendered with renderToStaticMarkup (same approach as
 * portal-invoices-page-errors.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import en from '@/i18n/messages/en.json';

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
  const t = (key: string, params?: Record<string, unknown>): string => {
    const val = getPath(getPath(en as unknown, ns), key);
    if (typeof val !== 'string') return `MISSING_KEY:${ns}.${key}`;
    if (!params) return val;
    return val.replace(/\{(\w+)[^}]*\}/g, (_, k: string) =>
      params[k] !== undefined ? String(params[k]) : `{${k}}`,
    );
  };
  // `resolveEventLabel` asks the translator whether a key exists.
  return Object.assign(t, { has: (key: string) => typeof getPath(getPath(en as unknown, ns), key) === 'string' });
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/**
 * renderToStaticMarkup escapes `'` / `"` / `&` — decode them so copy like
 * "Couldn't load…" is matched literally (otherwise every `not.toContain` on
 * such copy would pass vacuously).
 */
function decodeEntities(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// --- mocks ----------------------------------------------------------------

const { errorSpy, warnSpy, auditQueryMock } = vi.hoisted(() => ({
  errorSpy: vi.fn(),
  warnSpy: vi.fn(),
  auditQueryMock: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: (...args: unknown[]) => errorSpy(...args),
    warn: (...args: unknown[]) => warnSpy(...args),
    info: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => makeRealTranslator(ns)),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

vi.mock('@/lib/rbac', () => ({
  requirePagePermission: vi.fn().mockResolvedValue({ user: { id: 'u1', role: 'super_admin' } }),
}));

vi.mock('@/lib/env', () => ({
  env: { features: { f9Dashboard: true }, tenant: { timezone: 'Asia/Bangkok' } },
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));

vi.mock('@/modules/auth', () => ({
  ALL_AUDIT_EVENT_TYPES: ['user_signed_in', 'invoice_issued'],
}));

vi.mock('@/modules/broadcasts', () => ({
  RETIRED_F7_AUDIT_EVENT_TYPES: [],
}));

vi.mock('@/modules/insights', () => ({
  auditQuery: (...args: unknown[]) => auditQueryMock(...args),
  makeAuditQueryDeps: () => ({}),
}));

// Client components (next-intl react-client hooks have no provider under
// renderToStaticMarkup) — irrelevant to what these tests assert.
vi.mock('@/components/audit/audit-filters', () => ({
  AuditFilters: (p: { resultCount?: number }) => (
    <div data-testid="audit-filters" data-count={p.resultCount ?? 'none'} />
  ),
}));
vi.mock('@/components/audit/audit-table', () => ({ AuditTable: () => null }));
vi.mock('@/components/dashboard/dashboard-error-state', () => ({
  DashboardErrorState: ({ title, description }: { title: string; description: string }) => (
    <div data-testid="invalid-filter">
      <p>{title}</p>
      <p>{description}</p>
    </div>
  ),
}));

import AuditLogPage from '@/app/(staff)/admin/audit/page';

async function renderPage(searchParams: Record<string, string> = {}): Promise<string> {
  const tree = await AuditLogPage({ searchParams: Promise.resolve(searchParams) });
  return decodeEntities(renderToStaticMarkup(tree as ReactElement));
}

const row = (id: string) => ({
  id,
  occurredAt: '2026-09-24T03:18:00.000Z',
  eventType: 'invoice_issued',
  actorLabel: 'Johan Strand',
  actorUserId: 'u-1',
  targetLabel: null,
  targetUserId: null,
  summary: 'Issued',
  payload: null,
});

beforeEach(() => {
  errorSpy.mockClear();
  warnSpy.mockClear();
  auditQueryMock.mockReset();
  auditQueryMock.mockResolvedValue({
    ok: true,
    value: { rows: [row('a-1'), row('a-2')], nextCursor: 'c-next', prevCursor: null },
  });
});

/** The opening tag of the first element whose text is `text`. */
function tagFor(html: string, text: string): string {
  const at = html.indexOf(`>${text}<`);
  expect(at, `"${text}" is on the page`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<a', at), at + 1);
}

describe('AuditLogPage on AURA', () => {
  it('Export CSV is an AURA button link to the same export, filters carried', async () => {
    const html = await renderPage({ eventType: 'invoice_issued' });
    const a = html.slice(html.lastIndexOf('<a', html.indexOf(en.admin.audit.export)), html.indexOf(en.admin.audit.export));
    expect(a).toContain('href="/api/admin/audit/export.csv?eventType=invoice_issued"');
    expect(a).toContain('download');
    expect(a).toContain('aura-btn');
  });

  it('holds the list in an AURA card, with the count in the filter bar only', async () => {
    const html = await renderPage();
    expect(html).toContain('aura-card');
    expect(html).toContain('data-count="2"');
    expect(html).not.toContain('2 audit events');
  });

  it('says how long audit records are kept, under the table', async () => {
    const html = await renderPage();
    expect(html).toContain(en.admin.audit.retentionNote);
  });

  it('pages with AURA button links over the cursor', async () => {
    const html = await renderPage();
    const older = tagFor(html, en.admin.audit.pagination.next);
    expect(older).toContain('href="/admin/audit?cursor=c-next"');
    expect(older).toContain('aura-btn');
  });
});
