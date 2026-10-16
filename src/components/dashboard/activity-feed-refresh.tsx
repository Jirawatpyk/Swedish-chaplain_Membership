'use client';

/**
 * F9 activity-feed refresh control (FR-003). The feed is a server-rendered
 * snapshot of recent audit events, so a static `aria-live` on the list never
 * fires. This client button re-fetches via `router.refresh()` and announces
 * completion through a real polite live region so assistive-tech users get
 * feedback (the static list cannot provide it).
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { RotateCwIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@jirawatpyk/aura-react';

export function ActivityFeedRefresh({
  refreshLabel,
  refreshedLabel,
}: {
  readonly refreshLabel: string;
  readonly refreshedLabel: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [announced, setAnnounced] = useState('');
  const requestedRef = useRef(false);

  // Announce ONLY after the refresh transition actually resolves (the
  // `isPending` true→false edge) — a blind `setTimeout(…, 50)` fired the
  // "refreshed" message before the server round-trip completed and could
  // under-fire on NVDA. `onRefresh` already cleared `announced`, so the set on
  // the next tick is a real '' → label mutation that re-triggers the polite
  // region even on a repeat refresh (an identical string is no mutation → silent).
  useEffect(() => {
    if (isPending || !requestedRef.current) return undefined;
    requestedRef.current = false;
    const id = setTimeout(() => setAnnounced(refreshedLabel), 80);
    return () => clearTimeout(id);
  }, [isPending, refreshedLabel]);

  function onRefresh() {
    requestedRef.current = true;
    setAnnounced('');
    startTransition(() => router.refresh());
  }

  return (
    <>
      {/* Spec 122 US11: AURA ghost button. \`loading\` sets aria-busy, shows
          AURA's spinner and swallows clicks while the refresh is in flight
          (one refresh at a time, as before), and keeps focus on the button. */}
      <Button
        variant="ghost"
        size="sm"
        touchHeight
        icon={<RotateCwIcon />}
        loading={isPending}
        onClick={onRefresh}
      >
        {refreshLabel}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>
    </>
  );
}
