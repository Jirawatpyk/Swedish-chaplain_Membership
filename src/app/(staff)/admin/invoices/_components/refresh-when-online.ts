/**
 * #48 — close the dialog and refresh the page, now or once the connection is
 * back.
 *
 * `router.refresh()` while the browser is offline falls through to a full
 * navigation onto the browser's offline page (the refund dialog hit this in
 * R112). So when `navigator.onLine` says offline, the dialog and its warning
 * stay open and both steps wait for one `online` event. Repeat clicks while
 * waiting register nothing more.
 *
 * Known limit: `navigator.onLine` reads true on a network that reaches no
 * server (captive portal, VPN loss), so Refresh then runs at once.
 */
let waiting = false;

export function refreshWhenOnline(router: { refresh: () => void }, close: () => void): void {
  const go = () => {
    close();
    router.refresh();
  };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (waiting) return;
    waiting = true;
    window.addEventListener(
      'online',
      () => {
        waiting = false;
        go();
      },
      { once: true },
    );
    return;
  }
  go();
}
