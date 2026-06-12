/**
 * T123 — Persistent banner shown when role==manager.
 *
 * Per FR-014 + Q12: manager has read access to the F7 admin queue +
 * detail surface but cannot approve/reject/cancel. Banner reinforces
 * this expectation upfront so the manager doesn't look for missing
 * action buttons.
 *
 * Server component (no client state); rendered conditionally by the
 * page based on `requireSession.user.role`.
 */
import { Eye } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

export async function ManagerReadonlyBanner(): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.managerReadonlyBanner');
  return (
    <div
      role="region"
      aria-label={t('title')}
      className="flex items-start gap-3 rounded-md border border-info/30 bg-info-surface p-4"
    >
      <Eye
        className="mt-0.5 h-5 w-5 shrink-0 text-info"
        aria-hidden="true"
      />
      <div className="space-y-1">
        {/* D-banner-2 UX hardening — was `<h3>` on the assumption that
            HaltStateBanner's `<h2>` would always render first. But
            HaltStateBanner returns `null` when no halted members exist
            (the common case), creating an h1 → h3 skip. The three
            banners (SLA / Halt / ManagerReadonly) are siblings under
            the page `<h1>`, so each owns an `<h2>`. */}
        <h2 className="text-sm font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('body')}</p>
      </div>
    </div>
  );
}
