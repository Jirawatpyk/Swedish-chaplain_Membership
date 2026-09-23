'use client';

/**
 * The unsaved-changes guard, both halves of it.
 *
 * `useBeforeUnloadGuard` covers the exits the BROWSER owns — a close, a
 * reload, a navigation to another origin. It does not fire for an in-app
 * `<Link>`, and the portal live walk (2026-09-22, U27) measured what that
 * costs: a dirty compose form with four shell header links directly above it
 * and five fixed bottom-tab links directly below lost the typed draft on a
 * single click of "Dashboard", instantly and silently. FR-045 / SC-012 claim
 * "zero cases of typed content lost without a confirmation".
 *
 * So the in-app arm lives here, beside the unload arm, and every surface that
 * has unsaved state renders THIS rather than calling the unload hook directly:
 * the member compose form, the staff compose-on-behalf form and Brand settings
 * (T155 U18) now guard the same two exits with the same words.
 *
 * What is deliberately NOT intercepted, because the member is not leaving the
 * page in this tab: a modified click (cmd / ctrl / shift / alt, or any button
 * but the primary one), `target` other than the current tab, `download`,
 * `rel="external"`, another origin, a non-http(s) scheme such as `mailto:`,
 * a link to the URL we are already on (a pure hash change), and a link inside
 * a `contenteditable` region (the editor's own content, where a click only
 * places the caret).
 *
 * The listener is CAPTURE-phase on `document`, so it decides before React's
 * root container sees the click: `stopPropagation` there is what keeps Next's
 * `<Link>` handler from navigating, and `preventDefault` is what keeps a plain
 * `<a>` from doing so. Both are needed — a `<Link>` renders a real anchor.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { useBeforeUnloadGuard } from '@/hooks/use-beforeunload-guard';

/**
 * The in-app destination this click would reach, or `null` when the click is
 * not one this guard owns. Exported for its own unit coverage; pure apart from
 * reading `window.location`, which is the comparison the rule is about.
 */
export function guardedNavigationTarget(
  anchor: HTMLAnchorElement,
): string | null {
  const target = anchor.getAttribute('target');
  if (target !== null && target !== '' && target !== '_self') return null;
  if (anchor.hasAttribute('download')) return null;
  const rel = (anchor.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
  if (rel.includes('external')) return null;

  const raw = anchor.getAttribute('href');
  if (raw === null || raw === '') return null;

  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return null;
  }
  // `mailto:` / `tel:` parse but carry the opaque origin "null", so the origin
  // comparison alone already refuses them; the scheme check says so plainly.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin !== window.location.origin) return null;
  // Same page — a hash-only link moves focus, it does not leave anything.
  if (
    url.pathname === window.location.pathname &&
    url.search === window.location.search
  ) {
    return null;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export interface UnsavedChangesGuardProps {
  /** True while the surface holds changes that leaving would discard. */
  readonly armed: boolean;
}

export function UnsavedChangesGuard({
  armed,
}: UnsavedChangesGuardProps): React.ReactElement {
  const t = useTranslations('common.unsavedChanges');
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  /**
   * The anchor that was clicked. It is still mounted — the navigation was
   * cancelled — so it is where focus belongs when the dialog closes either
   * way. Held in a ref behind a STABLE callback because Base UI reads the
   * `finalFocus` prop from the LATEST render when the dialog closes, not from
   * the render that opened it, and on that closing render `pendingHref` is
   * already `null`, so anything derived from it would be gone.
   */
  const triggerRef = useRef<HTMLElement | null>(null);

  useBeforeUnloadGuard(armed);

  useEffect(() => {
    if (!armed) return undefined;
    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented) return;
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      // A link inside the rich-text editor is content being edited: the click
      // places the caret, it leaves nothing. The CTA block renders a plain
      // `<a data-eb="cta" href>` with no `target`, so a same-origin CTA would
      // otherwise be read as an exit. Matched by attribute, not
      // `isContentEditable`: jsdom does not implement that property, and an
      // atom node that renders `contenteditable="false"` still sits inside an
      // editable ancestor that this selector finds.
      if (anchor.closest('[contenteditable]:not([contenteditable="false"])')) {
        return;
      }
      const href = guardedNavigationTarget(anchor);
      if (href === null) return;
      event.preventDefault();
      event.stopPropagation();
      triggerRef.current = anchor;
      setPendingHref(href);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [armed]);

  const finalFocus = useCallback(
    (): HTMLElement | false | null => triggerRef.current,
    [],
  );

  return (
    <ConfirmationDialog
      open={pendingHref !== null}
      onOpenChange={(open) => {
        if (!open) setPendingHref(null);
      }}
      title={t('title')}
      description={t('description')}
      confirmLabel={t('confirmLabel')}
      cancelLabel={t('cancelLabel')}
      finalFocus={finalFocus}
      onConfirm={() => {
        if (pendingHref !== null) router.push(pendingHref);
      }}
    />
  );
}
