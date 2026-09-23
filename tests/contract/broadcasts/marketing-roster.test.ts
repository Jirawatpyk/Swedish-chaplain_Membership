/**
 * F119 T066 — who "marketing" means for a hand-off email (FR-021a;
 * contracts/dashboard-and-notifications.md § 3.1, research R15).
 *
 *   marketingRoles() = the roles the permission EVALUATOR grants
 *                      `broadcasts.write`, minus the admin tiers
 *   fallbackRoles()  = every role granted `broadcasts.write` (the admin tiers)
 *   listRecipients() = the ACTIVE users of marketingRoles(), or — when none is
 *                      active — of fallbackRoles(); an empty result counts
 *                      `broadcasts_no_marketing_recipient_total`
 *
 * The evaluator is the oracle, never a `'marketing'` literal and never
 * `ROLE_BUNDLES` (super-admin keys come from the evaluator's early return).
 * The "bundle changes" arm stubs the evaluator's `bundles` argument through
 * `canPerform` — it edits no production data.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@/modules/auth/domain/role';
import type { PermissionKey } from '@/modules/auth/domain/permissions/permission-catalogue';

const stub = vi.hoisted(() => ({
  bundles: null as Record<string, ReadonlySet<PermissionKey>> | null,
  active: {} as Partial<Record<string, Array<{ id: string; email: string }>>>,
  queried: [] as Array<readonly string[]>,
}));

// The composition-layer evaluator alias, pointed at the REAL `hasPermission`
// with an optional bundle override — "a bundle change" without touching data.
vi.mock('@/lib/rbac', async () => {
  const { hasPermission } = await import('@/modules/auth/domain/permissions/evaluator');
  const { ROLE_BUNDLES } = await import('@/modules/auth/domain/permissions/role-bundles');
  return {
    canPerform: (role: string, key: PermissionKey) =>
      hasPermission(role, key, (stub.bundles ?? ROLE_BUNDLES) as typeof ROLE_BUNDLES),
  };
});
// The cross-tenant `users` read behind the auth barrel.
vi.mock('@/modules/auth/infrastructure/db/active-users-by-role-repo', () => ({
  listActiveUsersByRole: vi.fn(async (roles: readonly string[]) => {
    stub.queried.push([...roles]);
    return roles.flatMap((r) => stub.active[r] ?? []);
  }),
  listActiveUserIdsWithRole: vi.fn(async () => new Set<string>()),
}));

import { broadcastsMetrics } from '@/lib/metrics';
import { ROLE_BUNDLES } from '@/modules/auth/domain/permissions/role-bundles';
import { fallbackRoles, makeMarketingDirectory, marketingRoles } from '@/lib/broadcast-marketing-deps';

const MARKETER = { id: 'aaaaaaaa-0000-4000-8000-00000000000a', email: 'marketing@swecham.test' };
const ADMIN = { id: 'aaaaaaaa-0000-4000-8000-00000000000b', email: 'admin@swecham.test' };
const SUPER = { id: 'aaaaaaaa-0000-4000-8000-00000000000c', email: 'super@swecham.test' };

beforeEach(() => {
  stub.bundles = null;
  stub.active = {};
  stub.queried = [];
  vi.restoreAllMocks();
});

describe('marketingRoles() is derived from the evaluator', () => {
  it('today: marketing is the roster, the admin tiers are the fallback', () => {
    expect(marketingRoles()).toEqual<Role[]>(['marketing']);
    expect([...fallbackRoles()].sort()).toEqual<Role[]>(['admin', 'marketing', 'super_admin']);
  });

  it('removing broadcasts.write from the marketing bundle changes the roster without touching this code', async () => {
    stub.bundles = {
      ...ROLE_BUNDLES,
      marketing: new Set([...ROLE_BUNDLES.marketing].filter((k) => k !== 'broadcasts.write')),
    };
    expect(marketingRoles()).toEqual([]);
    expect([...fallbackRoles()].sort()).toEqual<Role[]>(['admin', 'super_admin']);

    // A marketing user still exists — but the bundle no longer makes them
    // "marketing", so the hand-off goes to the admin tiers.
    stub.active = { marketing: [MARKETER], admin: [ADMIN], super_admin: [SUPER] };
    const recipients = await makeMarketingDirectory('test-tenant').listRecipients();
    expect(recipients.map((r) => r.email).sort()).toEqual([ADMIN.email, SUPER.email]);
    expect(stub.queried.flat()).not.toContain('marketing');
  });

  it('the composition names neither the literal role nor ROLE_BUNDLES (comments stripped)', () => {
    const source = readFileSync(join(__dirname, '..', '..', '..', 'src', 'lib', 'broadcast-marketing-deps.ts'), 'utf8');
    const code = source
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    expect(code).toMatch(/canPerform\(/); // positive control: the scan reads the real file
    expect(code).not.toMatch(/['"]marketing['"]/);
    expect(code).not.toMatch(/ROLE_BUNDLES/);
  });
});

describe('listRecipients()', () => {
  it('an ACTIVE marketing user is the roster; the admins are not asked', async () => {
    stub.active = { marketing: [MARKETER], admin: [ADMIN] };
    const spy = vi.spyOn(broadcastsMetrics, 'noMarketingRecipient');
    const recipients = await makeMarketingDirectory('test-tenant').listRecipients();
    expect(recipients).toEqual([{ userId: MARKETER.id, email: MARKETER.email, locale: 'en' }]);
    expect(stub.queried).toEqual([['marketing']]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('no active marketing user → the admin tiers (FR-021a "the tenant\'s admins instead")', async () => {
    stub.active = { admin: [ADMIN], super_admin: [SUPER] };
    const recipients = await makeMarketingDirectory('test-tenant').listRecipients();
    expect(recipients.map((r) => r.userId).sort()).toEqual([ADMIN.id, SUPER.id].sort());
    expect(recipients.every((r) => r.locale === 'en')).toBe(true);
  });

  it('an empty roster increments broadcasts_no_marketing_recipient_total, once, labelled with the tenant', async () => {
    const spy = vi.spyOn(broadcastsMetrics, 'noMarketingRecipient');
    const recipients = await makeMarketingDirectory('test-tenant').listRecipients();
    expect(recipients).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('test-tenant');
  });
});
