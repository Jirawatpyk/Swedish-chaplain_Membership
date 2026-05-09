/**
 * F8 Phase 7 review-fix Round 2 IMP-8 — Retry CTA for the tier-upgrade
 * queue error state. Client component because `router.refresh()` is
 * a client-only API. Pre-fetched i18n label is passed from the server
 * page (avoids loading next-intl runtime in the client bundle for a
 * single string).
 */
'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

export function TierUpgradeErrorRetry({ label }: { readonly label: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mt-3"
      disabled={isPending}
      aria-busy={isPending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {label}
    </Button>
  );
}
