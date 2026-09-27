import { LocaleSwitcher } from '@/components/shell/locale-switcher';
import { ThemeToggle } from '@/components/shell/theme-toggle';

/**
 * AuthPageControls — top-right control cluster shared by all 7 `(auth-public)`
 * pages. Extracted when the cluster grew from one control (ThemeToggle) to two
 * (LocaleSwitcher + ThemeToggle) so the flex/gap wrapper + order stay
 * consistent across pages instead of drifting 7 ways. The app-shell layouts
 * have different clusters (UserMenu, OutboxHealthBadge, an `sm:contents`
 * wrapper) and inline the controls directly rather than using this slot.
 *
 * Server component — it only composes two client children, so it needs no
 * `'use client'` directive.
 */
export function AuthPageControls() {
  return (
    <header className="absolute top-4 right-4 z-10 lg:top-5 lg:right-6">
      <div className="flex items-center gap-2">
        {/* The auth boards' 40px pill (44px on phones). */}
        <LocaleSwitcher className="h-10 pr-3 pl-4 max-sm:h-11" />
        <ThemeToggle />
      </div>
    </header>
  );
}
