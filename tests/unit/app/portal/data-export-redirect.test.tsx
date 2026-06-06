import { describe, it, expect, vi } from 'vitest';

// next/navigation redirect throws a control-flow signal; capture the target.
// NOTE: define the spy INSIDE the factory (vi.mock is hoisted above top-level
// consts; referencing an outer const here throws "Cannot access before
// initialization" because the page is imported at top level, which evaluates
// the factory before the const). Use vi.mocked(redirect) to assert.
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

import { redirect } from 'next/navigation';
import PortalDataExportPage from '@/app/(member)/portal/account/data-export/page';

describe('/portal/account/data-export route preservation (G2)', () => {
  it('redirects to the Account-hub data-privacy anchor (never 404)', async () => {
    await expect(PortalDataExportPage()).rejects.toThrow('NEXT_REDIRECT:/portal/account#data-privacy');
    expect(vi.mocked(redirect)).toHaveBeenCalledWith('/portal/account#data-privacy');
  });
});
