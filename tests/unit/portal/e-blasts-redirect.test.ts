import { describe, expect, it, vi } from 'vitest';

// next/navigation redirect throws a control-flow signal in app-router; capture
// the target instead of executing the throw.
const redirectSpy = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({ redirect: redirectSpy }));

describe('/portal/benefits/e-blasts route preservation (058 G1)', () => {
  it('redirects to /portal/benefits?tab=broadcasts (no 404)', async () => {
    const mod = await import('@/app/(member)/portal/benefits/e-blasts/page');
    await expect(mod.default()).rejects.toThrow('REDIRECT:/portal/benefits?tab=broadcasts');
    expect(redirectSpy).toHaveBeenCalledWith('/portal/benefits?tab=broadcasts');
  });
});
