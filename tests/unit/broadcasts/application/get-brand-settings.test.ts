/**
 * F119 T025 — `getBrandSettings` (FR-041b/c; contract § GET …/brand).
 *
 * Returns the colour, the address, the READ-only logo URL resolved through
 * `TenantLogoUrlPort`, `addressMissing`, the platform default and a
 * `manageHref` that is non-null ONLY for a `settings.invoicing` holder.
 */
import { describe, expect, it, vi } from 'vitest';
import { getBrandSettings } from '@/modules/broadcasts/application/use-cases/get-brand-settings';

const TENANT = 'tenant-swe' as never;

function makeDeps(record: { primaryColor: string | null; postalAddress: string | null; updatedAt: Date | null }, logoUrl: string | null) {
  return {
    repo: {
      withTx: vi.fn(),
      find: vi.fn(async () => ({ ...record, updatedByUserId: null })),
      save: vi.fn(),
    },
    logoUrl: { resolve: vi.fn(async () => logoUrl) },
  };
}

describe('getBrandSettings', () => {
  it('returns colour, address, the read-only logo and the platform default', async () => {
    const deps = makeDeps({ primaryColor: '#b04a00', postalAddress: '1 Street', updatedAt: new Date('2026-09-18T00:00:00Z') }, 'https://blob.example/l.png');
    const r = await getBrandSettings(deps, { tenantId: TENANT, canManageInvoiceSettings: true });
    expect(r).toEqual({
      primaryColor: '#b04a00',
      postalAddress: '1 Street',
      addressMissing: false,
      logo: { url: 'https://blob.example/l.png', source: 'invoice_settings', manageHref: '/admin/settings/invoicing' },
      defaults: { primaryColor: '#10487a' },
      updatedAt: '2026-09-18T00:00:00.000Z',
    });
    expect(deps.logoUrl.resolve).toHaveBeenCalledWith(TENANT);
  });

  it('an admin without settings.invoicing gets `manageHref: null`', async () => {
    const deps = makeDeps({ primaryColor: null, postalAddress: null, updatedAt: null }, null);
    const r = await getBrandSettings(deps, { tenantId: TENANT, canManageInvoiceSettings: false });
    expect(r.logo).toEqual({ url: null, source: 'invoice_settings', manageHref: null });
  });

  it('flags the address as missing while unset (the footer shows the chamber name only)', async () => {
    const deps = makeDeps({ primaryColor: null, postalAddress: null, updatedAt: null }, null);
    const r = await getBrandSettings(deps, { tenantId: TENANT, canManageInvoiceSettings: false });
    expect(r.addressMissing).toBe(true);
    expect(r.primaryColor).toBeNull();
    expect(r.updatedAt).toBeNull();
  });
});
