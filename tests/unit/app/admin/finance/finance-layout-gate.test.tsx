/**
 * #78 (R141) — `/admin/finance` is gated in its segment LAYOUT, not only in
 * the page. The page sits inside the segment's `loading.tsx` Suspense
 * boundary, so a `notFound()` thrown there arrives after the response has
 * started streaming with HTTP 200 (measured on a production build, relay
 * rev 70). The layout renders outside that boundary, so its `notFound()`
 * still sets 404. This pins the gate's three outcomes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const features = { invoiceDashboard: true };
vi.mock('@/lib/env', () => ({ env: { features } }));
const notFound = vi.fn(() => {
  throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
});
vi.mock('next/navigation', () => ({ notFound }));
const requirePagePermission = vi.fn();
const canPerform = vi.fn();
vi.mock('@/lib/rbac', () => ({ requirePagePermission, canPerform }));

const { default: FinanceLayout } = await import('@/app/(staff)/admin/finance/layout');

describe('/admin/finance segment layout gate (#78)', () => {
  beforeEach(() => {
    features.invoiceDashboard = true;
    notFound.mockClear();
    requirePagePermission.mockReset().mockResolvedValue({ user: { role: 'admin' } });
    canPerform.mockReset().mockReturnValue(true);
  });

  it('answers not-found when the dashboard flag is off', async () => {
    features.invoiceDashboard = false;
    await expect(FinanceLayout({ children: 'page' })).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it('answers not-found for a role without insights.finance', async () => {
    canPerform.mockReturnValue(false);
    await expect(FinanceLayout({ children: 'page' })).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(canPerform).toHaveBeenCalledWith('admin', 'insights.finance');
  });

  it('renders the page for an admin with the flag on, after the invoicing.read page guard', async () => {
    const out = (await FinanceLayout({ children: 'page' })) as ReactElement | string;
    expect(out).toBe('page');
    expect(requirePagePermission).toHaveBeenCalledWith('invoicing.read');
    expect(notFound).not.toHaveBeenCalled();
  });
});
