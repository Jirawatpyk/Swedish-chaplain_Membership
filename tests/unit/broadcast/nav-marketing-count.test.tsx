/**
 * F119 T127 (RED for T132) — marketing sees the E-Blast waiting count from
 * anywhere in the staff portal (US5-AS4, FR-023; contracts/dashboard-and-
 * notifications.md § 1.3, research R18).
 *
 *   1. The badge counts the MARKETING-TURN set — `turnOf(status) ===
 *      'marketing'`, the same Domain predicate the
 *      `broadcasts_marketing_turn_count` gauge counts — as a live indexed
 *      `count(*)` at render (the query is captured and rendered through
 *      drizzle's `PgDialect`, so the test reads the statuses the adapter
 *      actually sent to Postgres).
 *   2. It is hidden while `FEATURE_EBLAST_MEMBER_APPROVAL` is off AND no row is
 *      in an approval-round stage — and shown when the flag is off but a row IS
 *      in one, so an in-flight E-Blast is never invisible to the people who
 *      must act on it (R18). Every `broadcasts.read` holder sees it, including
 *      `manager`; a role without it gets no query at all.
 *   3. The staff layout's seam: the read → `applyNavBadges` → the Broadcasts
 *      link's accessible name carries the count and its sr-only noun.
 */
import type { ReactElement, ReactNode } from 'react';
import { cloneElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import en from '@/i18n/messages/en.json';
import { asTenantContext } from '@/modules/tenants';
import { BROADCAST_STATUSES } from '@/modules/broadcasts/domain/value-objects/broadcast-status';
import { MARKETING_TURN_STATUSES, turnOf } from '@/modules/broadcasts/domain/stage/whose-turn';
import { APPROVAL_ROUND_STATUSES } from '@/modules/broadcasts/domain/stage/in-progress-statuses';
import { applyNavBadges, isNavGroup, staffNavConfig, type RenderedNavItem } from '@/config/nav';

const h = vi.hoisted(() => ({
  features: { f7Broadcasts: true } as { f7Broadcasts: boolean },
  flagOn: true,
  counts: { marketingTurn: 4, inApprovalRound: 1 } as { marketingTurn: number; inApprovalRound: number } | Error | 'hang',
  queried: 0,
  logError: vi.fn(),
  captured: { fields: null as Record<string, unknown> | null, where: null as unknown },
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const real = (await importOriginal<typeof import('@/lib/env')>()).env;
  return {
    env: new Proxy(real, {
      get: (target, key) => (key === 'features' ? { ...target.features, ...h.features } : Reflect.get(target, key)),
    }),
  };
});
vi.mock('@/lib/logger', () => ({ logger: { error: h.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rbac', async () => {
  const { hasPermission } = await import('@/modules/auth/domain/permissions/evaluator');
  return { canPerform: (role: string, key: never) => hasPermission(role, key) };
});
vi.mock('next/navigation', () => ({ usePathname: () => '/admin' }));
vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({ render: el, children }: { render: ReactElement; children: ReactNode }) => cloneElement(el, {}, children),
  SidebarMenuSub: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuSubItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuSubButton: ({ render: el, children }: { render: ReactElement; children: ReactNode }) => cloneElement(el, {}, children),
}));
/** `runInTenant` hands the counter a tx that records its SELECT and answers `h.counts`. */
vi.mock('@/lib/db', () => ({
  runInTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: (fields: Record<string, unknown>) => {
        h.captured.fields = fields;
        const query = {
          from: () => query,
          where: async (cond: unknown) => {
            h.captured.where = cond;
            h.queried += 1;
            if (h.counts === 'hang') return new Promise(() => undefined);
            if (h.counts instanceof Error) throw h.counts;
            return [h.counts];
          },
        };
        return query;
      },
    };
    return fn(tx);
  },
}));
vi.mock('@/modules/broadcasts/infrastructure/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/broadcasts/infrastructure/feature-flags')>()),
  isEblastMemberApprovalEnabled: () => h.flagOn,
}));

import { EBLAST_NAV_BADGE_TIMEOUT_MS, readEblastWaitingCount, readEblastWaitingCountForNav } from '@/lib/eblast-waiting-count';
import { NavEntry } from '@/components/layout/nav-item';

const TENANT = asTenantContext('tenant-a');
const ROOT = join(__dirname, '..', '..', '..');
const dialect = new PgDialect();
const paramsOf = (s: unknown) => dialect.sqlToQuery(s as SQL).params.map(String);

