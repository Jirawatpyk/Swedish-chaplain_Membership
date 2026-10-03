/**
 * G-3 — /admin/credit-notes directory page.
 *
 * Tenant-scoped list of every credit note issued against any of the
 * tenant's invoices. Closes the discoverability gap where admins
 * with a CN document number (e.g. bookkeeper query) had no UI
 * search path — previously only reachable per-invoice.
 *
 * Pattern mirrors the sibling `/admin/invoices` list:
 *   - TableContainer (96rem) per docs/ux-standards.md § 18
 *   - Offset pagination (server-rendered; 50 rows/page)
 *   - Filters: fiscal year (exact) + document-number search
 *     (case-insensitive substring)
 *   - Spec 122 US8c (T844): the view is `renderCreditNotesListView` (AURA
 *     DataTable, cards below 640px; the number opens the detail and a PDF
 *     button downloads), shared with the no-DB preview route
 *
 * RBAC: the page declares `invoicing.read` via `requirePagePermission`, which
 * both admin and manager hold (manager is finance-read per CLAUDE.md and this
 * list is read-only). The pre-016 `admin || manager` arm this replaced was
 * inert — it admitted exactly what the layout already admitted.
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';

import { requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { listCreditNotes, makeListCreditNotesDeps } from '@/modules/invoicing';
import { TableContainer } from '@/components/layout';
import { renderCreditNotesListView } from './_components/credit-notes-list-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.creditNotes.list.meta');
  return { title: t('title') };
}

const PAGE_SIZE = 50;

export default async function AdminCreditNotesDirectoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePagePermission('invoicing.read');
  // Manager is read-only finance — allowed. Member / unauth blocked
  // by requireSession / layout.

  const sp = await searchParams;

  const hdrs = await headers();
  const tenantCtx = resolveTenantFromHeaders(hdrs);

  const qRaw = typeof sp.q === 'string' ? sp.q.trim() : '';
  const fyRaw = typeof sp.fy === 'string' ? Number.parseInt(sp.fy, 10) : NaN;
  const fiscalYear =
    Number.isFinite(fyRaw) && fyRaw >= 2020 && fyRaw <= 2100 ? fyRaw : undefined;
  const hasFilters = qRaw.length > 0 || fiscalYear !== undefined;

  const pageRaw = typeof sp.page === 'string' ? Number.parseInt(sp.page, 10) : 1;
  const page =
    Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 10_000) : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const result = await listCreditNotes(makeListCreditNotesDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    offset,
    pageSize: PAGE_SIZE,
    ...(fiscalYear !== undefined ? { fiscalYear } : {}),
    ...(qRaw.length > 0 ? { search: qRaw } : {}),
  });
  const rows = result.ok ? result.value.rows : [];
  const total = result.ok ? result.value.total : 0;

  return (
    <TableContainer>
      {await renderCreditNotesListView({ rows, total, page, pageSize: PAGE_SIZE, hasFilters })}
    </TableContainer>
  );
}
