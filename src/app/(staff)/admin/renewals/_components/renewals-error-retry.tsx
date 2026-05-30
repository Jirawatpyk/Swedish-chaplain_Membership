/**
 * Shared retry CTA for renewals admin error states (extracted from
 * `tier-upgrades/_components/tier-upgrade-error-retry.tsx` during F8
 * Phase 8 review-fix Round 5 — IMP-2 close).
 *
 * Client component because `router.refresh()` is a client-only API.
 * Pre-fetched i18n labels are passed from the server page (avoids
 * loading next-intl runtime in the client bundle for two strings).
 *
 * Used by tier-upgrades + tasks queues. Future renewals surfaces with
 * an error-card retry should consume this primitive rather than re-
 * implementing the pattern.
 */
'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function RenewalsErrorRetry({
  label,
  retryingLabel,
}: {
  readonly label: string;
  readonly retryingLabel: string;
}) {
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
      {/* Round 4 IMP-10 + Round 5 IMP-7: dropped per-component
          motion-reduce modifier; globals.css (lines 422-433) already
          neutralises `.animate-spin` for prefers-reduced-motion users
          per ux-standards.md § 10. `retryingLabel` provides a non-
          motion text fallback so reduced-motion users see textual
          loading feedback. */}
      {isPending && (
        <Loader2 className="mr-2 size-3.5 motion-safe:animate-spin" aria-hidden />
      )}
      {isPending ? retryingLabel : label}
    </Button>
  );
}
