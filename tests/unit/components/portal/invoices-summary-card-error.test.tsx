/**
 * 057 D1 review finding B3 — <InvoicesSummaryCard> throw resilience.
 *
 * `listInvoicesPaged` is typed `Result<…, never>` and has NO try/catch, so a
 * DB error THROWS rather than returning `!ok`. Before the fix the card would
 * CRASH (the `!ok` "error variant" was unreachable). This test drives a thrown
 * read and asserts the card (1) renders the existing error variant
 * (`loadFailed`), NOT the empty "no invoices" copy, and (2) logs the failure
 * CLASS only (errKind — never raw error / SQL / PII).
 *
 * Server-component approach mirrors recent-activity-section.test.tsx: the async
 * RSC body is invoked directly and rendered with renderToStaticMarkup, with
 * getTranslations backed by the real en.json (dangling t() → "MISSING_KEY:").
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

import { InvoicesSummaryCard } from '@/components/portal/invoices-summary-card';

async function renderCard(): Promise<string> {
  // `id` is the branded `UserId`; cast the plain string for the test fixture.
  const tree = await InvoicesSummaryCard({ user: { id: 'u1' as never } });
  return renderToStaticMarkup(tree as ReactElement);
}

describe('<InvoicesSummaryCard> — read-throw resilience (finding B3)', () => {
  beforeEach(() => {
    warnSpy.mockClear();
    listInvoicesPagedMock.mockReset();
    findByLinkedUserIdMock.mockReset();
    // Default: the session user IS linked to a member (the I5 tests below
    // override this per-case).
    findByLinkedUserIdMock.mockResolvedValue({ ok: true, value: { memberId: 'm1' } });
  });

  it('renders the error variant (loadFailed) when the invoice read THROWS — not a crash', async () => {
    listInvoicesPagedMock.mockRejectedValue(new Error('NeonDbError'));
    const html = await renderCard();
    // Real-en portal.invoices.loadFailed copy.
    expect(html).toContain('load your invoices right now');
    // Must NOT fall through to the empty "no invoices" copy.
    expect(html).not.toContain(en.portal.invoices.empty);
    expect(html).not.toContain('MISSING_KEY:');
  });

  it('logs errKind + tenantId/memberId only — never the raw error / PII', async () => {
    listInvoicesPagedMock.mockRejectedValue(new TypeError('boom'));
    await renderCard();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx).toMatchObject({ tenantId: 'tenant-a', memberId: 'm1' });
    expect(ctx.errKind).toBe('TypeError');
    expect(ctx).not.toHaveProperty('err');
    expect(ctx).not.toHaveProperty('error');
    expect(ctx).not.toHaveProperty('message');
    expect(msg).toContain('portal-invoices-summary');
  });
});

describe('<InvoicesSummaryCard> — member lookup error vs not-linked (finding I5)', () => {
  beforeEach(() => {
    warnSpy.mockClear();
    listInvoicesPagedMock.mockReset();
    // The member lookup fails BEFORE the invoice read in every I5 case, so the
    // invoice read is never reached; resolve OK as a defensive default.
    listInvoicesPagedMock.mockResolvedValue({ ok: true, value: { rows: [] } });
    findByLinkedUserIdMock.mockReset();
  });

  it('repo.not_found → renders notLinked (genuine, expected) and does NOT log', async () => {
    findByLinkedUserIdMock.mockResolvedValue({ ok: false, error: { code: 'repo.not_found' } });
    const html = await renderCard();
    expect(html).toContain(en.portal.invoices.notLinked);
    // Not a DB failure → no diagnostic.
    expect(warnSpy).not.toHaveBeenCalled();
    // Must NOT render the loadFailed error variant for a genuine no-link.
    expect(html).not.toContain('load your invoices right now');
    expect(html).not.toContain('MISSING_KEY:');
  });

  it('repo.unexpected (DB/RLS error) → renders loadFailed (NOT notLinked) + logs errKind only', async () => {
    findByLinkedUserIdMock.mockResolvedValue({
      ok: false,
      error: { code: 'repo.unexpected', cause: new TypeError('boom') },
    });
    const html = await renderCard();
    // A transient DB error must NOT tell a linked member "not linked".
    expect(html).not.toContain(en.portal.invoices.notLinked);
    // It renders the distinct error variant instead.
    expect(html).toContain('load your invoices right now');
    expect(html).not.toContain('MISSING_KEY:');
    // And it logs the failure CLASS only — never the raw error / PII / raw id.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx).toMatchObject({ tenantId: 'tenant-a' });
    expect(ctx.errKind).toBe('TypeError');
    // The user id is HASHED, never raw.
    expect(ctx).toHaveProperty('userIdHash');
    expect(ctx.userIdHash).not.toBe('u1');
    expect(ctx).not.toHaveProperty('userId');
    expect(ctx).not.toHaveProperty('err');
    expect(ctx).not.toHaveProperty('error');
    expect(ctx).not.toHaveProperty('message');
    expect(msg).toContain('portal-invoices-summary');
    expect(msg).toContain('member lookup failed');
  });
});
