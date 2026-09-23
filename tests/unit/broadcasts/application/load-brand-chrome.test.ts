/**
 * F119 T031 / review finding F2-8 — `loadBrandChrome` is fail-soft by design
 * (a brand outage must never fail a send), but the spec says the footer MUST
 * carry the chamber's postal address. A degrade was `logger.warn`-only, which
 * is greppable, not alertable: every recipient of every E-Blast gets a footer
 * with no postal address and nothing pages anyone.
 *
 * These pin the durable signal: the counter
 * `broadcasts_brand_chrome_unavailable_total{tenant,surface}` fires on the
 * catch arm, and `surface` names the CALLER — the two dispatch use cases must
 * be distinguishable (a shared helper that stamps one caller's identity for
 * all of them is the F8 errorId defect class).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const brandChromeUnavailableSpy = vi.fn();

vi.mock('@/lib/metrics', async () => {
  const actual = await vi.importActual<typeof import('@/lib/metrics')>('@/lib/metrics');
  return {
    ...actual,
    broadcastsMetrics: {
      ...actual.broadcastsMetrics,
      brandChromeUnavailable: brandChromeUnavailableSpy,
    },
  };
});

const { loadBrandChrome } = await import(
  '@/modules/broadcasts/application/use-cases/_load-brand-chrome'
);

const TENANT = { slug: 'tenant-swe' } as never;
const NO_BRAND = { primaryColor: null, postalAddress: null, logoUrl: null };

describe('loadBrandChrome — the fail-soft degrade is alertable', () => {
  beforeEach(() => {
    brandChromeUnavailableSpy.mockClear();
  });

  it('a throwing port degrades to no chrome AND increments the counter with the calling surface', async () => {
    const port = { load: vi.fn(async () => { throw new Error('neon: connection terminated'); }) };
    const brand = await loadBrandChrome(port as never, TENANT, 'dispatch');
    expect(brand).toEqual(NO_BRAND);
    expect(brandChromeUnavailableSpy).toHaveBeenCalledTimes(1);
    expect(brandChromeUnavailableSpy).toHaveBeenCalledWith('tenant-swe', 'dispatch');
  });

  it('each caller names ITSELF — the surface label is not one hardcoded id for every call site', async () => {
    const port = { load: vi.fn(async () => { throw new Error('boom'); }) };
    await loadBrandChrome(port as never, TENANT, 'audience_tick');
    expect(brandChromeUnavailableSpy).toHaveBeenCalledWith('tenant-swe', 'audience_tick');
  });

  it('a successful read returns the brand and never touches the counter', async () => {
    const settings = { primaryColor: '#b04a00', postalAddress: '12 Wireless Rd', logoUrl: null };
    const port = { load: vi.fn(async () => settings) };
    await expect(loadBrandChrome(port as never, TENANT, 'dispatch')).resolves.toEqual(settings);
    expect(brandChromeUnavailableSpy).not.toHaveBeenCalled();
  });

  it('an ABSENT port is "no brand configured", not an outage — no counter', async () => {
    await expect(loadBrandChrome(undefined, TENANT, 'dispatch')).resolves.toEqual(NO_BRAND);
    expect(brandChromeUnavailableSpy).not.toHaveBeenCalled();
  });
});
