/**
 * 060-member-portal-d4 — `parseStatusFilter` (member portal invoices page).
 *
 * THE BUG (facet 1): the portal `parseStatusFilter` demoted `'overdue'` to
 * `'all'`, so selecting Overdue returned EVERY non-draft invoice (no
 * filtering) — the repo's correct overdue branch (status='issued' AND
 * dueDate < Bangkok-today) was never reached. This pins that `'overdue'`
 * now survives parsing so it flows through `listInvoicesPaged` to the repo.
 *
 * Pure-function boundary test — no server deps, no DOM. The page module is
 * imported only for the named `parseStatusFilter` export; server-only infra
 * it pulls in (auth-session, db, invoicing/members barrels) is stubbed at
 * module level so the import resolves in the Vitest env.
 */
import { describe, it, expect, vi } from 'vitest';

// Stub the server-only deps the page module pulls in at import time so the
// pure `parseStatusFilter` export can be loaded without a Next.js app shell
// or a live Neon connection. None of these are exercised by the assertions
// below — `parseStatusFilter` is a synchronous pure function.
vi.mock('@/lib/auth-session', () => ({ requireSession: vi.fn() }));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromRequest: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/modules/invoicing', () => ({
  listInvoicesPaged: vi.fn(),
  makeListInvoicesDeps: vi.fn(),
}));
vi.mock('@/modules/members/members-deps', () => ({ buildMembersDeps: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(),
  getLocale: vi.fn(),
}));

import { parseStatusFilter } from '@/app/(member)/portal/invoices/page';

describe('parseStatusFilter (member portal)', () => {
  it('honours overdue — it must NOT be demoted to all (the bug)', () => {
    // The crux of facet 1: pre-fix this returned 'all', so the repo's
    // derived overdue branch was unreachable from the portal.
    expect(parseStatusFilter('overdue')).toBe('overdue');
  });

  it('passes through every stored status the portal exposes', () => {
    expect(parseStatusFilter('issued')).toBe('issued');
    expect(parseStatusFilter('paid')).toBe('paid');
    expect(parseStatusFilter('void')).toBe('void');
    expect(parseStatusFilter('credited')).toBe('credited');
    expect(parseStatusFilter('partially_credited')).toBe('partially_credited');
  });

  it('falls back to all for absent / unknown / draft', () => {
    // 'draft' is deliberately NOT a portal filter value (members never see
    // drafts) — it falls through to 'all' like any other unknown string.
    expect(parseStatusFilter(undefined)).toBe('all');
    expect(parseStatusFilter('')).toBe('all');
    expect(parseStatusFilter('draft')).toBe('all');
    expect(parseStatusFilter('all')).toBe('all');
    expect(parseStatusFilter('nonsense')).toBe('all');
  });

  it('falls back to all when Next delivers status as a string[] (repeated query key)', () => {
    // Next.js can hand `searchParams.status` as a `string[]` when the key
    // appears more than once (e.g. `?status=draft&status=paid`). The signature
    // is typed `string | undefined`, but at runtime an array slips through the
    // `(PORTAL_STATUS_OPTIONS as string[]).includes(arr)` check (an array never
    // equals a string element) → falls through to the safe 'all' default.
    // Robustness pin: the page must never crash or mis-filter on a multi-valued
    // status param.
    expect(
      parseStatusFilter(['draft', 'paid'] as unknown as string),
    ).toBe('all');
  });
});
