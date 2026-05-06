'use client';

/**
 * F8 Phase 4 Wave K12-1 + K13-4 — error-card actions.
 *
 * K12-1 (UX-K-3) replaced the previous "Retry as a `<Link>` with
 * `?_retry=${id}` URL pollution" pattern with a proper button that runs
 * `router.refresh()` inside `useTransition`. K13-4 closes the three
 * R12 polish findings on the same component:
 *
 *   - **UX-R12-1** — `flex flex-col gap-2 sm:flex-row` so SV/TH labels
 *     don't overflow on viewports < 640px (sibling `RenewalsEmptyState`
 *     already follows this pattern).
 *   - **UX-R12-2 / CON-R12-1** — `aria-describedby` links the sr-only
 *     `referenceLabel` to the `<code>` element holding the correlationId.
 *     Without this, AT users navigating element-by-element hear the
 *     UUID with no context. WCAG 1.3.1 Info & Relationships hygiene.
 *   - **UX-R12-3** — visible pending label text during the in-flight
 *     RSC re-fetch (`pendingLabel` prop, default = `retryLabel`).
 *     Sighted users get explicit "Retrying…" feedback; AT users get the
 *     same via `aria-busy` + label change. Per ux-standards.md § 2.1
 *     async ≥100 ms operations should show explicit pending indicators.
 *
 * Reused on both `/admin/renewals` (pipeline) and
 * `/admin/renewals/settings/schedules` error states. Each surface passes
 * its own `goBackHref` and pre-translated labels (component stays free
 * of `next-intl` imports — small enough to be parameter-driven).
 *
 * `prefers-reduced-motion` — pending uses opacity + cursor only (no
 * spin animation). shadcn/ui's `<Button>` disabled style is the visual
 * channel; the label text change is the textual channel.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useTransition } from 'react';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';

const RETRY_SESSION_KEY = 'f8:renewals:retry-correlation';

export interface ErrorCardActionsProps {
  readonly correlationId: string;
  readonly goBackHref: string;
  readonly retryLabel: string;
  readonly goBackLabel: string;
  readonly referenceLabel: string;
  /**
   * K13-4 (UX-R12-3): label shown on the Retry button while the RSC
   * re-fetch is in flight. Defaults to `retryLabel` if omitted (the
   * `aria-busy` + `disabled` styling alone provides the busy channel
   * for AT users — but sighted users benefit from the textual change).
   */
  readonly pendingLabel?: string;
  /**
   * K13-2 (REL-R12-2): toast title when the SAME admin session
   * encounters a SECOND distinct error correlationId — i.e. they
   * clicked Retry and the server failed AGAIN with a different
   * underlying cause. Without this signal the user sees a fresh error
   * card and may not realise their retry actually executed.
   * If omitted no toast fires (component-level opt-out for surfaces
   * where toast feedback would be too noisy).
   */
  readonly retryFailedLabel?: string;
}

export function ErrorCardActions({
  correlationId,
  goBackHref,
  retryLabel,
  goBackLabel,
  referenceLabel,
  pendingLabel,
  retryFailedLabel,
}: ErrorCardActionsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // K13-4 (UX-R12-2 / CON-R12-1): unique id pairs the sr-only label
  // with the <code> via aria-describedby.
  const referenceId = useId();

  // K13-2 (REL-R12-2): when the error card mounts AGAIN with a
  // different correlationId from a prior render in the same session,
  // surface a toast so the admin sees the retry outcome ("retry was
  // attempted, but failed again — here is the new reference id").
  // Without this, `router.refresh()` is a silent re-render and the
  // user can't distinguish "retry didn't fire" from "retry fired and
  // failed again". sessionStorage persists across the unmount/mount
  // cycle that App Router does on RSC error transitions.
  useEffect(() => {
    if (typeof window === 'undefined' || !retryFailedLabel) return;
    try {
      const previous = window.sessionStorage.getItem(RETRY_SESSION_KEY);
      if (previous && previous !== correlationId) {
        toast.error(retryFailedLabel, { description: correlationId });
      }
      window.sessionStorage.setItem(RETRY_SESSION_KEY, correlationId);
    } catch {
      // sessionStorage unavailable (private mode, quota) — silent
      // degrade. The toast is a polish, not a security/correctness
      // surface; failure to show it is acceptable.
    }
    return () => {
      // Clear on unmount — the parent route navigated away (Go back
      // clicked, or retry succeeded so the error card is no longer
      // rendered). Without this, the next session-fresh error card
      // would falsely toast "retry failed".
      try {
        window.sessionStorage.removeItem(RETRY_SESSION_KEY);
      } catch {
        // ignore
      }
    };
  }, [correlationId, retryFailedLabel]);

  const handleRetry = () => {
    startTransition(() => {
      // App Router `router.refresh()` re-fetches every server component
      // on the matched route AND bypasses the RSC payload cache. No URL
      // mutation, no history entry. If the upstream load throws again
      // the error UI re-renders with a new correlationId — the
      // useEffect above then fires the retry-failed toast.
      router.refresh();
    });
  };

  return (
    <>
      {/* K13-4 (UX-R12-1): responsive collapse so SV "Försök igen" +
          "Gå tillbaka" don't overflow on small viewports. */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={handleRetry}
          disabled={isPending}
          aria-busy={isPending}
        >
          {isPending ? (pendingLabel ?? retryLabel) : retryLabel}
        </Button>
        <Link
          href={goBackHref}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {goBackLabel}
        </Link>
      </div>
      <div className="flex flex-col items-center gap-1">
        <span id={referenceId} className="sr-only">
          {referenceLabel}
        </span>
        <code
          aria-describedby={referenceId}
          className="text-xs text-muted-foreground font-mono"
        >
          {correlationId}
        </code>
      </div>
    </>
  );
}
