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

/**
 * The members (companies) acknowledged in this tab. Keyed, not a single flag:
 * sign-out and sign-in are client navigations, so this module outlives a
 * session, and company A's acknowledgement must not hide company B's rules.
 */
const acknowledgedInThisTab = new Set<string>();

/** Records that the member's acknowledgement was stored, and tells every surface. */
export function announceBroadcastsAcknowledged(memberId: string): void {
  acknowledgedInThisTab.add(memberId);
  window.dispatchEvent(new Event(BROADCASTS_ACKNOWLEDGED_EVENT));
}

/** Test seam: the set is module state and outlives a render. */
export function resetAcknowledgedForTests(): void {
  acknowledgedInThisTab.clear();
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(BROADCASTS_ACKNOWLEDGED_EVENT, onChange);
  return () => window.removeEventListener(BROADCASTS_ACKNOWLEDGED_EVENT, onChange);
}

/** True once this tab has recorded the member's acknowledgement (false on the server). */
export function useBroadcastsAcknowledgedInThisTab(memberId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => acknowledgedInThisTab.has(memberId),
    () => false,
  );
}

export function useAcknowledgeBroadcastsTerms({
  memberId,
  locale,
  failureHint,
  onAcknowledged,
}: {
  /** The signed-in member (company) the acknowledgement is recorded for. */
  readonly memberId: string;
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
        announceBroadcastsAcknowledged(memberId);
      } catch (e) {
        // Bind the cause so it reaches the console, not only a generic toast.
        console.error('[broadcasts.acknowledge] network error', e);
        toast.error(t('toastAcknowledgeFailed'), { description: failureHint });
      }
    });
  }

  return { acknowledge, pending };
}
