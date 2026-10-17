'use client';

/**
 * F9 (FR-004) — per-insight dismiss control (icon-only trigger). The owning
 * `InsightsPanel` handles the optimistic hide + POST + toast + `router.refresh()`
 * (it stays mounted across the request; this button unmounts the instant its
 * line is optimistically removed, so it must NOT own the in-flight fetch). The
 * visible label is icon-only, so `aria-label` carries the accessible name.
 */
import { IconButton } from '@jirawatpyk/aura-react';

export function InsightDismissButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  // Spec 122 US11: AURA's icon button. 32px, 44px on phones and coarse
  // pointers (`touchHeight`); `label` is its accessible name and tooltip.
  return <IconButton icon="x" label={label} touchHeight className="shrink-0" onClick={onClick} />;
}
