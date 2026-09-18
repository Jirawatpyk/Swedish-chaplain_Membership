/**
 * F119 T028 — `/admin/settings/broadcasts/brand` is INVISIBLE, not disabled
 * (contracts/admin-eblast-formatting-api.md § "the Brand page").
 *
 * Three separable claims, each pinned with the real artefact rather than a
 * fixture:
 *
 *  1. `marketing` does not hold `settings.broadcasts` — asserted against the
 *     REAL evaluator, not a hand-copied list, so a bundle edit is caught here.
 *  2. The page gates on exactly that key, and the gate runs BEFORE any brand
 *     read — a denial must not have cost a repo round-trip, and must not have
 *     rendered a page.
 *  3. The in-page F7 flag gate exists, because the proxy kill-switch predicate
 *     covers `/admin/broadcasts` and NOT `/admin/settings/**` (research R18) —
 *     a hidden nav entry whose URL still serves is a one-sided gate.
 *
 * Plus the registration pin: `check:staff-page-guard` refuses an unregistered
 * staff page, so the baseline row travels in the same commit as the page.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { features, requirePagePermission, getBrandSettings, makeBrandSettingsDeps } = vi.hoisted(
  () => ({
    features: { f7Broadcasts: true },
    requirePagePermission: vi.fn(),
    getBrandSettings: vi.fn(),
    makeBrandSettingsDeps: vi.fn(),
  }),
);

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
  getLocale: vi.fn().mockResolvedValue('en'),
}));
// `canPerform` is NOT stubbed to a constant: the page uses it to decide
// `canManageInvoiceSettings`, and a stub would make the `manageHref` arms pass
// for the wrong reason. It delegates to the real Domain evaluator here exactly
// as `src/lib/rbac.ts` does in production.
vi.mock('@/lib/rbac', async () => {
  const evaluator = await vi.importActual<
    typeof import('@/modules/auth/domain/permissions/evaluator')
  >('@/modules/auth/domain/permissions/evaluator');
  return {
    requirePagePermission: (...args: unknown[]) => requirePagePermission(...args),
    canPerform: (role: string, key: string) => evaluator.hasPermission(role as never, key as never),
  };
});
vi.mock('@/lib/env', () => ({ env: { features } }));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
  resolveTenantFromHeaders: () => ({ slug: 'tenant-a' }),
}));
vi.mock('@/lib/broadcast-brand-deps', () => ({
  makeBrandSettingsDeps: (...args: unknown[]) => makeBrandSettingsDeps(...args),
}));
vi.mock('@/modules/broadcasts', () => ({
  getBrandSettings: (...args: unknown[]) => getBrandSettings(...args),
}));

import { hasPermission } from '@/modules/auth/domain/permissions/evaluator';
import BrandSettingsPage from '@/app/(staff)/admin/settings/broadcasts/brand/page';

const VIEW = {
  primaryColor: '#10487a',
  postalAddress: '349 Sukhumvit Rd',
  addressMissing: false,
  logo: { url: 'https://cdn.test/logo.png', source: 'invoice_settings', manageHref: null },
  defaults: { primaryColor: '#10487a' },
  updatedAt: '2026-09-18T00:00:00.000Z',
} as const;

beforeEach(() => {
  features.f7Broadcasts = true;
  requirePagePermission.mockReset().mockResolvedValue({ user: { id: 'u-1', role: 'admin' } });
  makeBrandSettingsDeps.mockReset().mockReturnValue({ repo: {}, audit: {}, logoUrl: {} });
  getBrandSettings.mockReset().mockResolvedValue(VIEW);
});

describe('F119 T028 — Brand page permission gate', () => {
  it('marketing holds neither settings.broadcasts nor settings.invoicing (real evaluator)', () => {
    expect(hasPermission('marketing', 'settings.broadcasts')).toBe(false);
    expect(hasPermission('marketing', 'settings.invoicing')).toBe(false);
    // The two roles the page IS for, so the negative above is not vacuous.
    expect(hasPermission('admin', 'settings.broadcasts')).toBe(true);
    expect(hasPermission('super_admin', 'settings.broadcasts')).toBe(true);
  });

  it('marketing → no page: the gate refuses and no brand read happens', async () => {
    // What `requirePagePermission` does for a role without the key: audit the
    // denial, then `notFound()`. Modelled here at its real call boundary.
    requirePagePermission.mockImplementation(() => {
      throw new Error('NEXT_NOT_FOUND');
    });
    await expect(BrandSettingsPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(requirePagePermission).toHaveBeenCalledWith('settings.broadcasts');
    expect(getBrandSettings).not.toHaveBeenCalled();
    expect(makeBrandSettingsDeps).not.toHaveBeenCalled();
  });

  it('FEATURE_F7_BROADCASTS off → notFound(), and no brand read', async () => {
    features.f7Broadcasts = false;
    await expect(BrandSettingsPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(getBrandSettings).not.toHaveBeenCalled();
  });

  it('admin → renders, and asks the use case for a NON-manageable logo href', async () => {
    const el = await BrandSettingsPage();
    expect(el).toBeTruthy();
    expect(requirePagePermission).toHaveBeenCalledWith('settings.broadcasts');
    expect(getBrandSettings).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      // `settings.invoicing` is superAdminOnly — a plain admin gets the
      // "ask an administrator" hint, not a Manage link.
      canManageInvoiceSettings: false,
    });
  });

  it('super_admin → the use case is told the logo IS manageable', async () => {
    requirePagePermission.mockResolvedValue({ user: { id: 'u-1', role: 'super_admin' } });
    await BrandSettingsPage();
    expect(getBrandSettings).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      canManageInvoiceSettings: true,
    });
  });
});

describe('F119 T028 — the page is registered where the gates read', () => {
  const ROOT = process.cwd();

  it('the RBAC baseline carries the page row (check:staff-page-guard reads it)', () => {
    const src = readFileSync(join(ROOT, 'tests/helpers/rbac-observed-baseline.ts'), 'utf8');
    expect(src).toContain(
      "{ surface: '/admin/settings/broadcasts/brand', kind: 'page', key: 'settings.broadcasts' }",
    );
  });

  it('the page calls requirePagePermission with a LITERAL key', () => {
    const src = readFileSync(
      join(ROOT, 'src/app/(staff)/admin/settings/broadcasts/brand/page.tsx'),
      'utf8',
    );
    expect(src).toContain("requirePagePermission('settings.broadcasts')");
  });
});
