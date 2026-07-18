'use client';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useScrollSpy } from './use-scroll-spy';

export interface SectionNavItem {
  readonly id: string;
  readonly labelKey: string;
}

const MOBILE_SELECT_ID = 'invoice-settings-section-jump';

/**
 * `false` on SSR (no `window`) and in jsdom (no real `matchMedia`
 * implementation) — both report "no preference", which keeps `goTo`'s
 * default at `'smooth'`. Only a real browser that explicitly advertises
 * `prefers-reduced-motion: reduce` flips this to `true`.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Scrolls the target section into view, then moves focus to its heading
 * (`[data-section-heading]`, which carries `tabIndex={-1}`) so keyboard
 * and screen-reader users land where sighted users land visually.
 */
function goToSection(id: string): void {
  const section = document.getElementById(id);
  section?.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: 'start',
  });
  // I4 (wave B) — `{ preventScroll: true }` stops the browser's own
  // scroll-into-view-on-focus from snap-cancelling the smooth
  // `scrollIntoView` animation above in Safari/Firefox. Focus still
  // lands on the heading; only the browser's redundant auto-scroll is
  // suppressed.
  section?.querySelector<HTMLElement>('[data-section-heading]')?.focus({ preventScroll: true });
}

export function SectionNav({ sections }: { readonly sections: ReadonlyArray<SectionNavItem> }) {
  const t = useTranslations('admin.invoiceSettings');
  // Stable id list — a fresh array every render would tear down and
  // rebuild useScrollSpy's IntersectionObserver on every render (its
  // effect depends on `[sectionIds]` by reference).
  const sectionIds = useMemo(() => sections.map((section) => section.id), [sections]);
  const active = useScrollSpy(sectionIds);
  const selectedId = active ?? sections[0]?.id ?? '';

  return (
    <>
      <nav
        aria-label={t('nav.label')}
        className="sticky top-20 hidden max-h-[calc(100vh-6rem)] w-56 shrink-0 overflow-y-auto md:block"
      >
        <ul className="space-y-1">
          {sections.map((section) => {
            const isActive = active === section.id;
            return (
              <li key={section.id}>
                <Button
                  type="button"
                  variant="ghost"
                  aria-current={isActive ? 'location' : undefined}
                  onClick={() => goToSection(section.id)}
                  className={cn(
                    'min-h-11 w-full justify-start text-left font-normal',
                    isActive && 'bg-muted font-medium text-foreground',
                  )}
                >
                  {t(section.labelKey)}
                </Button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="md:hidden">
        <Label htmlFor={MOBILE_SELECT_ID} className="sr-only">
          {t('nav.jumpTo')}
        </Label>
        <select
          id={MOBILE_SELECT_ID}
          value={selectedId}
          onChange={(event) => goToSection(event.target.value)}
          // I3 (wave B) — this native <select> had no focus-visible ring,
          // unlike every shadcn Input/Button on the page. Matches
          // `ui/input.tsx`'s focus classes exactly.
          className="min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {sections.map((section) => (
            <option key={section.id} value={section.id}>
              {t(section.labelKey)}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
