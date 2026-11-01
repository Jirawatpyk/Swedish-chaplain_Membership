/**
 * #48 — close the dialog and refresh the page, now or once the connection is
 * back.
 *
 * `router.refresh()` while the browser is offline falls through to a full
 * navigation onto the browser's offline page (the refund dialog hit this in
 * R112). So when `navigator.onLine` says offline, the dialog and its warning
 * stay open and both steps wait for one `online` event; the caller shows the
 * wait. One listener at a time: the latest caller's `close` is the one that
 * runs, so a second dialog's Refresh is never dropped behind the first's.
 *
 * Known limit: `navigator.onLine` reads true on a network that reaches no
 * server (captive portal, VPN loss), so Refresh then runs at once.
 */
let pendingClose: (() => void) | null = null;

export function refreshWhenOnline(
  router: { refresh: () => void },
  close: () => void,
): 'waiting' | 'done' {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const alreadyWaiting = pendingClose !== null;
    pendingClose = close;
    if (!alreadyWaiting) {
      window.addEventListener(
        'online',
        () => {
          const latest = pendingClose;
          pendingClose = null;
          latest?.();
          router.refresh();
        },
        { once: true },
      );
    }
    return 'waiting';
  }
  close();
  router.refresh();
  return 'done';
}
