import { describe, it, expect, vi } from 'vitest';

// vi.mock is hoisted — factory must NOT reference outer variables.
// Use vi.fn() inside the factory; retrieve the spy via vi.mocked() after import.
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`); // mirror next/navigation redirect throw
  }),
}));

import { redirect } from 'next/navigation';
import RenewalPreferencesPage from '@/app/(member)/portal/preferences/renewals/page';

describe('/portal/preferences/renewals route preservation (G2)', () => {
  it('redirects to the Account-hub renewal anchor (never 404)', async () => {
    await expect(RenewalPreferencesPage()).rejects.toThrow(
      'NEXT_REDIRECT:/portal/account#renewal-prefs',
    );
    expect(redirect).toHaveBeenCalledWith('/portal/account#renewal-prefs');
  });
});
