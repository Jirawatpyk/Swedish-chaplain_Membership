import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * QuickAction — a transactional dashboard shortcut (Pay invoice, View
 * benefits, Renew, Edit profile). Rendered as a real `<Link>` so it is
 * a navigable anchor (role=link) with working back-button / deep-link
 * behaviour.
 *
 * Touch target ≥44px (WCAG 2.5.8, spec §7): `min-h-11` is Tailwind's
 * 2.75rem = 44px. The icon is decorative (`aria-hidden`) — the visible
 * label is the accessible name. Chrome reuses `buttonVariants` to match
 * the existing portal button language. Server-safe (no hooks); the
 * caller passes an already-localised `label`.
 */
export interface QuickActionProps {
  readonly href: string;
  /** Already-localised action label (also the accessible name). */
  readonly label: string;
  readonly icon: LucideIcon;
  /** `primary` = filled CTA, `secondary` = outline. Defaults to primary. */
  readonly emphasis?: 'primary' | 'secondary';
  readonly className?: string;
}

export function QuickAction({
  href,
  label,
  icon: Icon,
  emphasis = 'primary',
  className,
}: QuickActionProps) {
  return (
    <Link
      href={href}
      data-emphasis={emphasis}
      className={cn(
        buttonVariants({
          variant: emphasis === 'primary' ? 'default' : 'outline',
        }),
        // min-h-11 = 44px target; justify-start + full width so the
        // 2×2 mobile grid (spec §4.1) reads as tappable rows.
        'min-h-11 w-full justify-start gap-2 px-3',
        className,
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {label}
    </Link>
  );
}
