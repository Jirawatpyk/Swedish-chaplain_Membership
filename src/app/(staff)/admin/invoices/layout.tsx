/**
 * T056 / T056a — /admin/invoices layout.
 *
 * F4 admin surface layout. Reuses F1/F3 staff shell primitives — the
 * <StaffShell> is installed at the /admin layout level, so this F4
 * layout just wraps children in a TableContainer-compatible frame.
 *
 * Accessibility (T056a / FR-042):
 *   - `<main id="main-content">` landmark present via the parent
 *     /admin layout. F4 uses page-level <h1> via PageHeader to name
 *     the region (assistive-tech convention). We keep a generic
 *     aria-label as a fallback for the `<section>` landmark.
 *   - Skip-to-content handled at the root admin layout.
 *
 * Note (2026-04-19): the layout is intentionally SYNCHRONOUS. An
 * earlier async version `await getTranslations` inside the component
 * body — Next.js 16 Cache Components then suspended the LAYOUT
 * boundary, not the page boundary, so `invoices/loading.tsx` never
 * mounted and the parent `/admin/loading.tsx` (dashboard skeleton)
 * was shown during navigation. `generateMetadata` stays async since
 * Metadata resolves in a separate pipeline.
 */
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.invoices');
  return { title: t('meta.title') };
}

export default function AdminInvoicesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <section aria-label="Invoices" className="min-h-full">
      {children}
    </section>
  );
}
