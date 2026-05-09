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

export function TierUpgradeErrorRetry({
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
          per ux-standards.md § 10 (canonical Motion & Animation —
          "Do not add per-component motion-reduce modifiers; the
          global rule covers them"; also restated in § 19 overflow-
          menu prose). Round 4 IMP-11: `retryingLabel` provides a
          non-motion text fallback so reduced-motion users see textual
          loading feedback (mirrors F7 broadcasts retry pattern). */}
      {isPending && (
        <Loader2 className="mr-2 size-3.5 animate-spin" aria-hidden />
      )}
      {isPending ? retryingLabel : label}
    </Button>
  );
}
