/**
 * #48 — `refreshWhenOnline`: close the dialog and refresh now, or once the
 * connection is back. While offline it waits for one `online` event, and the
 * latest dialog's close is the one that runs (a second dialog's Refresh must
 * not be dropped behind the first one's).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelPendingRefresh,
  refreshWhenOnline,
} from '@/app/(staff)/admin/invoices/_components/refresh-when-online';

afterEach(() => {
  vi.restoreAllMocks();
  window.dispatchEvent(new Event('online'));
});

describe('refreshWhenOnline', () => {
  it('online: closes, refreshes and reports done', () => {
    const router = { refresh: vi.fn() };
    const close = vi.fn();
    expect(refreshWhenOnline(router, close)).toBe('done');
    expect(close).toHaveBeenCalledTimes(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('offline: reports waiting, then on reconnect runs the latest close once and refreshes once', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const router = { refresh: vi.fn() };
    const closeA = vi.fn();
    const closeB = vi.fn();
    expect(refreshWhenOnline(router, closeA)).toBe('waiting');
    expect(refreshWhenOnline(router, closeB)).toBe('waiting');
    expect(router.refresh).not.toHaveBeenCalled();
    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('online'));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('#727 review: the latest caller\'s router is the one that refreshes, not the first one\'s', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const first = { refresh: vi.fn() };
    const latest = { refresh: vi.fn() };
    refreshWhenOnline(first, vi.fn());
    refreshWhenOnline(latest, vi.fn());
    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    expect(latest.refresh).toHaveBeenCalledTimes(1);
    expect(first.refresh).not.toHaveBeenCalled();
  });

  it('#727 review: cancelPendingRefresh drops the wait, so a reconnect runs nothing', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const router = { refresh: vi.fn() };
    const close = vi.fn();
    refreshWhenOnline(router, close);
    cancelPendingRefresh();
    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    expect(router.refresh).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    // A later wait still works.
    onLine.mockReturnValue(false);
    refreshWhenOnline(router, close);
    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});
