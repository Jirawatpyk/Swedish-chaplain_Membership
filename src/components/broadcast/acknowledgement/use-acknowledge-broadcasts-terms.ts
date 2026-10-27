'use client';

/**
 * The company's E-Blast sending-terms acknowledgement (Q15), as the two
 * surfaces that show the rules record it: the portal banner and the compose
 * page (spec 122 PR C). One POST, one set of toasts, one place to fix them.
 *
 * Once recorded in this tab, both surfaces hear it through a window event and
 * a module flag, without `router.refresh()`: a refresh re-ran the whole
 * compose page on the server (and could lose an unsaved draft), and the
 * banner lives in a layout that client navigation does not re-render.
 */
import { useSyncExternalStore, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';

export const BROADCASTS_ACKNOWLEDGED_EVENT = 'chamber-os:broadcasts-acknowledged';

let acknowledgedInThisTab = false;

/** Records that the acknowledgement was stored, and tells every surface. */
export function announceBroadcastsAcknowledged(): void {
  acknowledgedInThisTab = true;
  window.dispatchEvent(new Event(BROADCASTS_ACKNOWLEDGED_EVENT));
}

/** Test seam: the flag is module state and outlives a render. */
export function resetAcknowledgedForTests(): void {
  acknowledgedInThisTab = false;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(BROADCASTS_ACKNOWLEDGED_EVENT, onChange);
  return () => window.removeEventListener(BROADCASTS_ACKNOWLEDGED_EVENT, onChange);
}

/** True once this tab has recorded the acknowledgement (false on the server). */
export function useBroadcastsAcknowledgedInThisTab(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => acknowledgedInThisTab,
    () => false,
  );
}

export function useAcknowledgeBroadcastsTerms({
  locale,
  failureHint,
  onAcknowledged,
}: {
  /** Server-resolved locale, recorded on the audit row. */
  readonly locale: 'en' | 'th' | 'sv';
  /** What stays on screen after a failure, said in the error toast. */
  readonly failureHint: string;
  readonly onAcknowledged?: () => void;
}): { readonly acknowledge: () => void; readonly pending: boolean } {
  const t = useTranslations('portal.broadcasts.banner.acknowledgement');
  const readOnlyToast = useReadOnlyToast();
  const [pending, startTransition] = useTransition();

  function acknowledge(): void {
    startTransition(async () => {
      try {
        const res = await fetch('/api/portal/broadcasts/acknowledge', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale }),
        });
        if (!res.ok) {
          // The write freeze: nothing was recorded, and the rules stay.
          if (await isReadOnlyResponse(res)) {
            readOnlyToast();
            return;
          }
          toast.error(t('toastAcknowledgeFailed'), { description: failureHint });
          return;
        }
        toast.success(t('toastAcknowledged'), { duration: 3000 });
        onAcknowledged?.();
        announceBroadcastsAcknowledged();
      } catch (e) {
        // Bind the cause so it reaches the console, not only a generic toast.
        console.error('[broadcasts.acknowledge] network error', e);
        toast.error(t('toastAcknowledgeFailed'), { description: failureHint });
      }
    });
  }

  return { acknowledge, pending };
}
