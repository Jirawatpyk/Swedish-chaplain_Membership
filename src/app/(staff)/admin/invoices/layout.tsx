/**
 * T056 / T056a — /admin/invoices layout.
 *
 * F4 admin surface layout. Reuses F1/F3 staff shell primitives — the
 * <StaffShell> is installed at the /admin layout level, so this F4
 * layout just wraps children in a TableContainer-compatible frame.
 *
 * Accessibility (T056a / FR-042):
 *   - `<main id="main-content">` landmark present via the parent
 *     /admin layout. F4 adds a local aria-label on its <section> so
 *     screen readers announce "Invoices" when entering the region.
 *   - Skip-to-content handled at the root admin layout.
 */
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.invoices');
  return { title: t('meta.title') };
}

export default async function AdminInvoicesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = await getTranslations('admin.invoices');
  return (
    <section aria-label={t('list.title')} className="min-h-full">
      {children}
    </section>
  );
}
