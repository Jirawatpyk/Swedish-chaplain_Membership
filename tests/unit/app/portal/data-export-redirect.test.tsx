import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// next/navigation redirect / notFound throw control-flow signals; capture them
// instead of executing the throw. This route uses redirect() (307), NOT
// permanentRedirect() (308): its target's existence is F9-flag-dependent, so a
// cached 308 would bypass the notFound() guard if the flag flips off (R2-5).
// It is ALSO F9-gated: when FEATURE_F9_DASHBOARD is dark, the Account hub's
// Data & privacy section does not render, so the page calls notFound() (the
// pre-D2 page's behaviour) rather than redirecting the member onto a hub with
// no `#data-privacy` anchor.
//
// `env.features.f9Dashboard` is read at call time, so we vi.doMock '@/lib/env'
// per-case and re-import the page module with a reset registry to flip the flag.
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
vi.mock('next/navigation', () => ({ redirect, notFound }));

async function loadPage(f9Dashboard: boolean) {
  vi.resetModules();
  vi.doMock('next/navigation', () => ({ redirect, notFound }));
  vi.doMock('@/lib/env', () => ({ env: { features: { f9Dashboard } } }));
  const mod = await import('@/app/(member)/portal/account/data-export/page');
  return mod.default;
}

beforeEach(() => {
  redirect.mockClear();
  notFound.mockClear();
});

afterEach(() => {
  vi.doUnmock('@/lib/env');
  // Flush the env module cache so a stale per-case mock can't trap a later
  // test (R2-10).
  vi.resetModules();
});

describe('/portal/account/data-export route preservation (G2)', () => {
  it('F9 ON → redirects (307) to the Account-hub data-privacy anchor (never 404)', async () => {
    const PortalDataExportPage = await loadPage(true);
    await expect(PortalDataExportPage()).rejects.toThrow(
      'NEXT_REDIRECT:/portal/account#data-privacy',
    );
    expect(redirect).toHaveBeenCalledWith('/portal/account#data-privacy');
    expect(notFound).not.toHaveBeenCalled();
  });

  it('F9 OFF → notFound() (preserves the old 404; hub renders no data-privacy section when dark)', async () => {
    const PortalDataExportPage = await loadPage(false);
    await expect(PortalDataExportPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
  });
});
