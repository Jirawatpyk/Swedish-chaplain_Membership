/**
 * F9 (FR-004) — per-insight dismiss control (icon-only trigger). The owning
 * `InsightsPanel` handles the optimistic hide + POST + toast + `router.refresh()`
 * (it stays mounted across the request; this button unmounts the instant its
 * line is optimistically removed, so it must NOT own the in-flight fetch). The
 * visible label is icon-only, so `aria-label` carries the accessible name.
 */
import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function InsightDismissButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      // 28px visual, but a `::before` overlay extends the tap target to ~44px
      // (WCAG 2.5.5 mobile) without affecting the row layout (absolute pseudo).
      className="relative size-7 shrink-0 before:absolute before:-inset-2 before:content-['']"
      aria-label={label}
      onClick={onClick}
    >
      <XIcon className="size-4" aria-hidden="true" />
    </Button>
  );
}