beforeEach(() => {
  h.features.f7Broadcasts = true;
  h.flagOn = true;
  h.counts = { marketingTurn: 4, inApprovalRound: 1 };
  h.queried = 0;
  h.logError.mockReset();
  h.captured.fields = null;
  h.captured.where = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the badge counts the marketing-turn set — the gauge\'s own Domain predicate', () => {
  it('MARKETING_TURN_STATUSES is exactly the statuses whose turn is marketing', () => {
    expect([...MARKETING_TURN_STATUSES]).toEqual(BROADCAST_STATUSES.filter((s) => turnOf(s) === 'marketing'));
    expect([...MARKETING_TURN_STATUSES].sort()).toEqual(['changes_requested', 'in_design', 'member_approved', 'submitted']);
    // The approval-round stages the flag-off rule looks for: in flight, and only inside the round.
    expect([...APPROVAL_ROUND_STATUSES].sort()).toEqual(['awaiting_member_approval', 'changes_requested', 'in_design', 'member_approved']);
  });

  it('the gauge and the nav counter both read the constant — neither hand-lists the set', () => {
    for (const file of [
      'src/app/api/internal/metrics/broadcasts-gauges/route.ts',
      'src/modules/broadcasts/infrastructure/db/drizzle-broadcast-approval-counter.ts',
    ]) {
      const code = readFileSync(join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).toContain('MARKETING_TURN_STATUSES');
      expect(code, file).not.toMatch(/'submitted',\s*'in_design',\s*'changes_requested',\s*'member_approved'/);
    }
  });

  it('the live query: tenant-scoped, counting the marketing-turn set and the approval-round set, and reading no other status', async () => {
    await readEblastWaitingCount(TENANT, 'marketing', 'test');
    const where = paramsOf(h.captured.where);
    expect(where).toContain('tenant-a');
    expect(new Set(where.filter((p) => p !== 'tenant-a'))).toEqual(new Set([...MARKETING_TURN_STATUSES, ...APPROVAL_ROUND_STATUSES]));
    const fields = h.captured.fields!;
    expect(new Set(paramsOf(fields.marketingTurn))).toEqual(new Set(MARKETING_TURN_STATUSES));
    expect(new Set(paramsOf(fields.inApprovalRound))).toEqual(new Set(APPROVAL_ROUND_STATUSES));
  });
});

describe('hidden while the flag is off AND no row is in a new stage', () => {
  it('flag on: the marketing-turn count, whatever the round holds', async () => {
    h.counts = { marketingTurn: 4, inApprovalRound: 0 };
    await expect(readEblastWaitingCount(TENANT, 'marketing', 'test')).resolves.toEqual({ kind: 'ok', count: 4 });
  });

  it('flag off with no row in an approval-round stage: hidden (today\'s queue is unchanged)', async () => {
    h.flagOn = false;
    h.counts = { marketingTurn: 3, inApprovalRound: 0 };
    await expect(readEblastWaitingCount(TENANT, 'marketing', 'test')).resolves.toEqual({ kind: 'hidden', reason: 'flag_off' });
  });

  it('flag off but a row still in the round: shown — an in-flight E-Blast is never invisible (R18)', async () => {
    h.flagOn = false;
    h.counts = { marketingTurn: 3, inApprovalRound: 1 };
    await expect(readEblastWaitingCount(TENANT, 'marketing', 'test')).resolves.toEqual({ kind: 'ok', count: 3 });
  });

  it('every broadcasts.read holder sees it — manager included; a role without it gets no query', async () => {
    for (const role of ['marketing', 'admin', 'super_admin', 'manager']) {
      await expect(readEblastWaitingCount(TENANT, role, 'test')).resolves.toEqual({ kind: 'ok', count: 4 });
    }
    h.queried = 0;
    await expect(readEblastWaitingCount(TENANT, 'member', 'test')).resolves.toEqual({ kind: 'hidden', reason: 'not_permitted' });
    expect(h.queried).toBe(0);
  });

  it('E-Blasts switched off entirely (F7 kill switch): hidden, no query', async () => {
    h.features.f7Broadcasts = false;
    await expect(readEblastWaitingCount(TENANT, 'marketing', 'test')).resolves.toEqual({ kind: 'hidden', reason: 'feature_off' });
    expect(h.queried).toBe(0);
  });

  it('a failed read is unavailable (no badge, one log line under the caller errorId); a hung read is cut at the deadline', async () => {
    h.counts = new Error('neon down');
    await expect(readEblastWaitingCountForNav(TENANT, 'marketing')).resolves.toEqual({ kind: 'unavailable' });
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(h.logError.mock.calls[0]![0]).toMatchObject({ errorId: 'M119.nav.eblast_badge_failed', tenantId: 'tenant-a' });

    h.logError.mockReset();
    vi.useFakeTimers();
    h.counts = 'hang';
    const pending = readEblastWaitingCountForNav(TENANT, 'marketing');
    await vi.advanceTimersByTimeAsync(EBLAST_NAV_BADGE_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ kind: 'unavailable' });
    expect(h.logError.mock.calls[0]![0]).toMatchObject({ errorId: 'M119.nav.eblast_badge_timed_out' });
  });
});

describe('the staff layout seam: read → applyNavBadges → the Broadcasts link', () => {
  const broadcastsItem = (counts: Parameters<typeof applyNavBadges>[1]) =>
    applyNavBadges(staffNavConfig, counts)
      .sections.flatMap((s) => s.items.flatMap((i) => (isNavGroup(i) ? i.children : [i])))
      .find((i) => i.href === '/admin/broadcasts') as RenderedNavItem;

  it('the Broadcasts item declares the badge, and the count reaches its accessible name with the sr-only noun', () => {
    const item = broadcastsItem({ '/admin/broadcasts': 4 });
    expect(item.badge).toEqual({ labelKey: 'nav.staff.broadcastsBadge' });
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ul>
          <NavEntry item={item} />
        </ul>
      </NextIntlClientProvider>,
    );
    const link = screen.getByRole('link', { name: 'Broadcasts 4 waiting' });
    expect(link).toHaveAttribute('href', '/admin/broadcasts');
    expect(link.querySelector('.sr-only')).toHaveTextContent('waiting');
  });

  it('hidden and unavailable reach the nav as no badge at all (0 is never rendered)', () => {
    expect(broadcastsItem({ '/admin/broadcasts': 0 }).badgeCount).toBeUndefined();
    expect(broadcastsItem({}).badgeCount).toBeUndefined();
  });

  it('the staff layout passes the E-Blast count under the Broadcasts href, alongside the change-request count', () => {
    const layout = readFileSync(join(ROOT, 'src', 'app', '(staff)', 'admin', 'layout.tsx'), 'utf8');
    expect(layout).toMatch(/readEblastWaitingCountForNav\(/);
    expect(layout).toMatch(/'\/admin\/broadcasts':\s*\w+\.kind === 'ok' \? \w+\.count : 0/);
  });
});
