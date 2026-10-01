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
 *
 * 122 US7a (T709): an AURA secondary button; its `loading` state carries the
 * spinner (AURA honours reduced motion) beside the "Retrying…" text.
 */
'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@jirawatpyk/aura-react';

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
      variant="secondary"
      size="sm"
      className="mt-[var(--aura-space-3)]"
      loading={isPending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {isPending ? retryingLabel : label}
    </Button>
  );
}
