/**
 * /admin/audit — load failure vs invalid filter (admin design review).
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
  return (key: string, params?: Record<string, unknown>): string => {
    const val = getPath(getPath(en as unknown, ns), key);
    if (typeof val !== 'string') return `MISSING_KEY:${ns}.${key}`;
    if (!params) return val;
    return val.replace(/\{(\w+)[^}]*\}/g, (_, k: string) =>
      params[k] !== undefined ? String(params[k]) : `{${k}}`,
    );
  };
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
vi.mock('@/components/audit/audit-filters', () => ({ AuditFilters: () => null }));
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

const LOAD_FAILED = "Couldn't load the audit log. Please try again.";

beforeEach(() => {
  errorSpy.mockClear();
  warnSpy.mockClear();
  auditQueryMock.mockReset();
  auditQueryMock.mockResolvedValue({
    ok: true,
    value: { rows: [], nextCursor: null, prevCursor: null },
  });
});

describe('AuditLogPage — infrastructure failure renders the load-error state', () => {
  it('a thrown repo error renders the error card (retry + go back + reference id), NOT "Invalid filter"', async () => {
    auditQueryMock.mockRejectedValue(new Error('NeonDbError: connection terminated'));
    const html = await renderPage();

    expect(html).toContain(LOAD_FAILED);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Try again');
    expect(html).toContain('Go back');
    expect(html).toMatch(UUID_RE);
    expect(html).not.toContain(en.admin.audit.invalidRange.title);
    expect(html).not.toContain('data-testid="invalid-filter"');
    expect(html).not.toContain('MISSING_KEY:');
  });

  it('logs the failure with an errorId and the SAME reference id the admin sees', async () => {
    auditQueryMock.mockRejectedValue(new TypeError('boom'));
    const html = await renderPage();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [ctx] = errorSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx).toMatchObject({ errorId: 'F9.ADMIN.AUDIT_LOAD', tenantId: 'tenant-a' });
    expect(typeof ctx.correlationId).toBe('string');
    expect(ctx.correlationId).toMatch(UUID_RE);
    expect(html).toContain(ctx.correlationId as string);
  });
});

describe('AuditLogPage — validation failure keeps "Invalid filter" and names the field', () => {
  it('invalid_range from the use-case with from > to → Invalid filter naming the date range', async () => {
    auditQueryMock.mockResolvedValue({ ok: false, error: 'invalid_range' });
    const html = await renderPage({ from: '2026-05-10', to: '2026-05-01' });

    expect(html).toContain(en.admin.audit.invalidRange.title);
    expect(html).toContain('“From” date is after the “To” date');
    expect(html).not.toContain(LOAD_FAILED);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(html).not.toContain('MISSING_KEY:');
  });

  it('a malformed `from` param (caught before the read) → Invalid filter naming the From field', async () => {
    const html = await renderPage({ from: 'not-a-date' });

    expect(auditQueryMock).not.toHaveBeenCalled();
    expect(html).toContain(en.admin.audit.invalidRange.title);
    expect(html).toContain('“From” date');
    expect(html).not.toContain(LOAD_FAILED);
    expect(html).not.toContain('MISSING_KEY:');
  });

  it('a non-UUID targetRef → Invalid filter naming the Target record field', async () => {
    const html = await renderPage({ targetRef: 'M-0042' });

    expect(auditQueryMock).not.toHaveBeenCalled();
    expect(html).toContain(en.admin.audit.invalidRange.title);
    expect(html).toContain('“Target record”');
    expect(html).not.toContain('MISSING_KEY:');
  });
});
