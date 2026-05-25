'use client';

/**
 * F9 (FR-004) — per-insight dismiss control. Posts to the dismiss endpoint,
 * then `router.refresh()` so the suppressed insight drops out of the
 * server-rendered panel on the next cycle. Toast confirms success/failure
 * (ux-standards § 5). The visible label is icon-only, so `aria-label` carries
 * the accessible name.
 */
import { useTransition } from 'react';
import { XIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export function InsightDismissButton({
  insightKey,
  scopeRef,
  label,
  successLabel,
  errorLabel,
}: {
  readonly insightKey: string;
  readonly scopeRef?: string;
  readonly label: string;
  readonly successLabel: string;
  readonly errorLabel: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onDismiss() {
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/insights/dismiss', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            insightKey,
            ...(scopeRef !== undefined ? { scopeRef } : {}),
          }),
        });
        if (!res.ok) {
          toast.error(errorLabel);
          return;
        }
        toast.success(successLabel);
        router.refresh();
      } catch {
        toast.error(errorLabel);
      }
    });
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-label={label}
      disabled={isPending}
      onClick={onDismiss}
    >
      <XIcon className="size-4" aria-hidden="true" />
    </Button>
  );
}
