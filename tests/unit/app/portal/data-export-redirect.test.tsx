import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// next/navigation permanentRedirect / notFound throw control-flow signals;
// capture them instead of executing the throw. The route is PERMANENTLY moved
// (308) → permanentRedirect, not redirect (xhigh #4). It is ALSO F9-gated: when
// FEATURE_F9_DASHBOARD is dark, the Account hub's Data & privacy section does
// not render, so the page calls notFound() (the OLD page's behaviour) rather
// than redirecting the member onto a hub with no `#data-privacy` anchor
// (xhigh #5/#10).
//
// `env.features.f9Dashboard` is read at call time, so we vi.doMock '@/lib/env'
// per-case and re-import the page module with a reset registry to flip the flag.
const permanentRedirect = vi.fn((url: string) => {
  throw new Error(`NEXT_PERMANENT_REDIRECT:${url}`);
});
const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
vi.mock('next/navigation', () => ({ permanentRedirect, notFound }));

async function loadPage(f9Dashboard: boolean) {
  vi.resetModules();
  vi.doMock('next/navigation', () => ({ permanentRedirect, notFound }));
  vi.doMock('@/lib/env', () => ({ env: { features: { f9Dashboard } } }));
  const mod = await import('@/app/(member)/portal/account/data-export/page');
  return mod.default;
}

beforeEach(() => {
  permanentRedirect.mockClear();
  notFound.mockClear();
});

afterEach(() => {
  vi.doUnmock('@/lib/env');
});

describe('/portal/account/data-export route preservation (G2)', () => {
  it('F9 ON → permanently redirects (308) to the Account-hub data-privacy anchor (never 404)', async () => {
    const PortalDataExportPage = await loadPage(true);
    await expect(PortalDataExportPage()).rejects.toThrow(
      'NEXT_PERMANENT_REDIRECT:/portal/account#data-privacy',
    );
    expect(permanentRedirect).toHaveBeenCalledWith('/portal/account#data-privacy');
    expect(notFound).not.toHaveBeenCalled();
  });

  it('F9 OFF → notFound() (preserves the old 404; hub renders no data-privacy section when dark)', async () => {
    const PortalDataExportPage = await loadPage(false);
    await expect(PortalDataExportPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(permanentRedirect).not.toHaveBeenCalled();
  });
});
