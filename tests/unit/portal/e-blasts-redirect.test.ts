import { describe, expect, it, vi } from 'vitest';

// next/navigation permanentRedirect throws a control-flow signal in app-router;
// capture the target instead of executing the throw. The route is PERMANENTLY
// moved (308) → permanentRedirect, not redirect (xhigh #4: a 307 re-pays the
// hop on every email/bookmark deep-link click).
const permanentRedirectSpy = vi.fn((url: string) => {
  throw new Error(`PERMANENT_REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({ permanentRedirect: permanentRedirectSpy }));

describe('/portal/benefits/e-blasts route preservation (058 G1)', () => {
  it('permanently redirects (308) to /portal/benefits?tab=broadcasts (no 404)', async () => {
    const mod = await import('@/app/(member)/portal/benefits/e-blasts/page');
    await expect(mod.default()).rejects.toThrow('PERMANENT_REDIRECT:/portal/benefits?tab=broadcasts');
    expect(permanentRedirectSpy).toHaveBeenCalledWith('/portal/benefits?tab=broadcasts');
  });
});
