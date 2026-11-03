/**
 * #48 — close the dialog and refresh the page, now or once the connection is
 * back.
 *
 * `router.refresh()` while the browser is offline falls through to a full
 * navigation onto the browser's offline page (the refund dialog hit this in
 * R112). So when `navigator.onLine` says offline, the dialog and its warning
 * stay open and both steps wait for one `online` event; the caller shows the
 * wait. One listener at a time: the latest caller's `close` and `refresh` are
 * the ones that run, so a second dialog's Refresh is never dropped behind the
 * first's.
 *
 * Known limit: `navigator.onLine` reads true on a network that reaches no
 * server (captive portal, VPN loss), so Refresh then runs at once.
 */
let pending: { readonly refresh: () => void; readonly close: () => void } | null = null;
let listening = false;

function onOnline(): void {
  listening = false;
  const latest = pending;
  pending = null;
  latest?.close();
  latest?.refresh();
}

/**
 * #727 review — drop a pending offline wait, so a reconnect runs nothing.
 * Called when the form submits again: a navigation queued before it would
 * otherwise fire later and pull the admin off the page.
 */
export function cancelPendingRefresh(): void {
  pending = null;
}

export function refreshWhenOnline(
  router: { refresh: () => void },
  close: () => void,
): 'waiting' | 'done' {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    // The latest caller's pair is the one that runs, router included (#727
    // review: the first caller's router used to run with the latest close).
    pending = { refresh: () => router.refresh(), close };
    if (!listening) {
      listening = true;
      window.addEventListener('online', onOnline, { once: true });
    }
    return 'waiting';
  }
  close();
  router.refresh();
  return 'done';
}
