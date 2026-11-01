/**
 * #48 — refresh the page now, or once the connection is back.
 *
 * `router.refresh()` while the browser is offline falls through to a full
 * navigation that lands on the browser's offline page (the refund dialog hit
 * this in R112). After a dropped connection the admin's Refresh therefore
 * waits for one `online` event when `navigator.onLine` says offline.
 */
export function refreshWhenOnline(router: { refresh: () => void }): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    window.addEventListener('online', () => router.refresh(), { once: true });
    return;
  }
  router.refresh();
}
