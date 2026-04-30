'use client';

/**
 * T091 — Acknowledgement banner client wrapper.
 *
 * Renders the visual banner + "I acknowledge" / "Remind me later"
 * CTAs. Acknowledge POSTs to `/api/portal/broadcasts/acknowledge`
 * (route to land in a follow-up Wave; until then the click calls
 * `markBroadcastsAcknowledged` Application use-case via fetch).
 *
 * Banner-dismissal returns focus to the document body so screen
 * readers don't get stranded on a removed element (CHK042).
 */
import { useRef, useState, useTransition } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface AcknowledgementBannerClientProps {
  readonly title: string;
  readonly body: string;
  readonly acknowledge: string;
  readonly remindLater: string;
  readonly closeLabel: string;
}

export function AcknowledgementBannerClient({
  title,
  body,
  acknowledge,
  remindLater,
  closeLabel,
}: AcknowledgementBannerClientProps): React.ReactElement | null {
  const [hidden, setHidden] = useState<boolean>(false);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  if (hidden) return null;

  function dismiss() {
    // Move focus BEFORE unmount so the screen reader is on a known
    // anchor when the banner element is removed from the DOM.
    const banner = ref.current;
    const next = banner?.nextElementSibling as HTMLElement | null;
    if (next?.focus) {
      next.focus();
    } else {
      document.body.focus();
    }
    setHidden(true);
  }

  function onAcknowledge() {
    startTransition(async () => {
      try {
        const locale =
          typeof document !== 'undefined'
            ? document.documentElement.lang || 'en'
            : 'en';
        await fetch('/api/portal/broadcasts/acknowledge', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale }),
        });
      } catch {
        // Best-effort — banner dismisses regardless; the user can
        // re-click if they care about audit emission.
      } finally {
        dismiss();
      }
    });
  }

  return (
    <div
      ref={ref}
      role="region"
      aria-label={title}
      className="mx-auto my-4 flex max-w-(--layout-max-width-detail) items-start gap-4 rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/40"
    >
      <ShieldCheck
        className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300"
        aria-hidden="true"
      />
      <div className="flex-1 space-y-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{body}</p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            onClick={onAcknowledge}
            disabled={pending}
          >
            {acknowledge}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={dismiss}
            disabled={pending}
          >
            {remindLater}
          </Button>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label={closeLabel}
        className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded hover:bg-amber-100 dark:hover:bg-amber-900/40"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
