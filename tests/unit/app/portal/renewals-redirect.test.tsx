import { describe, it, expect, vi } from 'vitest';

// vi.mock is hoisted — factory must NOT reference outer variables.
// Use vi.fn() inside the factory; retrieve the spy via vi.mocked() after import.
// The route is PERMANENTLY moved (308) → it calls permanentRedirect, not
// redirect (xhigh #4: a 307 re-pays the hop on every email-CTA click).
vi.mock('next/navigation', () => ({
  permanentRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_PERMANENT_REDIRECT:${url}`); // mirror permanentRedirect throw
  }),
}));

import { permanentRedirect } from 'next/navigation';
import RenewalPreferencesPage from '@/app/(member)/portal/preferences/renewals/page';

describe('/portal/preferences/renewals route preservation (G2)', () => {
  it('permanently redirects (308) to the Account-hub renewal anchor (never 404)', async () => {
    await expect(RenewalPreferencesPage()).rejects.toThrow(
      'NEXT_PERMANENT_REDIRECT:/portal/account#renewal-prefs',
    );
    expect(permanentRedirect).toHaveBeenCalledWith('/portal/account#renewal-prefs');
  });
});
