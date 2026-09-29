/**
 * 122 US5b-1 — the Suspense fallback of a member-detail section card: the
 * card frame, a title bar and a few rows, so nothing jumps when the section
 * streams in (ux-standards § 2.1). Decorative: `aria-hidden`, and no name
 * (a section named by an empty heading is an axe violation); the page's own
 * loading state speaks for it.
 */
import { SkeletonBlock } from '@/components/shell/page-skeletons';

export function SectionCardSkeleton({
  rows = 3,
  action = false,
  className,
}: {
  readonly rows?: number;
  /** A button-sized block beside the title (the card has an action). */
  readonly action?: boolean;
  readonly className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`flex flex-col gap-4 rounded-[var(--aura-card-radius)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] p-5 max-sm:p-4 ${className ?? ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <SkeletonBlock className="h-5 w-32" />
        {action && <SkeletonBlock className="h-8 w-28" />}
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: rows }).map((_, i) => (
          <SkeletonBlock key={i} className={i === rows - 1 ? 'h-8 w-3/4' : 'h-8 w-full'} />
        ))}
      </div>
    </div>
  );
}
