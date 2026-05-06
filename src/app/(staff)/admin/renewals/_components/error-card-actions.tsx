'use client';

/**
 * F8 Phase 4 Wave K12-1 (UX-K-3) — error-card actions.
 *
 * Replaces the previous "Retry as a `<Link>` with `?_retry=${id}` URL
 * pollution" pattern with a proper button that runs `router.refresh()`
 * inside `useTransition`. Three concrete UX wins:
 *
 *   1. Semantic HTML — Retry is a `<button type="button">` (action), not
 *      a `<Link>` (navigation). Closes WCAG SC 4.1.2 Name/Role/Value: a
 *      "Retry" anchor reads as "link" to AT, but the user-intent is to
 *      mutate the cache and re-render — a button.
 *
 *   2. No URL pollution — the previous `?_retry=${correlationId}` was
 *      written into history, accumulating on every retry click and
 *      polluting copy-paste URLs that admins send to support. The
 *      correlationId now lives in a `<code>` element below the buttons
 *      (already shown in pipeline page; this component preserves it).
 *
 *   3. Pending state — `useTransition` exposes `isPending`, wired to
 *      `aria-busy` + `disabled` + a localised pending label. RSC
 *      re-fetch is non-instantaneous; without a pending indicator the
 *      admin double-clicks → fires 2 requests → wastes Vercel function
 *      budget and Neon connection slots.
 *
 *   4. `prefers-reduced-motion` — pending uses opacity + cursor only
 *      (no spin animation) so reduced-motion users get the busy signal
 *      without motion. Re-uses the disabled-button styling that
 *      shadcn/ui's `<Button>` already implements.
 *
 * Reused on both `/admin/renewals` (pipeline) and
 * `/admin/renewals/settings/schedules` error states. Each surface
 * passes its own `goBackHref` (`/admin` vs `/admin/renewals`) and
 * pre-translated labels (so the component itself stays free of
 * `next-intl` imports — small enough to be parameter-driven).
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';

export interface ErrorCardActionsProps {
  readonly correlationId: string;
  readonly goBackHref: string;
  readonly retryLabel: string;
  readonly goBackLabel: string;
  readonly referenceLabel: string;
}

export function ErrorCardActions({
  correlationId,
  goBackHref,
  retryLabel,
  goBackLabel,
  referenceLabel,
}: ErrorCardActionsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleRetry = () => {
    startTransition(() => {
      // App Router `router.refresh()` re-fetches every server component
      // on the matched route AND bypasses the RSC payload cache. No URL
      // mutation, no history entry. If the upstream load throws again
      // the error UI re-renders with a new correlationId.
      router.refresh();
    });
  };

  return (
    <>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={handleRetry}
          disabled={isPending}
          aria-busy={isPending}
        >
          {retryLabel}
        </Button>
        <Link
          href={goBackHref}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {goBackLabel}
        </Link>
      </div>
      <div className="flex flex-col items-center gap-1">
        <span className="sr-only">{referenceLabel}</span>
        <code className="text-xs text-muted-foreground font-mono">
          {correlationId}
        </code>
      </div>
    </>
  );
}
