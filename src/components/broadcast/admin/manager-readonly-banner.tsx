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
      className="flex items-start gap-3 rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-900/50 dark:bg-blue-950/40"
    >
      <Eye
        className="mt-0.5 h-5 w-5 shrink-0 text-blue-700 dark:text-blue-300"
        aria-hidden="true"
      />
      <div className="space-y-1">
        {/* h3: page-level h1 lives in PageHeader; SLA + halt banners share h2 → manager banner is h3 */}
        <h3 className="text-sm font-semibold">{t('title')}</h3>
        <p className="text-sm text-muted-foreground">{t('body')}</p>
      </div>
    </div>
  );
}
