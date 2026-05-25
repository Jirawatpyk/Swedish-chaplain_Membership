'use client';

/**
 * F9 activity-feed refresh control (FR-003). The feed is a server-rendered
 * snapshot of recent audit events, so a static `aria-live` on the list never
 * fires. This client button re-fetches via `router.refresh()` and announces
 * completion through a real polite live region so assistive-tech users get
 * feedback (the static list cannot provide it).
 */
import { useState, useTransition } from 'react';
import { RotateCwIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

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

  function onRefresh() {
    startTransition(() => router.refresh());
    // Clear then re-set so a SECOND refresh re-triggers the polite live region —
    // setting the identical string produces no mutation and would stay silent.
    setAnnounced('');
    setTimeout(() => setAnnounced(refreshedLabel), 50);
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={isPending}
        onClick={onRefresh}
      >
        <RotateCwIcon
          className={isPending ? 'motion-safe:animate-spin' : undefined}
          aria-hidden="true"
        />
        {refreshLabel}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>
    </>
  );
}
