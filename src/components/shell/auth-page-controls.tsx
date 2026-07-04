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
    <header className="absolute right-4 top-4 z-10">
      <div className="flex items-center gap-2">
        <LocaleSwitcher />
        <ThemeToggle />
      </div>
    </header>
  );
}
