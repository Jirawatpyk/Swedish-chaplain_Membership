/**
 * 060-member-portal-d4 — /portal/invoices error-handling resilience
 * (findings C1 + I5).
 *
 * The page's data-fetch section has two trap-prone reads:
 *
 *  - C1: `listInvoicesPaged` is typed `Result<…, never>` and the repo runs
 *    inside `runInTenant` with no try/catch, so a DB/RLS/SQL failure THROWS
 *    rather than returning `!ok`. The page must catch the throw, log the
 *    failure CLASS (errKind) with tenantId/memberId, and render the
 *    `loadFailed` card (NOT crash into error.tsx, which logs without the
 *    member-scoped context).
 *
 *  - I5: `findByLinkedUserId` returns TWO distinct errors — `repo.not_found`
 *    (genuine no-link → notLinked, no log) and `repo.unexpected` (a thrown
 *    DB/RLS error → must render loadFailed + log, NOT tell a linked member
 *    "not linked").
 *
 * The async RSC default export is invoked directly with mocked boundaries and
 * rendered with renderToStaticMarkup (same approach as
 * invoices-summary-card-error.test.tsx + portal-profile-body.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// --- mocks ----------------------------------------------------------------

const warnSpy = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { warn: (...args: unknown[]) => warnSpy(...args) },
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => makeRealTranslator(ns)),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));

const findByLinkedUserIdMock = vi.fn();
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: {
      findByLinkedUserId: (...args: unknown[]) => findByLinkedUserIdMock(...args),
    },
  }),
}));

const listInvoicesPagedMock = vi.fn();
vi.mock('@/modules/invoicing', () => ({
  listInvoicesPaged: (...args: unknown[]) => listInvoicesPagedMock(...args),
  makeListInvoicesDeps: () => ({ invoiceRepo: {} }),
}));

import PortalInvoicesPage from '@/app/(member)/portal/invoices/page';

async function renderPage(): Promise<string> {
  const tree = await PortalInvoicesPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(tree as ReactElement);
}

beforeEach(() => {
  warnSpy.mockClear();
  findByLinkedUserIdMock.mockReset();
  listInvoicesPagedMock.mockReset();
  // Defaults: linked member + a successful (empty) invoice read. Each test
  // overrides the branch it is exercising.
  findByLinkedUserIdMock.mockResolvedValue({ ok: true, value: { memberId: 'm1' } });
  listInvoicesPagedMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
});

describe('PortalInvoicesPage — member lookup error vs not-linked (finding I5)', () => {
  it('repo.not_found → renders notLinked (genuine) and does NOT log', async () => {
    findByLinkedUserIdMock.mockResolvedValue({ ok: false, error: { code: 'repo.not_found' } });
    const html = await renderPage();
    expect(html).toContain(en.portal.invoices.notLinked);
    expect(warnSpy).not.toHaveBeenCalled();
    // Must NOT show the loadFailed error copy for a genuine no-link.
    expect(html).not.toContain('load your invoices right now');
    expect(html).not.toContain('MISSING_KEY:');
  });

  it('repo.unexpected (DB/RLS error) → renders loadFailed (NOT notLinked) + logs errKind only', async () => {
    findByLinkedUserIdMock.mockResolvedValue({
      ok: false,
      error: { code: 'repo.unexpected', cause: new TypeError('boom') },
    });
    const html = await renderPage();
    // A transient DB error must NOT tell a linked member "not linked".
    expect(html).not.toContain(en.portal.invoices.notLinked);
    expect(html).toContain('load your invoices right now');
    expect(html).not.toContain('MISSING_KEY:');
    // Logs the failure CLASS + hashed user id only — never raw error / PII / raw id.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx).toMatchObject({ tenantId: 'tenant-a' });
    expect(ctx.errKind).toBe('TypeError');
    expect(ctx).toHaveProperty('userIdHash');
    expect(ctx.userIdHash).not.toBe('u1');
    expect(ctx).not.toHaveProperty('userId');
    expect(ctx).not.toHaveProperty('err');
    expect(ctx).not.toHaveProperty('error');
    expect(ctx).not.toHaveProperty('message');
    expect(msg).toContain('portal-invoices-list');
    expect(msg).toContain('member lookup failed');
  });
});

describe('PortalInvoicesPage — invoice read-throw resilience (finding C1)', () => {
  it('renders loadFailed when listInvoicesPaged THROWS — not a crash into error.tsx', async () => {
    listInvoicesPagedMock.mockRejectedValue(new Error('NeonDbError'));
    const html = await renderPage();
    expect(html).toContain('load your invoices right now');
    // Must NOT fall through to the empty "no invoices" copy.
    expect(html).not.toContain(en.portal.invoices.empty);
    expect(html).not.toContain('MISSING_KEY:');
  });

  it('logs errKind + tenantId/memberId only when the invoice read throws — never raw error / PII', async () => {
    listInvoicesPagedMock.mockRejectedValue(new TypeError('boom'));
    await renderPage();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx).toMatchObject({ tenantId: 'tenant-a', memberId: 'm1' });
    expect(ctx.errKind).toBe('TypeError');
    expect(ctx).not.toHaveProperty('err');
    expect(ctx).not.toHaveProperty('error');
    expect(ctx).not.toHaveProperty('message');
    expect(msg).toContain('portal-invoices-list');
    expect(msg).toContain('threw');
  });
});
