/**
 * #78 (R141) — the dashboard's gate lives in the segment layout.
 *
 * The page renders inside this segment's `loading.tsx` Suspense boundary, so a
 * `notFound()` thrown from the page arrives after the response has started
 * streaming with HTTP 200: a production build with FEATURE_INVOICE_DASHBOARD
 * off answered 200 with the not-found page (relay rev 70). This layout renders
 * outside that boundary, so its `notFound()` still sets 404 — the rollback
 * contract in docs/operational-state.md. The page keeps the same checks as a
 * second wall.
 */
import { notFound } from 'next/navigation';
import { env } from '@/lib/env';
import { canPerform, requirePagePermission } from '@/lib/rbac';

export default async function FinanceLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactNode> {
  const { user } = await requirePagePermission('invoicing.read');
  if (!env.features.invoiceDashboard) notFound();
  if (!canPerform(user.role, 'insights.finance')) notFound();
  return children;
}
