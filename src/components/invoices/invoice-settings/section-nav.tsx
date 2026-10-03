'use client';

/**
 * Spec 122 US8c-2 (T855) — the invoice settings rail on AURA (board
 * `Admin-invoice-settings`, "Settings sections"): ghost Buttons from `lg`, and
 * below it an AURA Select "Jump to section" (a native `<select>` under it).
 * A pick scrolls to the section card and moves focus to it; each card is a
 * `<section tabIndex={-1}>` labelled by its h2, so a screen reader lands on
 * the section's name. The scroll-spy marks the current section.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Select } from '@jirawatpyk/aura-react';
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

export function SectionNav({ sections }: { readonly sections: ReadonlyArray<SectionNavItem> }) {
  const t = useTranslations('admin.invoiceSettings');
  // Stable id list — a fresh array every render would tear down and
  // rebuild useScrollSpy's IntersectionObserver on every render (its
  // effect depends on `[sectionIds]` by reference).
  const sectionIds = useMemo(() => sections.map((section) => section.id), [sections]);
  const { active, setActive } = useScrollSpy(sectionIds);
  const selectedId = active ?? sections[0]?.id ?? '';

  /**
   * Scrolls the target section into view, then moves focus to it (the card
   * is a `<section tabIndex={-1}>` labelled by its h2) so keyboard and
   * screen-reader users land where sighted users land visually.
   *
   * code-review follow-up (finding 5) — moved inside `SectionNav` (from
   * module scope) so it can close over `setActive` and set the target
   * section as `active` OPTIMISTICALLY, the instant the jump is
   * triggered. Without this, `active` (and therefore the mobile
   * `<select>`'s controlled `value`) only updates once the
   * IntersectionObserver fires after the smooth-scroll animation
   * settles — the select visibly snapped back to the previously-active
   * section right after a pick. The scroll-spy then keeps `active`
   * correct as the user continues to scroll. (Re-selecting the
   * already-active option is an inherent native-`<select>` no-op — the
   * browser doesn't fire `onChange` when the value doesn't change — and
   * is acceptable: the user is already at that section.)
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
    section?.focus({ preventScroll: true });
    setActive(id);
  }

  return (
    <>
      <nav
        aria-label={t('nav.label')}
        className="sticky top-20 max-h-[calc(100vh-6rem)] w-56 shrink-0 overflow-y-auto max-lg:hidden"
      >
        <ul className="flex flex-col gap-[var(--aura-space-1)]">
          {sections.map((section) => {
            const isActive = active === section.id;
            return (
              <li key={section.id}>
                <Button
                  type="button"
                  variant="ghost"
                  aria-current={isActive ? 'location' : undefined}
                  onClick={() => goToSection(section.id)}
                  // 088 FR-036 — 44px at every width (the compact staff
                  // density is 36px); the current section on the selected
                  // ground, as AURA's SideNav marks the current page.
                  className={cn(
                    'min-h-11 w-full justify-start text-left font-normal',
                    isActive && 'bg-[var(--aura-bg-selected)] font-medium text-[var(--aura-fg-primary)]',
                  )}
                >
                  {t(section.labelKey)}
                </Button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="lg:hidden">
        <Select
          id={MOBILE_SELECT_ID}
          aria-label={t('nav.jumpTo')}
          value={selectedId}
          onChange={(event) => goToSection(event.target.value)}
          touchHeight="always"
          options={sections.map((section) => ({ value: section.id, label: t(section.labelKey) }))}
        />
      </div>
    </>
  );
}
