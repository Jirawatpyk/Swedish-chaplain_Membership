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
import { Loader2 } from 'lucide-react';
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
      {/* Round 3 UX SUG-2: spinner during pending state per ux-standards § 5.
          motion-reduce:hidden respects prefers-reduced-motion. */}
      {isPending && (
        <Loader2
          className="mr-2 size-3.5 animate-spin motion-reduce:hidden"
          aria-hidden
        />
      )}
      {label}
    </Button>
  );
}
